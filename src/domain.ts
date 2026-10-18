import type { RelayoEvent } from '@alimzen/core';
import type { ScenarioSelection } from './scenarios/resolve.js';

export interface Project {
  id: string;
  name: string;
  /** SHA-256 of the API key; the key itself is shown once, when the project is created. */
  apiKeyHash: string;
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
