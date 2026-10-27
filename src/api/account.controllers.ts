import {
  Body,
  Controller,
  Delete,
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
import { AccountError, AccountsService, SESSION_COOKIE, SESSION_DAYS, MIN_PASSWORD } from '../accounts/accounts.service.js';
import { SIM_CONFIG, type SimConfig } from '../config.js';
import { TeamService } from '../accounts/team.js';
import { exportAccount } from '../accounts/export.js';
import { LiveService } from '../live/live.service.js';
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

/** The projects a user owns or was invited to, each with their role. */
async function projectsOf(store: SimStore, user: User) {
  return (await store.listProjectsFor(user.id)).map(({ project, role }) => publicProject(project, role));
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
    @Inject(TeamService) private readonly team: TeamService,
    @Inject(LiveService) private readonly live: LiveService,
  ) {}

  /** What the sign-in page needs to know before anyone is signed in. */
  @Get('config')
  config_() {
    return {
      signup: this.accounts.signupOpen,
      minPassword: MIN_PASSWORD,
      termsUrl: this.config.legal?.termsUrl ?? null,
      privacyUrl: this.config.legal?.privacyUrl ?? null,
    };
  }

  @Post('signup')
  async signup(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>, @Res({ passthrough: true }) res: CookieResponse) {
    requireClientHeader(req);
    const invited = await this.team.invitedEmail(body?.invite, body?.email);
    const { user, token, project } = await run(() => this.accounts.signup(body ?? {}, invited));
    res.setHeader('Set-Cookie', sessionCookie(token, this.config.secureCookies));
    return { user: this.accounts.present(user), projects: [publicProject(project, 'owner')] };
  }

  @Post('login')
  @HttpCode(200)
  async login(@Req() req: AuthedRequest, @Body() body: Record<string, unknown>, @Res({ passthrough: true }) res: CookieResponse) {
    requireClientHeader(req);
    const result = await run(() => this.accounts.login(body ?? {}, req.ip ?? 'unknown'));
    // Two-factor on: no session until the code (POST /v1/auth/login/2fa with the ticket).
    if ('ticket' in result) return { twoFactor: true, ticket: result.ticket };
    res.setHeader('Set-Cookie', sessionCookie(result.token, this.config.secureCookies));
    return { user: this.accounts.present(result.user), projects: await projectsOf(this.store, result.user) };
  }

  /** The second step of a sign-in with two-factor: the ticket from the first step and the code. */
  @Post('login/2fa')
  @HttpCode(200)
  async login2fa(@Req() req: AuthedRequest, @Body() body: { ticket?: unknown; code?: unknown }, @Res({ passthrough: true }) res: CookieResponse) {
    requireClientHeader(req);
    const { user, token } = await run(() => this.accounts.completeLogin(body ?? {}, req.ip ?? 'unknown'));
    res.setHeader('Set-Cookie', sessionCookie(token, this.config.secureCookies));
    return { user: this.accounts.present(user), projects: await projectsOf(this.store, user) };
  }

  /** Starts setting up two-factor: the secret and the link for the QR code. */
  @Post('2fa/setup')
  @UseGuards(SessionGuard)
  async setup2fa(@CurrentUser() user: User) {
    return run(() => this.accounts.setupTwoFactor(user));
  }

  /** Turns two-factor on with a first code; answers the recovery codes, shown only once. */
  @Post('2fa/enable')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async enable2fa(@CurrentUser() user: User, @Body() body: { code?: unknown }) {
    return { recoveryCodes: await run(() => this.accounts.enableTwoFactor(user, body ?? {})) };
  }

  @Post('2fa/disable')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async disable2fa(@CurrentUser() user: User, @Body() body: { password?: unknown; code?: unknown }) {
    await run(() => this.accounts.disableTwoFactor(user, body ?? {}));
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
    return { user: this.accounts.present(user), projects: await projectsOf(this.store, user) };
  }

  @Patch('me')
  @UseGuards(SessionGuard)
  async updateMe(@CurrentUser() user: User, @Body() body: { name?: unknown }) {
    return { user: this.accounts.present(await run(() => this.accounts.updateProfile(user, body ?? {}))) };
  }

  /** Confirms the email with the token from the verification link. */
  @Post('verify')
  @HttpCode(200)
  async verify(@Req() req: AuthedRequest, @Body() body: { token?: unknown }) {
    requireClientHeader(req);
    return { user: this.accounts.present(await run(() => this.accounts.verifyEmail(body ?? {}))) };
  }

  /** Sends the verification link again. */
  @Post('verify/resend')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async resendVerification(@CurrentUser() user: User) {
    await run(() => this.accounts.sendVerification(user));
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
    return { user: this.accounts.present(user), projects: await projectsOf(this.store, user) };
  }

  /** Everything kept about the account, as a JSON download (data portability). */
  @Get('me/export')
  @UseGuards(SessionGuard)
  async export(@CurrentUser() user: User, @Res({ passthrough: true }) res: CookieResponse) {
    res.setHeader('Content-Disposition', `attachment; filename="relayo-${user.id}.json"`);
    return exportAccount(this.store, this.live, user);
  }

  /** Deletes the account, with the projects it owns, and signs out. Needs the password. */
  @Delete('me')
  @HttpCode(204)
  @UseGuards(SessionGuard)
  async deleteMe(@CurrentUser() user: User, @Body() body: { password?: unknown }, @Res({ passthrough: true }) res: CookieResponse) {
    await run(() => this.accounts.deleteAccount(user, body ?? {}));
    res.setHeader('Set-Cookie', sessionCookie('', this.config.secureCookies, 0));
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
    return { data: await projectsOf(this.store, user) };
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
    return publicProject((await this.store.getProject(project.id))!, 'owner');
  }

  /** Creates a project with a first API key, shown only in this response. */
  @Post()
  async create(@CurrentUser() user: User, @Body() body: { name?: unknown }) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 80) throw new BadRequestException('El nombre del proyecto debe tener entre 1 y 80 caracteres.');
    const { project, apiKey } = await this.sim.createProject(name, { ownerId: user.id });
    return { ...publicProject(project, 'owner'), apiKey };
  }
}
