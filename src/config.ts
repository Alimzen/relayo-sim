export interface SimConfig {
  /** HTTP API port. */
  httpPort: number;
  /** SMTP port; `undefined` disables the SMTP server. */
  smtpPort?: number;
  host: string;
  /** PostgreSQL connection string. Without it, data lives in memory. */
  databaseUrl?: string;
  /** Redis connection string for BullMQ. Without it, timelines and webhooks run on in-process timers. */
  redisUrl?: string;
  /** Token for admin endpoints (creating projects). Without it they are disabled. */
  adminToken?: string;
  timeScale: number;
  maxHangMs: number;
  /** Whether anyone can create an account in the panel. */
  signup: boolean;
  /** Mark the session cookie `Secure` (HTTPS only). On in production. */
  secureCookies: boolean;
  /** STARTTLS for SMTP: PEM contents, or paths to PEM files re-read periodically (certificates that renew). */
  tls?: { key: string; cert: string } | { keyFile: string; certFile: string };
  /** Days messages are kept; older ones are deleted. 0 keeps them forever. */
  retentionDays?: number;
  /** Per project. 0 means no limit. */
  limits?: { monthlyMessages: number; messagesPerMinute: number };
  /** Public address of the panel, for links in emails (password reset). */
  publicUrl?: string;
  /** How the simulator sends its own email (password reset). Without it, links are logged instead. */
  mail?: { url: string; from: string };
  /**
   * Key that encrypts provider credentials (live mode). Required in production; development falls back to a
   * fixed, insecure key so live mode can be tried locally.
   */
  secretsKey?: string;
}

export const SIM_CONFIG = Symbol.for('relayo-sim:config');

export function configFromEnv(env: NodeJS.ProcessEnv = process.env): SimConfig {
  const number = (value: string | undefined, fallback: number) => (value === undefined || value === '' ? fallback : Number(value));
  const config: SimConfig = {
    httpPort: number(env.PORT, 3000),
    host: env.HOST ?? '0.0.0.0',
    timeScale: number(env.TIME_SCALE, 1),
    maxHangMs: number(env.SMTP_MAX_HANG_MS, 120_000),
    signup: env.SIGNUP !== 'closed',
    secureCookies: env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && env.NODE_ENV === 'production'),
    retentionDays: number(env.RETENTION_DAYS, 7),
    limits: { monthlyMessages: number(env.MONTHLY_MESSAGE_LIMIT, 0), messagesPerMinute: number(env.MESSAGES_PER_MINUTE, 0) },
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${number(env.PORT, 3000)}`).replace(/\/+$/, ''),
  };
  if (env.SECRETS_KEY) config.secretsKey = env.SECRETS_KEY;
  else if (env.NODE_ENV !== 'production') config.secretsKey = 'relayo-development-only-insecure-key';
  if (env.MAIL_URL) config.mail = { url: env.MAIL_URL, from: env.MAIL_FROM ?? 'Relayo Sim <no-reply@localhost>' };
  if (env.SMTP_PORT !== 'off') config.smtpPort = number(env.SMTP_PORT, 2525);
  if (env.DATABASE_URL) config.databaseUrl = env.DATABASE_URL;
  if (env.REDIS_URL) config.redisUrl = env.REDIS_URL;
  if (env.ADMIN_TOKEN) config.adminToken = env.ADMIN_TOKEN;
  if (env.TLS_KEY && env.TLS_CERT) config.tls = { key: env.TLS_KEY, cert: env.TLS_CERT };
  else if (env.TLS_KEY_FILE && env.TLS_CERT_FILE) config.tls = { keyFile: env.TLS_KEY_FILE, certFile: env.TLS_CERT_FILE };
  return config;
}
