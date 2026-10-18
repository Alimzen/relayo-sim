import type { RelayoEvent } from '@alimzen/core';
import type { ScenarioSelection } from './scenarios/resolve.js';

export interface User {
  id: string;
  /** Lowercased. */
  email: string;
  name: string;
  /** `scrypt$N$r$p$salt$hash`, see accounts/password.ts. */
  passwordHash: string;
  createdAt: Date;
}

export interface Session {
  /** SHA-256 of the session token; the token only lives in the browser's cookie. */
  idHash: string;
  userId: string;
  createdAt: Date;
  expiresAt: Date;
}

export interface ApiKey {
  id: string;
  projectId: string;
  name: string;
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
  createdAt: Date;
}

export interface SimRecipient {
  address: string;
  scenario: ScenarioSelection;
}

/** A message received by the simulator, over SMTP or the HTTP API. */
export interface SimMessage {
  /** Simulator id (`sim_...`), reported as `providerMessageId`. */
  id: string;
  projectId: string;
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
