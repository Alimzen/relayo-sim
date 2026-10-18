import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Project, User } from '../domain.js';
import type { SimulationService } from '../simulation/simulation.service.js';
import type { SimStore } from '../store/store.js';
import { hashPassword, verifyPassword } from './password.js';

export const SESSION_COOKIE = 'relayo_session';
export const SESSION_DAYS = 30;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export const MIN_PASSWORD = 10;

export class AccountError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 401 | 403 | 409 | 429,
  ) {
    super(message);
  }
}

export interface PublicUser {
  id: string;
  email: string;
  name: string;
  createdAt: Date;
}

export const publicUser = ({ id, email, name, createdAt }: User): PublicUser => ({ id, email, name, createdAt });

/**
 * Counts failed logins to slow down password guessing: per account (10 in 15 minutes) and per IP, with a
 * higher limit (50) because offices and VPNs put many people behind one address.
 */
class LoginLimiter {
  private readonly failures = new Map<string, number[]>();
  private readonly windowMs = 15 * 60_000;

  private limit(key: string): number {
    return key.startsWith('ip:') ? 50 : 10;
  }

  check(...keys: string[]): void {
    const now = Date.now();
    for (const key of keys) {
      const recent = (this.failures.get(key) ?? []).filter((t) => now - t < this.windowMs);
      this.failures.set(key, recent);
      if (recent.length >= this.limit(key)) throw new AccountError('Demasiados intentos. Espera unos minutos.', 429);
    }
  }

  fail(...keys: string[]): void {
    for (const key of keys) this.failures.set(key, [...(this.failures.get(key) ?? []), Date.now()]);
  }

  reset(...keys: string[]): void {
    for (const key of keys) this.failures.delete(key);
  }
}

export interface AccountsOptions {
  /** Whether anyone can create an account. Default true. */
  signup?: boolean;
}

/** Users, passwords and browser sessions for the panel. API keys keep working for the API and SMTP. */
export class AccountsService {
  private readonly limiter = new LoginLimiter();

  constructor(
    private readonly store: SimStore,
    private readonly sim: SimulationService,
    private readonly options: AccountsOptions = {},
  ) {}

  get signupOpen(): boolean {
    return this.options.signup ?? true;
  }

  /** Creates the account with a first project, and signs it in. */
  async signup(input: { email?: unknown; name?: unknown; password?: unknown }): Promise<{ user: User; token: string; project: Project }> {
    if (!this.signupOpen) throw new AccountError('El registro está cerrado.', 403);
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    const password = typeof input.password === 'string' ? input.password : '';
    if (!EMAIL.test(email)) throw new AccountError('Introduce un email válido.', 400);
    if (!name) throw new AccountError('Introduce tu nombre.', 400);
    checkPassword(password);
    if (await this.store.findUserByEmail(email)) throw new AccountError('Ya existe una cuenta con ese email.', 409);

    const user: User = { id: `usr_${randomUUID()}`, email, name, passwordHash: await hashPassword(password), createdAt: new Date() };
    await this.store.createUser(user);
    const { project } = await this.sim.createProject('Mi primer proyecto', { ownerId: user.id });
    return { user, project, token: await this.startSession(user.id) };
  }

  async login(input: { email?: unknown; password?: unknown }, ip: string): Promise<{ user: User; token: string }> {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const password = typeof input.password === 'string' ? input.password : '';
    const keys = [`email:${email}`, `ip:${ip}`];
    this.limiter.check(...keys);
    const user = email ? await this.store.findUserByEmail(email) : undefined;
    // Same work and same answer whether the email exists or not.
    const valid = await verifyPassword(password, user?.passwordHash ?? DUMMY_HASH);
    if (!user || !valid) {
      this.limiter.fail(...keys);
      throw new AccountError('Email o contraseña incorrectos.', 401);
    }
    this.limiter.reset(`email:${email}`);
    return { user, token: await this.startSession(user.id) };
  }

  /** The signed-in user for a session cookie value. */
  async userForSession(token: string | undefined): Promise<{ user: User; sessionHash: string } | undefined> {
    if (!token) return undefined;
    const sessionHash = hashToken(token);
    const session = await this.store.getSession(sessionHash);
    const user = session && (await this.store.getUser(session.userId));
    return user ? { user, sessionHash } : undefined;
  }

  async logout(token: string | undefined): Promise<void> {
    if (token) await this.store.deleteSession(hashToken(token));
  }

  async updateProfile(user: User, input: { name?: unknown }): Promise<User> {
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (!name) throw new AccountError('Introduce tu nombre.', 400);
    await this.store.updateUser(user.id, { name });
    return { ...user, name };
  }

  /** Changes the password and signs out every other session. */
  async changePassword(user: User, sessionHash: string, input: { current?: unknown; next?: unknown }): Promise<void> {
    const current = typeof input.current === 'string' ? input.current : '';
    const next = typeof input.next === 'string' ? input.next : '';
    if (!(await verifyPassword(current, user.passwordHash))) throw new AccountError('La contraseña actual no es correcta.', 400);
    checkPassword(next);
    await this.store.updateUser(user.id, { passwordHash: await hashPassword(next) });
    await this.store.deleteUserSessions(user.id, sessionHash);
  }

  /** The user's project with this id, if they own it. */
  async ownedProject(user: User, projectId: string | undefined): Promise<Project | undefined> {
    if (!projectId) return undefined;
    const project = await this.store.getProject(projectId);
    return project?.ownerId === user.id ? project : undefined;
  }

  private async startSession(userId: string): Promise<string> {
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    await this.store.createSession({
      idHash: hashToken(token),
      userId,
      createdAt: now,
      expiresAt: new Date(now.getTime() + SESSION_DAYS * 86_400_000),
    });
    return token;
  }
}

function checkPassword(password: string): void {
  if (password.length < MIN_PASSWORD) throw new AccountError(`La contraseña debe tener al menos ${MIN_PASSWORD} caracteres.`, 400);
  if (password.length > 256) throw new AccountError('La contraseña es demasiado larga.', 400);
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A valid hash of a random password, so failed lookups cost as much as real checks. */
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==';
