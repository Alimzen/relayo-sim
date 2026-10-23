import type { RelayoEvent } from '@alimzen/relayo';
import type { ScenarioSelection } from './scenarios/resolve.js';

export interface User {
  id: string;
  /** Lowercased. */
  email: string;
  name: string;
  /** `scrypt$N$r$p$salt$hash`, see accounts/password.ts. */
  passwordHash: string;
  /** When the user proved the email is theirs; live mode needs it. */
  emailVerifiedAt?: Date;
  createdAt: Date;
}

export interface Session {
  /** SHA-256 of the session token; the token only lives in the browser's cookie. */
  idHash: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

/** Providers a project can connect for live delivery. `managed` is Relayo's own sending (verified domains). */
export type ProviderName = 'smtp' | 'ses' | 'sendgrid' | 'resend' | 'postmark' | 'mailgun' | 'twilio' | 'managed';

/** A provider account of a project, used for live delivery. */
export interface Connection {
  id: string;
  projectId: string;
  name: string;
  channel: 'email' | 'sms';
  provider: ProviderName;
  /** Non-secret settings, shown in the panel (host, region, domain...). */
  settings: Record<string, string>;
  /** Credentials, encrypted with SECRETS_KEY (see live/secrets.ts). */
  secrets: string;
  /** Lower goes first; the others are failover, in order. */
  priority: number;
  /** In the URL that receives this provider's webhooks: `/v1/inbound/<token>`. */
  inboundToken: string;
  createdAt: Date;
}

/**
 * A domain a project sends from with Relayo's managed sending. Relayo signs its mail with DKIM; the domain
 * proves it allows that with DNS records.
 */
export interface SendingDomain {
  id: string;
  projectId: string;
  /** Lowercased, e.g. `empresa.com`. */
  domain: string;
  /** DKIM selector: the record lives at `<selector>._domainkey.<domain>`. */
  selector: string;
  /** Base64 SPKI public key, published in the DKIM record. */
  dkimPublicKey: string;
  /** PEM private key, encrypted with SECRETS_KEY. */
  dkimPrivateKey: string;
  /** What the last DNS check found. */
  checks: { dkim: boolean; spf: boolean; dmarc: boolean };
  /** Set once DKIM (and SPF, when the platform asks for it) check out. */
  verifiedAt?: Date;
  lastCheckedAt?: Date;
  createdAt: Date;
}

export type SuppressionReason = 'hard_bounce' | 'complaint' | 'unsubscribe' | 'manual';

/** An address live mode will not send to again, and why. */
export interface Suppression {
  projectId: string;
  /** Lowercased email address or phone number. */
  address: string;
  reason: SuppressionReason;
  createdAt: Date;
}

export interface PasswordReset {
  /** SHA-256 of the token sent by email. */
  tokenHash: string;
  userId: string;
  expiresAt: Date;
  /** What the emailed token does: reset the password (default) or verify the email. */
  purpose?: 'reset' | 'verify';
}

/**
 * `test`: the simulator plays scenarios, nothing is delivered. `live`: real delivery through the project's
 * provider connections. Both share the API, the webhook and the panel.
 */
export type Mode = 'test' | 'live';

export interface ApiKey {
  id: string;
  projectId: string;
  name: string;
  mode: Mode;
  /** First characters of the key, to recognize it in lists (`sim_live_AbC1…`). */
  prefix: string;
  /** SHA-256 of the key; the key itself is shown once, when it is created. */
  keyHash: string;
  createdAt: Date;
  lastUsedAt?: Date;
  revokedAt?: Date;
}

export interface Project {
  id: string;
  name: string;
  /** The user who owns the project; absent for projects created with the admin token. */
  ownerId?: string;
  webhookUrl?: string;
  webhookSecret: string;
  /**
   * SMTP server (`smtp://user:pass@host:port`) that receives the bounce reports (DSN) and complaint
   * reports (ARF) the simulator sends to each message's envelope sender.
   */
  reportsSmtpUrl?: string;
  /** Relayo's own sending is reviewed by an admin before a project can use it. */
  managedAccess?: ManagedAccess;
  createdAt: Date;
}

export type ManagedAccess = 'requested' | 'approved' | 'denied';

export interface SimRecipient {
  address: string;
  scenario: ScenarioSelection;
}

/** A message received by the simulator: an email (over SMTP or the HTTP API) or an SMS (HTTP API). */
export interface SimMessage {
  /** Simulator id (`sim_...`), reported as `providerMessageId`. */
  id: string;
  projectId: string;
  /** Absent for messages stored before live mode existed: they are test messages. */
  mode?: Mode;
  /** Live messages: the connection that delivered it and the provider's own id for it. */
  delivery?: { connectionId: string; provider: string; providerMessageId?: string };
  /** Absent for email (messages stored before SMS existed). */
  channel?: 'email' | 'sms';
  /** SMS text. Emails keep their content as the captured MIME source instead. */
  body?: string;
  via: 'smtp' | 'api';
  /** Relayo's message id when the sender used Relayo (header `X-Relayo-Message-ID` or API field). */
  relayoMessageId?: string;
  from: string;
  /** Envelope sender (MAIL FROM): where bounce and complaint reports go. Defaults to `from`. */
  envelopeFrom?: string;
  recipients: SimRecipient[];
  subject: string;
  metadata?: Record<string, string>;
  tags?: string[];
  /** Headers of the original message quoted back in reports (From, To, Subject, Message-ID, X-Relayo-*). */
  headers?: Record<string, string>;
  /** Size in bytes of the captured message (the raw MIME), when there is one. */
  size?: number;
  createdAt: Date;
}

/** A Relayo event produced by the simulator. `provider` is always `simulator`. */
export type SimEvent = RelayoEvent & { projectId: string };

export interface MessageWithEvents extends SimMessage {
  events: SimEvent[];
}

/** A message in a list, with where it stands: the latest event of its first recipient. */
export interface MessageListItem extends SimMessage {
  latest?: { type: SimEvent['type']; bounceType?: 'hard' | 'soft' | 'block' };
}

export interface ProjectStats {
  since: Date;
  messages: number;
  /** Event counts by type. */
  events: Partial<Record<SimEvent['type'], number>>;
  bounces: { hard: number; soft: number; block: number };
  /** Per UTC day, oldest first, including days without events. */
  daily: Array<{ date: string; delivered: number; bounced: number; deferred: number; complained: number }>;
}
