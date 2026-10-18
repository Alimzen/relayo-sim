import {
  Body,
  Controller,
  Get,
  HttpCode,
  HttpException,
  Inject,
  Patch,
  Post,
  Req,
  Res,
  UseGuards,
  BadRequestException,
} from '@nestjs/common';
import { AccountError, AccountsService, publicUser, SESSION_COOKIE, SESSION_DAYS, MIN_PASSWORD } from '../accounts/accounts.service.js';
import { SIM_CONFIG, type SimConfig } from '../config.js';
import type { User } from '../domain.js';
import { SimulationService } from '../simulation/simulation.service.js';
import { SIM_STORE, type SimStore } from '../store/store.js';
import { CLIENT_HEADER, CurrentUser, readCookie, SessionGuard, SessionHash, type AuthedRequest } from './auth.js';
import { publicProject } from './present.js';

interface CookieResponse {
  setHeader(name: string, value: string): void;
}

function sessionCookie(token: string, secure: boolean, maxAgeSeconds = SESSION_DAYS * 86_400): string {
  return [
    `${SESSION_COOKIE}=${encodeURIComponent(token)}`,
    'Path=/',
    'HttpOnly',
    'SameSite=Lax',
    `Max-Age=${maxAgeSeconds}`,
    ...(secure ? ['Secure'] : []),
  ].join('; ');
}

/** Maps account errors to HTTP answers with their (Spanish, user-facing) message. */
async function run<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof AccountError) throw new HttpException({ statusCode: error.status, message: error.message }, error.status);
    throw error;
  }
}

function requireClientHeader(req: AuthedRequest): void {
  if (!req.headers[CLIENT_HEADER]) throw new HttpException(`Missing ${CLIENT_HEADER} header`, 403);
}

@Controller('v1/auth')
export class AuthController {
  constructor(
    @Inject(AccountsService) private readonly accounts: AccountsService,
    @Inject(SIM_STORE) private readonly store: SimStore,
    @Inject(SIM_CONFIG) private readonly config: SimConfig,
  ) {}

  /** What the sign-in page needs to know before anyone is signed in. */
  @Get('config')
  config_() {
    return { signup: this.accounts.signupOpen, minPassword: MIN_PASSWORD };
  }

  @Post('signup')
  async signup(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>, @Res({ passthrough: true }) res: CookieResponse) {
    requireClientHeader(req);
    const { user, token, project } = await run(() => this.accounts.signup(body ?? {}));
    res.setHeader('Set-Cookie', sessionCookie(token, this.config.secureCookies));
    return { user: publicUser(user), projects: [publicProject(project)] };
  }

  @Post('login')
  @HttpCode(200)
  async login(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>, @Res({ passthrough: true }) res: CookieResponse) {
    requireClientHeader(req);
    const { user, token } = await run(() => this.accounts.login(body ?? {}, req.ip ?? 'unknown'));
    res.setHeader('Set-Cookie', sessionCookie(token, this.config.secureCookies));
    return { user: publicUser(user), projects: (await this.store.listProjects(user.id)).map(publicProject) };
  }

  @Post('logout')
  @HttpCode(204)
  async logout(@Req() req: AuthedRequest, @Res({ passthrough: true }) res: CookieResponse) {
    requireClientHeader(req);
    await this.accounts.logout(readCookie(req, SESSION_COOKIE));
    res.setHeader('Set-Cookie', sessionCookie('', this.config.secureCookies, 0));
  }

  @Get('me')
  @UseGuards(SessionGuard)
  async me(@CurrentUser() user: User) {
    return { user: publicUser(user), projects: (await this.store.listProjects(user.id)).map(publicProject) };
  }

  @Patch('me')
  @UseGuards(SessionGuard)
  async updateMe(@CurrentUser() user: User, @Body() body: { name?: unknown }) {
    return { user: publicUser(await run(() => this.accounts.updateProfile(user, body ?? {}))) };
  }

  /** Emails a reset link. Always 204, whether the account exists or not. */
  @Post('forgot')
  @HttpCode(204)
  async forgot(@Req() req: AuthedRequest, @Body() body: { email?: unknown }) {
    requireClientHeader(req);
    await run(() => this.accounts.requestPasswordReset(body ?? {}, req.ip ?? 'unknown'));
  }

  /** Sets a new password with the emailed token and signs in. */
  @Post('reset')
  @HttpCode(200)
  async reset(@Req() req: AuthedRequest, @Body() body: { token?: unknown; password?: unknown }, @Res({ passthrough: true }) res: CookieResponse) {
    requireClientHeader(req);
    const { user, token } = await run(() => this.accounts.resetPassword(body ?? {}));
    res.setHeader('Set-Cookie', sessionCookie(token, this.config.secureCookies));
    return { user: publicUser(user), projects: (await this.store.listProjects(user.id)).map(publicProject) };
  }

  /** Changes the password; every other session is signed out. */
  @Post('password')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async password(@CurrentUser() user: User, @SessionHash() sessionHash: string, @Body() body: { current?: unknown; next?: unknown }) {
    await run(() => this.accounts.changePassword(user, sessionHash, body ?? {}));
  }
}

/** The signed-in user's projects. */
@Controller('v1/projects')
@UseGuards(SessionGuard)
export class ProjectsController {
  constructor(
    @Inject(SimulationService) private readonly sim: SimulationService,
    @Inject(SIM_STORE) private readonly store: SimStore,
  ) {}

  @Get()
  async list(@CurrentUser() user: User) {
    return { data: (await this.store.listProjects(user.id)).map(publicProject) };
  }

  /**
   * Adds a project created before accounts existed (or with the admin token) to this account, proving
   * access with one of its API keys. Projects that already have an owner cannot be claimed.
   */
  @Post('claim')
  async claim(@CurrentUser() user: User, @Body() body: { apiKey?: unknown }) {
    const project = typeof body?.apiKey === 'string' ? await this.sim.authenticate(body.apiKey.trim()) : undefined;
    if (!project) throw new BadRequestException('La API key no es válida.');
    if (project.ownerId && project.ownerId !== user.id) throw new BadRequestException('Ese proyecto ya pertenece a otra cuenta.');
    await this.store.updateProject(project.id, { ownerId: user.id });
    return publicProject((await this.store.getProject(project.id))!);
  }

  /** Creates a project with a first API key, shown only in this response. */
  @Post()
  async create(@CurrentUser() user: User, @Body() body: { name?: unknown }) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80) throw new BadRequestException('El nombre del proyecto debe tener entre 1 y 80 caracteres.');
    const { project, apiKey } = await this.sim.createProject(name, { ownerId: user.id });
    return { ...publicProject(project), apiKey };
  }
}
