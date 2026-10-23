import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { Project, User } from '../domain.js';
import type { SimulationService } from '../simulation/simulation.service.js';
import type { SimStore } from '../store/store.js';
import { LogMailer, type Mailer, type MailToSend } from './mailer.js';
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
  emailVerified: boolean;
  admin: boolean;
  createdAt: Date;
}

export const publicUser = ({ id, email, name, createdAt, emailVerifiedAt }: User, admin = false): PublicUser => ({
  id,
  email,
  name,
  emailVerified: !!emailVerifiedAt,
  admin,
  createdAt,
});

/**
 * Counts attempts in a time window, per account and per IP. Logins: 10 failures per account and 50 per IP
 * (offices and VPNs put many people behind one address) in 15 minutes, to slow down password guessing.
 */
class AttemptLimiter {
  private readonly failures = new Map<string, number[]>();

  constructor(
    private readonly perAccount = 10,
    private readonly perIp = 50,
    private readonly windowMs = 15 * 60_000,
  ) {}

  private limit(key: string): number {
    return key.startsWith('ip:') ? this.perIp : this.perAccount;
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
  /** Sends password reset emails. Default: the log. */
  mailer?: Mailer;
  /** Public address of the panel, for the link in reset emails. */
  publicUrl?: string;
  /** New accounts must verify their email before using live mode. Only makes sense with a real mailer. */
  requireVerification?: boolean;
  /** Emails of the platform's admins (review of Relayo's own sending). */
  adminEmails?: string[];
}

export const RESET_MINUTES = 60;
export const VERIFY_HOURS = 24;

/** Users, passwords and browser sessions for the panel. API keys keep working for the API and SMTP. */
export class AccountsService {
  private readonly limiter = new AttemptLimiter();
  /** Reset emails: 3 per account and 20 per IP an hour, so the form cannot be used to flood someone's inbox. */
  private readonly resetLimiter = new AttemptLimiter(3, 20, 60 * 60_000);
  /** Verification emails: 3 an hour per account. */
  private readonly verifyLimiter = new AttemptLimiter(3, 3, 60 * 60_000);
  private readonly mailer: Mailer;



  constructor(
    private readonly store: SimStore,
    private readonly sim: SimulationService,
    private readonly options: AccountsOptions = {},
  ) {
    this.mailer = options.mailer ?? new LogMailer();
  }

  get signupOpen(): boolean {
    return this.options.signup ?? true;
  }

  /** Whether new accounts must verify their email; without it they start verified. */
  get verificationRequired(): boolean {
    return this.options.requireVerification ?? false;
  }

  isAdmin(user: User): boolean {
    return !!user.emailVerifiedAt && (this.options.adminEmails ?? []).includes(user.email.toLowerCase());
  }

  /** The user as the panel sees it. */
  present(user: User): PublicUser {
    return publicUser(user, this.isAdmin(user));
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

    const now = new Date();
    const user: User = {
      id: `usr_${randomUUID()}`,
      email,
      name,
      passwordHash: await hashPassword(password),
      createdAt: now,
      ...(!this.verificationRequired && { emailVerifiedAt: now }),
    };
    await this.store.createUser(user);
    const { project } = await this.sim.createProject('Mi primer proyecto', { ownerId: user.id });
    // The account works without it (test mode); a mail failure must not fail the sign-up.
    if (this.verificationRequired) await this.sendVerification(user).catch(() => undefined);
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

  /**
   * Emails a single-use link to set a new password. Answers the same whether the account exists or not, so
   * the form cannot be used to find out who has an account.
   */
  async requestPasswordReset(input: { email?: unknown }, ip: string): Promise<void> {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) throw new AccountError('Introduce un email válido.', 400);
    const keys = [`email:${email}`, `ip:${ip}`];
    this.resetLimiter.check(...keys);
    this.resetLimiter.fail(...keys);

    const user = await this.store.findUserByEmail(email);
    if (!user) return;
    const token = randomBytes(32).toString('base64url');
    await this.store.createPasswordReset({
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + RESET_MINUTES * 60_000),
    });
    const link = `${this.options.publicUrl ?? ''}/reset-password?token=${token}`;
    await this.mailer.send(resetEmail(user, link));
  }

  /** Sets a new password with a reset token, signs out every session and signs in this one. */
  async resetPassword(input: { token?: unknown; password?: unknown }): Promise<{ user: User; token: string }> {
    const token = typeof input.token === 'string' ? input.token : '';
    const password = typeof input.password === 'string' ? input.password : '';
    // Check the password first: a weak one should not use up the link.
    checkPassword(password);
    const userId = token ? await this.store.usePasswordReset(hashToken(token)) : undefined;
    const user = userId && (await this.store.getUser(userId));
    if (!user) throw new AccountError('El enlace no es válido o ha caducado. Pide uno nuevo.', 400);
    await this.store.updateUser(user.id, { passwordHash: await hashPassword(password) });
    await this.store.deleteUserSessions(user.id);
    this.limiter.reset(`email:${user.email}`);
    return { user, token: await this.startSession(user.id) };
  }

  /** Emails a link that proves the address is the user's. */
  async sendVerification(user: User): Promise<void> {
    if (user.emailVerifiedAt) return;
    this.verifyLimiter.check(`email:${user.email}`);
    this.verifyLimiter.fail(`email:${user.email}`);
    const token = randomBytes(32).toString('base64url');
    await this.store.createPasswordReset({
      tokenHash: hashToken(token),
      userId: user.id,
      expiresAt: new Date(Date.now() + VERIFY_HOURS * 3_600_000),
      purpose: 'verify',
    });
    await this.mailer.send(verifyEmail(user, `${this.options.publicUrl ?? ''}/verify-email?token=${token}`));
  }

  /** Marks the email of the token's user as verified. */
  async verifyEmail(input: { token?: unknown }): Promise<User> {
    const token = typeof input.token === 'string' ? input.token : '';
    const userId = token ? await this.store.usePasswordReset(hashToken(token), 'verify') : undefined;
    const user = userId && (await this.store.getUser(userId));
    if (!user) throw new AccountError('El enlace no es válido o ha caducado. Pide uno nuevo desde el panel.', 400);
    const verified = user.emailVerifiedAt ?? new Date();
    await this.store.updateUser(user.id, { emailVerifiedAt: verified });
    return { ...user, emailVerifiedAt: verified };
  }

  /** Tells a project's owner the answer to their request for Relayo's own sending. */
  async notifyManagedDecision(user: User, project: Project, decision: 'approved' | 'denied'): Promise<void> {
    const link = `${this.options.publicUrl ?? ''}/domains`;
    const approved = decision === 'approved';
    const lines = approved
      ? [
          `El envío de Relayo está aprobado para tu proyecto «${project.name}».`,
          'Verifica el dominio de tu remitente y actívalo en Conexiones (proveedor «Envío de Relayo»):',
        ]
      : [
          `Hemos revisado tu solicitud del envío de Relayo para el proyecto «${project.name}» y no podemos activarlo.`,
          'Puedes seguir enviando en vivo con tu propio proveedor desde Conexiones:',
        ];
    const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
    await this.mailer.send({
      to: user.email,
      subject: approved ? 'Envío de Relayo aprobado' : 'Tu solicitud del envío de Relayo',
      text: [`Hola, ${user.name}:`, '', ...lines, '', link].join('\n'),
      html: `<div style="font-family:system-ui,sans-serif;max-width:480px;color:#18181b;line-height:1.5">
<p>Hola, ${escape(user.name)}:</p>
${lines.map((l) => `<p>${escape(l)}</p>`).join('\n')}
<p><a href="${escape(link)}" style="display:inline-block;background:#18181b;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Abrir el panel</a></p>
</div>`,
    });
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

function resetEmail(user: User, link: string): MailToSend {
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return {
    to: user.email,
    subject: 'Restablece tu contraseña de Relayo Sim',
    text: [
      `Hola, ${user.name}:`,
      '',
      'Alguien (esperamos que tú) pidió restablecer la contraseña de tu cuenta de Relayo Sim. Ábrelo aquí:',
      '',
      link,
      '',
      `El enlace sirve una sola vez y caduca en ${RESET_MINUTES} minutos. Si no lo pediste, ignora este correo: tu contraseña no cambia.`,
    ].join('\n'),
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;color:#18181b;line-height:1.5">
<p>Hola, ${escape(user.name)}:</p>
<p>Alguien (esperamos que tú) pidió restablecer la contraseña de tu cuenta de Relayo Sim.</p>
<p><a href="${escape(link)}" style="display:inline-block;background:#18181b;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Elegir una contraseña nueva</a></p>
<p style="color:#71717a;font-size:13px">El enlace sirve una sola vez y caduca en ${RESET_MINUTES} minutos. Si no lo pediste, ignora este correo: tu contraseña no cambia.</p>
</div>`,
  };
}

function verifyEmail(user: User, link: string): MailToSend {
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  return {
    to: user.email,
    subject: 'Confirma tu email en Relayo',
    text: [
      `Hola, ${user.name}:`,
      '',
      'Confirma que este email es tuyo para usar el modo en vivo de Relayo (envíos reales):',
      '',
      link,
      '',
      `El enlace caduca en ${VERIFY_HOURS} horas. Si no creaste una cuenta en Relayo, ignora este correo.`,
    ].join('\n'),
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;color:#18181b;line-height:1.5">
<p>Hola, ${escape(user.name)}:</p>
<p>Confirma que este email es tuyo para usar el modo en vivo de Relayo (envíos reales).</p>
<p><a href="${escape(link)}" style="display:inline-block;background:#18181b;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Confirmar email</a></p>
<p style="color:#71717a;font-size:13px">El enlace caduca en ${VERIFY_HOURS} horas. Si no creaste una cuenta en Relayo, ignora este correo.</p>
</div>`,
  };
}

export function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

/** A valid hash of a random password, so failed lookups cost as much as real checks. */
const DUMMY_HASH = 'scrypt$16384$8$1$AAAAAAAAAAAAAAAAAAAAAA==$' + 'A'.repeat(86) + '==';
