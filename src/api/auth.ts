import { timingSafeEqual } from 'node:crypto';
import {
  createParamDecorator,
  ForbiddenException,
  Inject,
  Injectable,
  NotFoundException,
  SetMetadata,
  UnauthorizedException,
  type CanActivate,
  type ExecutionContext,
} from '@nestjs/common';
import { Reflector } from '@nestjs/core';
import { AccountsService, SESSION_COOKIE } from '../accounts/accounts.service.js';
import { SIM_CONFIG, type SimConfig } from '../config.js';
import type { ApiKey, Mode, Project, ProjectRole, User } from '../domain.js';
import { isAdminRole, TeamService } from '../accounts/team.js';
import { SimulationService } from '../simulation/simulation.service.js';
import { ActivityLog, NO_AUDIT_KEY, type TrackedRequest, type TrackedResponse } from './activity.js';

/** Header the panel sends with the project it is working on. */
export const PROJECT_HEADER = 'x-relayo-project';
/**
 * Header the panel sends with every state-changing request. Browsers only send custom headers to another
 * origin after a CORS preflight, so a page on another site cannot forge these requests with the cookie.
 */
export const CLIENT_HEADER = 'x-relayo-client';
/** Header the panel sends with the mode it is looking at: `test` (default) or `live`. API keys carry their own. */
export const MODE_HEADER = 'x-relayo-mode';

export interface AuthedRequest {
  method: string;
  ip?: string;
  headers: Record<string, string | string[] | undefined>;
  project?: Project;
  user?: User;
  sessionHash?: string;
  auth?: 'key' | 'session';
  /** Test or live: from the API key, or from the panel's mode header. */
  mode?: Mode;
  /** The signed-in person's role in the project (API keys act with full access). */
  projectRole?: ProjectRole;
  /** The API key the request came with. */
  apiKey?: ApiKey;
}

const SESSION_ONLY = 'relayo:session-only';
/** Marks endpoints that API keys cannot use: managing keys and secrets needs a signed-in person. */
export const SessionOnly = () => SetMetadata(SESSION_ONLY, true);

const SENDS = 'relayo:sends';
/** Marks the send endpoints: the only ones a send-only key may call. */
export const Sends = () => SetMetadata(SENDS, true);

const PROJECT_ADMIN = 'relayo:project-admin';
/** Marks endpoints only the project's owner and admins can use from the panel (session-only ones too). */
export const ProjectAdmin = () => SetMetadata(PROJECT_ADMIN, true);

function header(req: AuthedRequest, name: string): string | undefined {
  const value = req.headers[name];
  return Array.isArray(value) ? value[0] : value;
}

function bearer(req: AuthedRequest): string | undefined {
  const value = header(req, 'authorization');
  return value?.startsWith('Bearer ') ? value.slice(7).trim() : undefined;
}

export function readCookie(req: AuthedRequest, name: string): string | undefined {
  for (const part of (header(req, 'cookie') ?? '').split(';')) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq).trim() === name) return decodeURIComponent(part.slice(eq + 1).trim());
  }
  return undefined;
}

function checkCsrf(req: AuthedRequest): void {
  if (req.method !== 'GET' && req.method !== 'HEAD' && !header(req, CLIENT_HEADER)) {
    throw new ForbiddenException(`Missing ${CLIENT_HEADER} header`);
  }
}

/** Puts the signed-in user on the request, from the session cookie. */
async function authenticateSession(accounts: AccountsService, req: AuthedRequest): Promise<boolean> {
  const found = await accounts.userForSession(readCookie(req, SESSION_COOKIE));
  if (!found) return false;
  req.user = found.user;
  req.sessionHash = found.sessionHash;
  return true;
}

/** Requires a signed-in user (panel session). */
@Injectable()
export class SessionGuard implements CanActivate {
  constructor(@Inject(AccountsService) private readonly accounts: AccountsService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    if (!(await authenticateSession(this.accounts, req))) throw new UnauthorizedException('Sign in first');
    checkCsrf(req);
    req.auth = 'session';
    return true;
  }
}

/**
 * Resolves the project: `Authorization: Bearer <API key>` (API, SMTP clients, the Relayo driver), or the
 * panel's session cookie plus `X-Relayo-Project` with a project the user owns.
 */
@Injectable()
export class ProjectGuard implements CanActivate {
  constructor(
    @Inject(SimulationService) private readonly sim: SimulationService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(Reflector) private readonly reflector: Reflector,
    @Inject(TeamService) private readonly team: TeamService,
    @Inject(ActivityLog) private readonly activity: ActivityLog,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const res = context.switchToHttp().getResponse<TrackedResponse>();
    const targets = [context.getHandler(), context.getClass()];
    const sends = this.reflector.getAllAndOverride<boolean>(SENDS, targets) ?? false;
    const noAudit = this.reflector.getAllAndOverride<boolean>(NO_AUDIT_KEY, targets) ?? false;
    const sessionOnly = this.reflector.getAllAndOverride<boolean>(SESSION_ONLY, targets);
    // Keys, credentials and settings: the owner and admins only.
    const adminOnly = sessionOnly || this.reflector.getAllAndOverride<boolean>(PROJECT_ADMIN, targets);
    const key = bearer(req);

    if (key) {
      if (sessionOnly) throw new ForbiddenException('Sign in to the panel to manage keys and secrets');
      const found = await this.sim.authenticateKey(key);
      if (!found) throw new UnauthorizedException('Missing or invalid API key');
      req.project = found.project;
      req.mode = found.mode;
      req.auth = 'key';
      req.apiKey = found.key;
      // Logged from here on, so the request log also shows what the key was not allowed to do.
      this.activity.track(req as unknown as TrackedRequest, res, { project: found.project, mode: found.mode, key: found.key, sends, noAudit });
      checkKeyPermission(found.key, req, sends);
      return true;
    }

    if (!(await authenticateSession(this.accounts, req))) throw new UnauthorizedException('Missing or invalid API key');
    checkCsrf(req);
    const access = await this.team.access(req.user!, header(req, PROJECT_HEADER));
    if (!access) throw new NotFoundException('Project not found');
    if (adminOnly && !isAdminRole(access.role)) {
      throw new ForbiddenException('Solo los administradores del proyecto pueden hacer esto: pídeselo a quien te invitó.');
    }
    req.project = access.project;
    req.projectRole = access.role;
    req.mode = header(req, MODE_HEADER) === 'live' ? 'live' : 'test';
    req.auth = 'session';
    this.activity.track(req as unknown as TrackedRequest, res, { project: access.project, mode: req.mode, user: req.user!, sends, noAudit });
    return true;
  }
}

/**
 * What a limited key may do: a send key only sends (from its allowed domains, if it has them), a read key
 * only reads (GET). Full keys do everything an API key can.
 */
function checkKeyPermission(key: ApiKey, req: AuthedRequest & { body?: unknown }, sends: boolean): void {
  const permission = key.permission ?? 'full';
  if (permission === 'read' && req.method !== 'GET') throw new ForbiddenException('This key can only read: use a key with send or full permission');
  if (permission === 'send') {
    if (!sends) throw new ForbiddenException('This key can only send messages');
    if (key.allowedDomains?.length) {
      const from = (req.body as { from?: unknown } | undefined)?.from;
      const address = typeof from === 'string' ? from : (from as { address?: unknown } | undefined)?.address;
      // SMS have no sender domain: only emails are checked.
      if (address !== undefined && !senderAllowed(key, String(address))) {
        throw new ForbiddenException(`This key can only send from ${key.allowedDomains.join(', ')}`);
      }
    }
  }
}

/** Whether a key may send from an address: any, or one of its domains (and their subdomains). */
export function senderAllowed(key: ApiKey, address: string): boolean {
  if (!key.allowedDomains?.length) return true;
  const domain = address.split('@').pop()!.toLowerCase();
  return key.allowedDomains.some((d) => domain === d || domain.endsWith(`.${d}`));
}

/** Requires `Authorization: Bearer <ADMIN_TOKEN>`. */
@Injectable()
export class AdminGuard implements CanActivate {
  constructor(@Inject(SIM_CONFIG) private readonly config: SimConfig) {}

  canActivate(context: ExecutionContext): boolean {
    const given = Buffer.from(bearer(context.switchToHttp().getRequest<AuthedRequest>()) ?? '');
    const expected = Buffer.from(this.config.adminToken ?? '');
    if (!this.config.adminToken || given.length !== expected.length || !timingSafeEqual(given, expected)) {
      throw new UnauthorizedException('Admin token required');
    }
    return true;
  }
}

/** Platform admins: a verified user listed in ADMIN_EMAILS, or the admin token (scripts). */
@Injectable()
export class PlatformAdminGuard implements CanActivate {
  constructor(
    @Inject(SIM_CONFIG) private readonly config: SimConfig,
    @Inject(AccountsService) private readonly accounts: AccountsService,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<AuthedRequest>();
    const given = Buffer.from(bearer(req) ?? '');
    const expected = Buffer.from(this.config.adminToken ?? '');
    if (this.config.adminToken && given.length === expected.length && timingSafeEqual(given, expected)) return true;
    if (!(await authenticateSession(this.accounts, req))) throw new UnauthorizedException('Sign in first');
    checkCsrf(req);
    if (!this.accounts.isAdmin(req.user!)) throw new ForbiddenException('Solo para administradores de la plataforma');
    return true;
  }
}

export const CurrentProject = createParamDecorator(
  (_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<AuthedRequest>().project!,
);

export const CurrentUser = createParamDecorator(
  (_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<AuthedRequest>().user!,
);

export const SessionHash = createParamDecorator(
  (_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<AuthedRequest>().sessionHash!,
);

/** The mode of the request: test (simulated) or live (real delivery). */
/** The signed-in person's role in the project; `owner` for API keys, which act with full access. */
export const CurrentRole = createParamDecorator(
  (_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<AuthedRequest>().projectRole ?? 'owner',
);

/** The API key of the request; none for the panel. */
export const CurrentKey = createParamDecorator(
  (_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<AuthedRequest>().apiKey,
);

export const CurrentMode = createParamDecorator(
  (_: unknown, context: ExecutionContext) => context.switchToHttp().getRequest<AuthedRequest>().mode ?? 'test',
);
