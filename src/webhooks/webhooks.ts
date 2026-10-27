import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';
import type { InboundEmail, Mode, Project, SimEvent, WebhookAttempt } from '../domain.js';
import type { SimStore } from '../store/store.js';

export const WEBHOOK_DISPATCHER = Symbol.for('relayo-sim:webhooks');
export const SIGNATURE_HEADER = 'relayo-signature';

/** The webhook of a received email: the email, with the fields every event has. */
export type InboundPayload = Omit<InboundEmail, 'projectId' | 'createdAt'> & {
  type: 'inbound';
  channel: 'email';
  provider: 'relayo';
  /** The Relayo id of the message it answers, or its own id. */
  messageId: string;
  /** Its first `to` address. */
  recipient: string;
  timestamp: Date;
  metadata?: Record<string, string>;
  projectId: string;
};

/** What a webhook carries: an event about a message, or a received email. */
export type WebhookPayload = SimEvent | InboundPayload;

/** Where an event goes: the main webhook URL, or an extra endpoint (`endpointId`). */
export interface WebhookTarget {
  url: string;
  secret: string;
  endpointId?: string;
}

/** Event types an endpoint can choose from. */
export const WEBHOOK_EVENT_TYPES = [
  'accepted',
  'delivered',
  'deferred',
  'bounced',
  'complained',
  'rejected',
  'opened',
  'clicked',
  'unsubscribed',
  'failed',
  'inbound',
] as const satisfies ReadonlyArray<SimEvent['type'] | 'inbound'>;

/**
 * Every URL an event of a project goes to: the main one, and the enabled endpoints that want it. Received
 * emails only go to the endpoints that ask for `inbound` by name.
 */
export async function webhookTargets(store: SimStore, project: Project, event: WebhookPayload, mode: Mode): Promise<WebhookTarget[]> {
  const inbound = event.type === 'inbound';
  const targets: WebhookTarget[] = project.webhookUrl && !inbound ? [{ url: project.webhookUrl, secret: project.webhookSecret }] : [];
  for (const endpoint of await store.listWebhookEndpoints(project.id)) {
    if (!endpoint.enabled || (endpoint.mode && endpoint.mode !== mode)) continue;
    if (inbound ? !endpoint.events?.includes('inbound') : endpoint.events?.length && !endpoint.events.includes(event.type)) continue;
    targets.push({ url: endpoint.url, secret: endpoint.secret, endpointId: endpoint.id });
  }
  return targets;
}

/** Sends events to a project's webhook URLs, retrying failures. */
export interface WebhookDispatcher {
  dispatch(event: WebhookPayload, target: WebhookTarget): Promise<void>;
  stop(): Promise<void>;
}

/** The JSON body of a webhook: one Relayo event, without the internal project id. */
export function webhookBody(event: WebhookPayload): string {
  const { projectId: _projectId, ...rest } = event;
  return JSON.stringify(rest);
}

/** `t=<unix seconds>,v1=<hex HMAC-SHA256 of "t.body">`, the same scheme as Stripe's. */
export function signWebhook(body: string, secret: string, timestamp = Math.floor(Date.now() / 1000)): string {
  const signature = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest('hex');
  return `t=${timestamp},v1=${signature}`;
}

export function verifyWebhookSignature(body: string, header: string | undefined, secret: string, toleranceSeconds = 300): boolean {
  if (!header) return false;
  const parts = Object.fromEntries(header.split(',').map((p) => p.split('=') as [string, string]));
  const timestamp = Number(parts.t);
  if (!timestamp || !parts.v1) return false;
  if (toleranceSeconds > 0 && Math.abs(Date.now() / 1000 - timestamp) > toleranceSeconds) return false;
  const expected = createHmac('sha256', secret).update(`${timestamp}.${body}`).digest();
  const given = Buffer.from(parts.v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export const WEBHOOK_TIMEOUT_MS = 10_000;

/** What one POST of an event got back. */
export interface DeliveryResult {
  ok: boolean;
  statusCode?: number;
  error?: string;
  responseBody?: string;
  durationMs: number;
}

/** POSTs one event and says what happened. Never throws: a failure is a result. */
export async function attemptWebhook(
  event: WebhookPayload,
  target: { url: string; secret: string },
  doFetch = fetch,
  extraHeaders: Record<string, string> = {},
): Promise<DeliveryResult> {
  const body = webhookBody(event);
  const started = Date.now();
  try {
    const response = await doFetch(target.url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'User-Agent': 'RelayoSim/0.1',
        'Relayo-Event-Id': event.id,
        [SIGNATURE_HEADER]: signWebhook(body, target.secret),
        ...extraHeaders,
      },
      body,
      signal: AbortSignal.timeout(WEBHOOK_TIMEOUT_MS),
    });
    const text = await response.text().catch(() => '');
    return {
      ok: response.ok,
      statusCode: response.status,
      durationMs: Date.now() - started,
      ...(text && { responseBody: text.slice(0, 2048) }),
    };
  } catch (error) {
    return { ok: false, error: describeFailure(error), durationMs: Date.now() - started };
  }
}

/** POSTs one event. Throws on network errors and non-2xx answers so the caller can retry. */
export async function deliverWebhook(event: WebhookPayload, target: { url: string; secret: string }, doFetch = fetch): Promise<void> {
  const result = await attemptWebhook(event, target, doFetch);
  if (!result.ok) throw new Error(result.error ?? `Webhook answered ${result.statusCode}`);
}

/** Network failures as people read them: fetch hides the reason (ECONNREFUSED, a bad certificate) in `cause`. */
function describeFailure(error: unknown): string {
  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return `No answer in ${WEBHOOK_TIMEOUT_MS / 1000} s`;
  }
  const cause = error instanceof Error && error.cause instanceof Error ? error.cause.message : undefined;
  return cause ?? (error instanceof Error ? error.message : String(error));
}

/** Stores one try in the project's delivery log. */
export type WebhookLog = (attempt: WebhookAttempt) => Promise<void>;

/** The log entry for one try of an event. */
export function attemptRecord(
  event: WebhookPayload,
  target: Pick<WebhookTarget, 'url' | 'endpointId'>,
  result: DeliveryResult,
  info: Pick<WebhookAttempt, 'attempt' | 'maxAttempts' | 'trigger' | 'willRetry'>,
): WebhookAttempt {
  return {
    id: `wha_${randomUUID()}`,
    projectId: event.projectId,
    eventId: event.id,
    eventType: event.type,
    recipient: event.recipient,
    url: target.url,
    ...(target.endpointId && { endpointId: target.endpointId }),
    ...info,
    ...result,
    createdAt: new Date(),
  };
}

/** Logging must never break deliveries: a failed write is dropped. */
export async function recordAttempt(log: WebhookLog | undefined, attempt: WebhookAttempt): Promise<void> {
  await log?.(attempt).catch(() => undefined);
}

export interface RetryPolicy {
  attempts: number;
  /** Delay before the n-th retry (1-based). */
  delayMs(retry: number): number;
}

/** Exponential: 10 s, 30 s, 1.5 min, 4.5 min... up to `attempts` tries. */
export const DEFAULT_RETRY: RetryPolicy = { attempts: 8, delayMs: (retry) => 10_000 * 3 ** (retry - 1) };

/** In-process dispatcher with retries on timers. Lost on restart; fine for tests and local runs. */
export class MemoryDispatcher implements WebhookDispatcher {
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  readonly failures: Array<{ event: WebhookPayload; error: unknown }> = [];

  constructor(
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
    private readonly doFetch: typeof fetch = fetch,
    private readonly log?: WebhookLog,
  ) {}

  async dispatch(event: WebhookPayload, target: WebhookTarget): Promise<void> {
    const attempt = async (n: number): Promise<void> => {
      const result = await attemptWebhook(event, target, this.doFetch);
      const willRetry = !result.ok && n < this.retry.attempts;
      await recordAttempt(this.log, attemptRecord(event, target, result, { attempt: n, maxAttempts: this.retry.attempts, trigger: 'auto', willRetry }));
      if (!result.ok) {
        if (!willRetry) {
          this.failures.push({ event, error: new Error(result.error ?? `Webhook answered ${result.statusCode}`) });
          return;
        }
        const timer = setTimeout(() => {
          this.timers.delete(timer);
          void attempt(n + 1);
        }, this.retry.delayMs(n));
        this.timers.add(timer);
      }
    };
    await attempt(1);
  }

  async stop(): Promise<void> {
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();
  }
}
