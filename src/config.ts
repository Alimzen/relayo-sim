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
  /** Users who review requests for Relayo's own sending (verified emails, lowercased). */
  adminEmails?: string[];
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
  /** Per project. 0 means no limit. Live (real) messages have their own monthly limit. */
  limits?: { monthlyMessages: number; messagesPerMinute: number; liveMonthlyMessages?: number };
  /** Public address of the panel, for links in emails (password reset). */
  publicUrl?: string;
  /** How the simulator sends its own email (password reset). Without it, links are logged instead. */
  mail?: { url: string; from: string };
  /**
   * Key that encrypts provider credentials (live mode). Required in production; development falls back to a
   * fixed, insecure key so live mode can be tried locally.
   */
  secretsKey?: string;
  /** Former keys (SECRETS_KEY_PREVIOUS): their secrets still open, and are sealed again with `secretsKey` at start. */
  previousSecretsKeys?: string[];
  /**
   * Relayo's managed sending: the platform's own SMTP relay (Amazon SES SMTP, for example), offered to
   * projects that send from a verified domain of theirs.
   */
  managed?: {
    smtpUrl: string;
    /** Domain the customer's SPF record must include (e.g. `amazonses.com`). Optional. */
    spfInclude?: string;
    /** Messages per project per day. */
    dailyLimit: number;
    /** Token in the URL where the relay's events arrive (`/v1/inbound/managed/<token>`), as Amazon SNS posts them. */
    eventsToken?: string;
    /**
     * AWS region of the relay when it is Amazon SES: each domain is then registered in SES (Bring Your Own
     * DKIM) so SES accepts it as a sender. Credentials from the usual AWS variables.
     */
    sesRegion?: string;
    /** Whether an admin reviews each project before it can use the relay (`manual`, default), or every project can. */
    approval?: 'manual' | 'auto';
  };
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
    adminEmails: (env.ADMIN_EMAILS ?? '').split(',').map((e) => e.trim().toLowerCase()).filter(Boolean),
    secureCookies: env.COOKIE_SECURE === 'true' || (env.COOKIE_SECURE !== 'false' && env.NODE_ENV === 'production'),
    retentionDays: number(env.RETENTION_DAYS, 7),
    limits: {
      monthlyMessages: number(env.MONTHLY_MESSAGE_LIMIT, 0),
      messagesPerMinute: number(env.MESSAGES_PER_MINUTE, 0),
      liveMonthlyMessages: number(env.LIVE_MONTHLY_MESSAGE_LIMIT, 0),
    },
    publicUrl: (env.PUBLIC_URL ?? `http://localhost:${number(env.PORT, 3000)}`).replace(/\/+$/, ''),
  };
  if (env.SECRETS_KEY) config.secretsKey = env.SECRETS_KEY;
  const previous = (env.SECRETS_KEY_PREVIOUS ?? '').split(',').map((k) => k.trim()).filter(Boolean);
  if (previous.length) config.previousSecretsKeys = previous;
  else if (env.NODE_ENV !== 'production') config.secretsKey = 'relayo-development-only-insecure-key';
  if (env.MANAGED_SMTP_URL) {
    config.managed = {
      smtpUrl: smtpUrl('MANAGED_SMTP_URL', env.MANAGED_SMTP_URL),
      dailyLimit: number(env.MANAGED_DAILY_LIMIT, 200),
      approval: env.MANAGED_APPROVAL === 'auto' ? 'auto' : 'manual',
      ...(env.MANAGED_SES_REGION && { sesRegion: env.MANAGED_SES_REGION }),
      ...(env.MANAGED_SPF_INCLUDE && { spfInclude: env.MANAGED_SPF_INCLUDE }),
      ...(env.MANAGED_EVENTS_TOKEN && { eventsToken: env.MANAGED_EVENTS_TOKEN }),
    };
  }
  if (env.MAIL_URL) config.mail = { url: smtpUrl('MAIL_URL', env.MAIL_URL), from: env.MAIL_FROM ?? 'Relayo Sim <no-reply@localhost>' };
  if (env.SMTP_PORT !== 'off') config.smtpPort = number(env.SMTP_PORT, 2525);
  if (env.DATABASE_URL) config.databaseUrl = env.DATABASE_URL;
  if (env.REDIS_URL) config.redisUrl = env.REDIS_URL;
  if (env.ADMIN_TOKEN) config.adminToken = env.ADMIN_TOKEN;
  if (env.TLS_KEY && env.TLS_CERT) config.tls = { key: env.TLS_KEY, cert: env.TLS_CERT };
  else if (env.TLS_KEY_FILE && env.TLS_CERT_FILE) config.tls = { keyFile: env.TLS_KEY_FILE, certFile: env.TLS_CERT_FILE };
  return config;
}

/**
 * Checks an SMTP url from the environment at start, with a message that says how to fix it: a wrong one
 * would otherwise fail later with an obscure error from the mail library.
 */
export function smtpUrl(name: string, value: string): string {
  let url: URL | undefined;
  try {
    url = new URL(value);
  } catch {
    // reported below
  }
  if (!url || (url.protocol !== 'smtp:' && url.protocol !== 'smtps:') || !url.hostname) {
    throw new Error(
      `${name} must look like smtp://user:password@host:587 (STARTTLS) or smtps://user:password@host:465 (TLS); ` +
        'write @ : / # ? inside the user or password as %40 %3A %2F %23 %3F',
    );
  }
  return value;
}
