export type EventType =
  | 'accepted'
  | 'delivered'
  | 'deferred'
  | 'bounced'
  | 'complained'
  | 'rejected'
  | 'opened'
  | 'clicked'
  | 'unsubscribed'
  | 'failed';

export type BounceType = 'hard' | 'soft' | 'block';

export interface User {
  id: string;
  email: string;
  name: string;
  /** Live mode needs it. */
  emailVerified: boolean;
  /** Two-factor authentication is on. */
  twoFactor: boolean;
  /** Reviews requests for Relayo's own sending. */
  admin: boolean;
  createdAt: string;
}

export type ManagedAccess = 'requested' | 'approved' | 'denied';

export interface TeamView {
  members: Array<{ userId: string; name: string; email: string; role: ProjectRole; since: string }>;
  invites: Array<{ id: string; email: string; role: 'admin' | 'member'; expiresAt: string; createdAt: string }>;
}

export interface InviteInfo {
  project: string;
  email: string;
  role: 'admin' | 'member';
  invitedBy: string;
  expiresAt: string;
}

export interface ScheduledSend {
  id: string;
  mode: Mode;
  channel: 'email' | 'sms';
  sendAt: string;
  status: 'pending' | 'sending' | 'sent' | 'canceled' | 'failed';
  summary: string;
  recipients: string[];
  messageId?: string;
  error?: string;
  createdAt: string;
  updatedAt: string;
}

export interface Template {
  id: string;
  alias: string;
  name: string;
  channel: 'email' | 'sms';
  subject?: string;
  html?: string;
  text?: string;
  body?: string;
  /** The variables its content uses. */
  variables: string[];
  createdAt: string;
  updatedAt: string;
}

export interface TemplatePreview {
  rendered: { subject?: string; html?: string; text?: string; body?: string };
  missing: string[];
}

/** One POST of an event to the project's webhook. */
export interface WebhookDelivery {
  id: string;
  eventId: string;
  eventType: EventType;
  recipient: string;
  url: string;
  attempt: number;
  maxAttempts: number;
  trigger: 'auto' | 'redeliver' | 'test';
  ok: boolean;
  statusCode?: number;
  error?: string;
  responseBody?: string;
  durationMs: number;
  willRetry: boolean;
  createdAt: string;
}

export interface WebhookDeliveryDetail extends WebhookDelivery {
  /** The event as it was sent; null once its message is past retention (or for test events). */
  event: Record<string, unknown> | null;
}

export interface WebhookStats {
  since: string;
  ok: number;
  failed: number;
  latest: WebhookDelivery | null;
}

/** A project's plan: limits that replace the platform's (0 = no limit; retention 0 = forever). */
export interface PlanLimits {
  monthlyMessages: number;
  messagesPerMinute: number;
  liveMonthlyMessages: number;
  retentionDays: number;
}

export interface PlanRow {
  project: Project;
  ownerEmail: string | null;
  /** Only the limits the project has of its own. */
  plan: Partial<PlanLimits>;
  effective: PlanLimits;
  usage: { messages: number; live: number };
}

export interface AuditEntry {
  id: string;
  actor: { kind: 'user'; id: string; email: string } | { kind: 'key'; id: string; name: string } | { kind: 'admin'; email?: string };
  /** Method and route: `POST /v1/project/keys`. */
  action: string;
  params?: Record<string, string>;
  details?: Record<string, unknown>;
  ip?: string;
  mode: Mode;
  createdAt: string;
}

export interface ApiRequestLog {
  id: string;
  keyId: string;
  keyName: string;
  mode: Mode;
  method: string;
  path: string;
  status: number;
  durationMs: number;
  ip?: string;
  error?: string;
  createdAt: string;
}

export interface ManagedRequest {
  project: Project;
  owner: { email: string; name: string; createdAt: string } | null;
  domains: Array<{ domain: string; verified: boolean }>;
  usage: number;
}

export type ProjectRole = 'owner' | 'admin' | 'member';

export interface Project {
  id: string;
  /** The signed-in person's role in it. */
  role?: ProjectRole;
  name: string;
  webhookUrl: string | null;
  /** Shown without its password. */
  reportsSmtpUrl: string | null;
  managedAccess: ManagedAccess | null;
  createdAt: string;
}

export type Mode = 'test' | 'live';

export type KeyPermission = 'full' | 'send' | 'read';

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  mode: Mode;
  permission: KeyPermission;
  /** Send keys: the sender domains they may use; null for any. */
  allowedDomains: string[] | null;
  createdAt: string;
  lastUsedAt: string | null;
  revokedAt: string | null;
}

export interface Scenario {
  name: string;
  description: string;
  /** An address (email) or a number (SMS) that selects it. */
  example: string;
  channel?: 'email' | 'sms';
}

export interface Recipient {
  address: string;
  scenario: { name: string; param?: string; source: 'address' | 'header' | 'default' };
}

export interface SimEvent {
  id: string;
  type: EventType;
  channel?: 'email' | 'sms';
  recipient: string;
  timestamp: string;
  messageId: string;
  providerMessageId: string;
  metadata?: Record<string, string>;
  bounceType?: BounceType;
  reason?: string;
  smtpCode?: number;
  enhancedCode?: string;
  diagnostic?: string;
  url?: string;
  raw?: unknown;
}

export interface SimMessage {
  id: string;
  via: 'smtp' | 'api';
  /** Absent for email. */
  channel?: 'email' | 'sms';
  /** SMS text. */
  body?: string;
  mode?: Mode;
  /** Live messages: the connection that delivered it. */
  delivery?: { connectionId: string; provider: string; providerMessageId?: string };
  relayoMessageId?: string;
  from: string;
  envelopeFrom?: string;
  recipients: Recipient[];
  subject: string;
  metadata?: Record<string, string>;
  tags?: string[];
  createdAt: string;
  /** Bytes of the captured email; absent when there is none (e.g. refused at RCPT). */
  size?: number;
  latest?: { type: EventType; bounceType?: BounceType };
}

export interface MessageContent {
  subject: string;
  from?: string;
  to?: string;
  cc?: string;
  replyTo?: string;
  date?: string;
  messageId?: string;
  text?: string;
  html?: string;
  headers: Array<{ name: string; value: string }>;
  attachments: Array<{ index: number; filename: string; contentType: string; size: number; inline: boolean }>;
  size: number;
}

export interface MessageDetail extends SimMessage {
  events: SimEvent[];
}

export interface ProviderField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  options?: string[];
  help?: string;
}

export interface Provider {
  name: string;
  label: string;
  channel: 'email' | 'sms';
  fields: ProviderField[];
  webhooks: { supported: boolean; help: string };
}

export interface Connection {
  id: string;
  name: string;
  channel: 'email' | 'sms';
  provider: string;
  providerLabel: string;
  settings: Record<string, string>;
  secretsSet: string[];
  priority: number;
  inboundPath: string;
  webhooks: { supported: boolean; help: string };
  /** Set while it is skipped for failing repeatedly. */
  pausedUntil: string | null;
  createdAt: string;
}

export interface SendingDomain {
  id: string;
  domain: string;
  verified: boolean;
  verifiedAt: string | null;
  lastCheckedAt: string | null;
  records: Array<{ purpose: 'dkim' | 'spf' | 'dmarc'; type: string; host: string; value: string; required: boolean; ok: boolean }>;
  /** The relay's own check of the domain (Amazon SES), when it keeps one. */
  relay: { name: string; verified: boolean } | null;
  createdAt: string;
}

export interface Suppression {
  address: string;
  reason: 'hard_bounce' | 'complaint' | 'unsubscribe' | 'manual';
  createdAt: string;
}

export interface ProjectUsage {
  month: string;
  /** Simulated messages this month. */
  messages: number;
  /** Real (live) messages this month. */
  live: number;
  /** 0 means no limit. */
  limits: { monthlyMessages: number; messagesPerMinute: number; liveMonthlyMessages: number };
  /** 0 means messages are kept forever. */
  retentionDays: number;
}

export interface ProjectStats {
  since: string;
  messages: number;
  events: Partial<Record<EventType, number>>;
  bounces: Record<BounceType, number>;
  daily: Array<{ date: string; delivered: number; bounced: number; deferred: number; complained: number }>;
}
