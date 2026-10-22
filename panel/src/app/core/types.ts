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
  createdAt: string;
}

export interface Project {
  id: string;
  name: string;
  webhookUrl: string | null;
  /** Shown without its password. */
  reportsSmtpUrl: string | null;
  createdAt: string;
}

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
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

export interface ProjectUsage {
  month: string;
  messages: number;
  /** 0 means no limit. */
  limits: { monthlyMessages: number; messagesPerMinute: number };
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
