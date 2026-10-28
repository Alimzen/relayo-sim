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
  /** Two-factor authentication (TOTP), once set up. */
  twoFactor?: TwoFactor;
  createdAt: Date;
}

/** A user's authenticator app: its secret (sealed with SECRETS_KEY) and the unused recovery codes (hashed). */
export interface TwoFactor {
  /** Being set up: confirmed with a first code, then it becomes `secret`. */
  pending?: string;
  secret?: string;
  enabledAt?: Date;
  /** SHA-256 of each recovery code not used yet. */
  recoveryCodes?: string[];
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
  checks: {
    dkim: boolean;
    spf: boolean;
    dmarc: boolean;
    /** Whether the relay (Amazon SES) accepts the domain; absent when the relay keeps no list of senders. */
    relay?: boolean;
  };
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

/** What an emailed or one-time token is for: reset the password, verify the email, or finish a two-factor sign-in. */
export type TokenPurpose = 'reset' | 'verify' | '2fa';

export interface PasswordReset {
  /** SHA-256 of the token sent by email. */
  tokenHash: string;
  userId: string;
  expiresAt: Date;
  /** What the emailed token does: reset the password (default) or verify the email. */
  purpose?: TokenPurpose;
}

/**
 * `test`: the simulator plays scenarios, nothing is delivered. `live`: real delivery through the project's
 * provider connections. Both share the API, the webhook and the panel.
 */
export type Mode = 'test' | 'live';

export type KeyPermission = 'full' | 'send' | 'read';

export interface ApiKey {
  id: string;
  projectId: string;
  name: string;
  mode: Mode;
  /** First characters of the key, to recognize it in lists (`sim_live_AbC1…`). */
  prefix: string;
  /** SHA-256 of the key; the key itself is shown once, when it is created. */
  keyHash: string;
  /** What the key may do: everything (default), only send, or only read. */
  permission?: KeyPermission;
  /** Send keys: the sender domains it may use (`empresa.com` and its subdomains). Absent: any. */
  allowedDomains?: string[];
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
  /** The project's plan: limits that replace the platform's (each one absent uses the platform's). */
  limits?: ProjectLimits;
  /** What Relayo adds to the project's live emails. */
  options?: ProjectOptions;
  /** Secret of the project's inbound URL (`/v1/inbound/email/<token>`), when receiving is on. */
  inboundToken?: string;
  createdAt: Date;
}

/** What Relayo adds to a project's live emails. */
export interface ProjectOptions {
  /**
   * `List-Unsubscribe` (with one-click, RFC 8058) pointing at Relayo's hosted page, on emails to one
   * recipient. `{{unsubscribe_url}}` in the content works either way.
   */
  unsubscribeLinks?: boolean;
  /** A pixel in the HTML of emails to one recipient: `opened` events. */
  trackOpens?: boolean;
  /** Links of the HTML through Relayo, in emails to one recipient: `clicked` events. */
  trackClicks?: boolean;
}

export type ManagedAccess = 'requested' | 'approved' | 'denied';

/** Per-project limits; 0 means no limit (retention: kept forever). */
export interface ProjectLimits {
  monthlyMessages?: number;
  messagesPerMinute?: number;
  liveMonthlyMessages?: number;
  retentionDays?: number;
}

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
  /** The saved template it was sent with (as the sender named it: alias or id). */
  template?: string;
  /** Headers of the original message quoted back in reports (From, To, Subject, Message-ID, X-Relayo-*). */
  headers?: Record<string, string>;
  /** Size in bytes of the captured message (the raw MIME), when there is one. */
  size?: number;
  createdAt: Date;
}

/** A Relayo event produced by the simulator. `provider` is always `simulator`. */
export type SimEvent = RelayoEvent & { projectId: string };

/**
 * What a person can do in a project. The owner (`Project.ownerId`) and admins manage everything; members see
 * the project, send and edit templates, but not keys, credentials or settings.
 */
export type ProjectRole = 'owner' | 'admin' | 'member';

/** Someone other than the owner with access to a project. */
export interface ProjectMember {
  projectId: string;
  userId: string;
  role: Exclude<ProjectRole, 'owner'>;
  createdAt: Date;
}

/** An emailed invitation to join a project, accepted with the link's token. */
export interface ProjectInvite {
  id: string;
  projectId: string;
  /** Lowercased: only the account with this email can accept it. */
  email: string;
  role: Exclude<ProjectRole, 'owner'>;
  /** SHA-256 of the token in the link. */
  tokenHash: string;
  invitedBy: string;
  expiresAt: Date;
  createdAt: Date;
}

/** A send asked for later (`sendAt`): the request as received, sent as is when its time comes. */
export interface ScheduledSend {
  id: string;
  projectId: string;
  mode: Mode;
  channel: 'email' | 'sms';
  request: Record<string, unknown>;
  sendAt: Date;
  status: 'pending' | 'sending' | 'sent' | 'canceled' | 'failed';
  /** For lists: the subject (or the start of the SMS) and who it goes to. */
  summary: string;
  recipients: string[];
  /** Once sent: the message it became. */
  messageId?: string;
  /** Why it could not be sent. */
  error?: string;
  createdAt: Date;
  updatedAt: Date;
}

/** A saved email or SMS that sends fill with variables (`{{name}}`). */
export interface Template {
  id: string;
  projectId: string;
  /** How sends name it, e.g. `bienvenida`: unique in the project. */
  alias: string;
  name: string;
  channel: 'email' | 'sms';
  subject?: string;
  html?: string;
  text?: string;
  /** SMS text. */
  body?: string;
  /**
   * The visual editor's blocks, when the email was built with it. The panel generates `html` and `text` from
   * them; the server only keeps them, and sends use `html` and `text` like any other template.
   */
  design?: Record<string, unknown>;
  createdAt: Date;
  updatedAt: Date;
}

/** One POST of an event to a project's webhook, as the delivery log shows it. */
export interface WebhookAttempt {
  id: string;
  projectId: string;
  eventId: string;
  /** `inbound` for a received email. */
  eventType: SimEvent['type'] | 'inbound';
  recipient: string;
  url: string;
  /** The extra endpoint it went to; absent for the project's main webhook URL. */
  endpointId?: string;
  /** 1-based; `maxAttempts` is how many automatic tries the event gets. */
  attempt: number;
  maxAttempts: number;
  /** Automatic delivery, a redelivery from the panel or API, or a test event. */
  trigger: 'auto' | 'redeliver' | 'test';
  ok: boolean;
  statusCode?: number;
  /** Network error or timeout, when there was no answer. */
  error?: string;
  /** Start of the answer's body (up to 2 KB), to see what the endpoint said. */
  responseBody?: string;
  durationMs: number;
  /** Whether another automatic try will follow this failure. */
  willRetry: boolean;
  createdAt: Date;
}

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

/** Who changed something in a project: a person from the panel, an API key, or a platform admin. */
export type AuditActor =
  | { kind: 'user'; id: string; email: string }
  | { kind: 'key'; id: string; name: string }
  | { kind: 'admin'; email?: string };

/** One change to a project: the audit log. */
export interface AuditEntry {
  id: string;
  projectId: string;
  actor: AuditActor;
  /** Method and route: `POST /v1/project/keys`, `DELETE /v1/project/keys/:id`. */
  action: string;
  /** The route's parameters (ids). */
  params?: Record<string, string>;
  /** The harmless fields of the request (names, roles, permissions…), never secrets. */
  details?: Record<string, unknown>;
  ip?: string;
  mode: Mode;
  createdAt: Date;
}

/** A request made with an API key: the request log. */
export interface ApiRequestLog {
  id: string;
  projectId: string;
  keyId: string;
  keyName: string;
  mode: Mode;
  method: string;
  /** The path as called, without the query. */
  path: string;
  status: number;
  durationMs: number;
  ip?: string;
  /** What the API answered, when it was an error. */
  error?: string;
  createdAt: Date;
}

/** Another URL that gets the project's events, besides the main webhook URL; it may want only some of them. */
export interface WebhookEndpoint {
  id: string;
  projectId: string;
  url: string;
  /** Its own signing secret (`whsec_…`). */
  secret: string;
  description?: string;
  /** The event types it gets; absent means all of them but `inbound`, which an endpoint asks for by name. */
  events?: Array<SimEvent['type'] | 'inbound'>;
  /** Only the events of one mode; absent means both. */
  mode?: Mode;
  enabled: boolean;
  createdAt: Date;
}

/** An email received for a project: a reply to one it sent, or anything sent to its inbound address. */
export interface InboundEmail {
  id: string;
  projectId: string;
  from: string;
  fromName?: string;
  to: string[];
  cc?: string[];
  subject: string;
  text?: string;
  html?: string;
  /** Its `Message-ID` header. */
  messageIdHeader?: string;
  inReplyTo?: string;
  /** The message it answers, when its In-Reply-To or References name one the project sent. */
  replyTo?: { messageId: string; relayoId: string; metadata?: Record<string, string> };
  attachments: Array<{ filename: string; contentType: string; size: number }>;
  /** Threading and routing headers (Message-ID, In-Reply-To, References, Reply-To, Date, List-Id, X-…). */
  headers: Record<string, string>;
  size: number;
  createdAt: Date;
}

/** The parts of the platform the status page reports on. */
export type StatusComponent = 'api' | 'database' | 'queues' | 'smtp';

/** One check of every component, taken each minute. */
export interface StatusSample {
  at: Date;
  /** Whether each component answered; a component the installation does not run is absent. */
  checks: Partial<Record<StatusComponent, boolean>>;
}

export type IncidentStatus = 'investigating' | 'identified' | 'monitoring' | 'resolved';

/** A problem the platform's admins report on the status page, with its updates. */
export interface Incident {
  id: string;
  title: string;
  /** minor: some things slow or failing; major: a component down; critical: the platform down. */
  impact: 'minor' | 'major' | 'critical';
  status: IncidentStatus;
  components: StatusComponent[];
  updates: Array<{ at: Date; status: IncidentStatus; message: string }>;
  createdAt: Date;
  resolvedAt?: Date;
}
