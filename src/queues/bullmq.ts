import { Queue, Worker, type ConnectionOptions } from 'bullmq';
import type { SimEvent } from '../domain.js';
import type { EventScheduler, ScheduledStep, StepHandler } from '../scheduler/scheduler.js';
import { deliverWebhook, type WebhookDispatcher } from '../webhooks/webhooks.js';

const TIMELINE_QUEUE = 'sim-timeline';
const WEBHOOK_QUEUE = 'sim-webhooks';

/** Workers need `maxRetriesPerRequest: null` so blocking commands are not cut short. */
const connection = (url: string): ConnectionOptions => ({ url, maxRetriesPerRequest: null });

/** Timeline steps as BullMQ delayed jobs: they survive restarts and spread across instances. */
export class BullScheduler implements EventScheduler {
  private readonly queue: Queue<ScheduledStep>;
  private worker: Worker<ScheduledStep> | undefined;

  constructor(private readonly url: string) {
    this.queue = new Queue(TIMELINE_QUEUE, { connection: connection(url) });
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
    });
  }

  async stop(): Promise<void> {
    await this.worker?.close();
    await this.queue.close();
  }
}

interface WebhookJob {
  event: SimEvent;
  target: { url: string; secret: string };
}

/** Webhook deliveries as BullMQ jobs: 8 attempts, exponential backoff starting at 10 s. */
export class BullDispatcher implements WebhookDispatcher {
  private readonly queue: Queue<WebhookJob>;
  private readonly worker: Worker<WebhookJob>;

  constructor(url: string) {
    this.queue = new Queue(WEBHOOK_QUEUE, { connection: connection(url) });
    this.worker = new Worker<WebhookJob>(
      WEBHOOK_QUEUE,
      async (job) => {
        const { event, target } = job.data;
        // Dates come back from Redis as strings; the webhook body is JSON either way.
        await deliverWebhook({ ...event, timestamp: new Date(event.timestamp) }, target);
      },
      { connection: connection(url), concurrency: 20 },
    );
  }

  async dispatch(event: SimEvent, target: { url: string; secret: string }): Promise<void> {
    await this.queue.add('deliver', { event, target }, {
      jobId: event.id.replaceAll(':', '|'),
      attempts: 8,
      backoff: { type: 'exponential', delay: 10_000 },
      removeOnComplete: 1000,
      removeOnFail: 5000,
    });
  }

  async stop(): Promise<void> {
    await this.worker.close();
    await this.queue.close();
  }
}
