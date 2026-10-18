import { createHmac, timingSafeEqual } from 'node:crypto';
import type { SimEvent } from '../domain.js';

export const WEBHOOK_DISPATCHER = Symbol.for('relayo-sim:webhooks');
export const SIGNATURE_HEADER = 'relayo-signature';

/** Sends events to a project's webhook URL, retrying failures. */
export interface WebhookDispatcher {
  dispatch(event: SimEvent, target: { url: string; secret: string }): Promise<void>;
  stop(): Promise<void>;
}

/** The JSON body of a webhook: one Relayo event, without the internal project id. */
export function webhookBody(event: SimEvent): string {
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

/** POSTs one event. Throws on network errors and non-2xx answers so the caller can retry. */
export async function deliverWebhook(event: SimEvent, target: { url: string; secret: string }, doFetch = fetch): Promise<void> {
  const body = webhookBody(event);
  const response = await doFetch(target.url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'User-Agent': 'RelayoSim/0.1',
      'Relayo-Event-Id': event.id,
      [SIGNATURE_HEADER]: signWebhook(body, target.secret),
    },
    body,
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) throw new Error(`Webhook answered ${response.status}`);
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
  readonly failures: Array<{ event: SimEvent; error: unknown }> = [];

  constructor(
    private readonly retry: RetryPolicy = DEFAULT_RETRY,
    private readonly doFetch: typeof fetch = fetch,
  ) {}

  async dispatch(event: SimEvent, target: { url: string; secret: string }): Promise<void> {
    const attempt = async (n: number): Promise<void> => {
      try {
        await deliverWebhook(event, target, this.doFetch);
      } catch (error) {
        if (n >= this.retry.attempts) {
          this.failures.push({ event, error });
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
