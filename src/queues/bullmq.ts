import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { SimEvent } from '../domain.js';
import type { EventScheduler, ScheduledStep, StepHandler } from '../scheduler/scheduler.js';
import { type WebhookTarget, attemptRecord, attemptWebhook, recordAttempt, type WebhookDispatcher, type WebhookLog } from '../webhooks/webhooks.js';

const TIMELINE_QUEUE = 'sim-timeline';
const WEBHOOK_QUEUE = 'sim-webhooks';

export interface BullOptions {
  /** Redis key prefix for the queues (default `bull`). Lets several environments or tests share a Redis. */
  prefix?: string;
  /** First retry delay for webhook deliveries, doubled on each attempt. Default 10 000 ms. */
  webhookBackoffMs?: number;
  /** Webhook delivery attempts. Default 8. */
  webhookAttempts?: number;
  /** Stores each delivery try (the panel's delivery log). */
  webhookLog?: WebhookLog;
}

/** Workers need `maxRetriesPerRequest: null` so blocking commands are not cut short. */
const connection = (url: string): ConnectionOptions => ({ url, maxRetriesPerRequest: null });

/** Timeline steps as BullMQ delayed jobs: they survive restarts and spread across instances. */
export class BullScheduler implements EventScheduler {
  private readonly queue: Queue<ScheduledStep>;
  private worker: Worker<ScheduledStep> | undefined;

  constructor(
    private readonly url: string,
    private readonly options: BullOptions = {},
  ) {
    this.queue = new Queue(TIMELINE_QUEUE, { connection: connection(url), ...(options.prefix && { prefix: options.prefix }) });
  }

  async schedule(job: ScheduledStep, delayMs: number): Promise<void> {
    await this.queue.add('step', job, {
      delay: Math.max(0, Math.round(delayMs)),
      // Stable id: scheduling the same step twice does not create two events.
      jobId: `${job.messageId}|${job.recipient}|${job.index}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  start(handler: StepHandler): void {
    this.worker = new Worker<ScheduledStep>(TIMELINE_QUEUE, (job) => handler(job.data), {
      connection: connection(this.url),
      concurrency: 20,
      ...(this.options.prefix && { prefix: this.options.prefix }),
    });
  }

  /** Answers when Redis does (health checks). */
  async ping(): Promise<void> {
    // Any command works: this one is cheap and part of the public API.
    await this.queue.isPaused();
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}

interface WebhookJob {
  event: SimEvent;
  target: WebhookTarget;
}

/** Webhook deliveries as BullMQ jobs: 8 attempts, exponential backoff starting at 10 s. */
export class BullDispatcher implements WebhookDispatcher {
  private readonly queue: Queue<WebhookJob>;
  private readonly worker: Worker<WebhookJob>;

  constructor(
    url: string,
    private readonly options: BullOptions = {},
  ) {
    const prefix = options.prefix ? { prefix: options.prefix } : {};
    this.queue = new Queue(WEBHOOK_QUEUE, { connection: connection(url), ...prefix });
    this.worker = new Worker<WebhookJob>(
      WEBHOOK_QUEUE,
      async (job) => {
        const { target } = job.data;
        // Dates come back from Redis as strings; the webhook body is JSON either way.
        const event = { ...job.data.event, timestamp: new Date(job.data.event.timestamp) };
        const result = await attemptWebhook(event, target);
        const attempt = job.attemptsMade + 1;
        const maxAttempts = job.opts.attempts ?? 1;
        const willRetry = !result.ok && attempt < maxAttempts;
        await recordAttempt(options.webhookLog, attemptRecord(event, target, result, { attempt, maxAttempts, trigger: 'auto', willRetry }));
        if (!result.ok) throw new Error(result.error ?? `Webhook answered ${result.statusCode}`);
      },
      { connection: connection(url), concurrency: 20, ...prefix },
    );
  }

  async dispatch(event: SimEvent, target: WebhookTarget): Promise<void> {
    await this.queue.add('deliver', { event, target }, {
      // One job per event and URL: the same event goes to every endpoint that wants it.
      jobId: `${event.id}${target.endpointId ? `|${target.endpointId}` : ''}`.replaceAll(':', '|'),
      attempts: this.options.webhookAttempts ?? 8,
      backoff: { type: 'exponential', delay: this.options.webhookBackoffMs ?? 10_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async stop(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }
}
