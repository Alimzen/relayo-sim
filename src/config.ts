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
  tls?: { key: string; cert: string };
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
  };
  if (env.SMTP_PORT !== 'off') config.smtpPort = number(env.SMTP_PORT, 2525);
  if (env.DATABASE_URL) config.databaseUrl = env.DATABASE_URL;
  if (env.REDIS_URL) config.redisUrl = env.REDIS_URL;
  if (env.ADMIN_TOKEN) config.adminToken = env.ADMIN_TOKEN;
  if (env.TLS_KEY && env.TLS_CERT) config.tls = { key: env.TLS_KEY, cert: env.TLS_CERT };
  return config;
}
