import type { SimConfig } from './config.js';
import { MemoryScheduler, type EventScheduler } from './scheduler/scheduler.js';
import { MemoryStore } from './store/memory-store.js';
import type { SimStore } from './store/store.js';
import { MemoryDispatcher, type WebhookDispatcher } from './webhooks/webhooks.js';

export const INFRASTRUCTURE = Symbol.for('relayo-sim:infrastructure');

export interface Infrastructure {
  store: SimStore;
  scheduler: EventScheduler;
  dispatcher: WebhookDispatcher;
  /** Whether each backing service answers: `ok`, or why not. In-memory ones are not listed. */
  check(): Promise<Record<string, string>>;
  close(): Promise<void>;
}

/** A dependency that does not answer in time counts as down: health checks must answer fast. */
async function probe(fn: () => Promise<unknown>, timeoutMs = 3000): Promise<string> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    await Promise.race([fn(), new Promise((_, reject) => (timer = setTimeout(() => reject(new Error(`no answer in ${timeoutMs} ms`)), timeoutMs)))]);
    return 'ok';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Picks the backing services: PostgreSQL when `DATABASE_URL` is set, BullMQ when `REDIS_URL` is set,
 * in-memory otherwise.
 */
export async function infrastructure(config: SimConfig): Promise<Infrastructure> {
  const store: SimStore = config.databaseUrl
    ? await (await import('./store/postgres-store.js')).PostgresStore.connect(config.databaseUrl)
    : new MemoryStore();

  let scheduler: EventScheduler;
  let dispatcher: WebhookDispatcher;
  let pingRedis: (() => Promise<unknown>) | undefined;
  if (config.redisUrl) {
    const { BullScheduler, BullDispatcher } = await import('./queues/bullmq.js');
    const bull = new BullScheduler(config.redisUrl);
    scheduler = bull;
    dispatcher = new BullDispatcher(config.redisUrl);
    pingRedis = () => bull.ping();
  } else {
    scheduler = new MemoryScheduler();
    dispatcher = new MemoryDispatcher();
  }

  return {
    store,
    scheduler,
    dispatcher,
    async check() {
      const checks: Record<string, string> = {};
      if (store.ping) checks.database = await probe(() => store.ping!());
      if (pingRedis) checks.redis = await probe(pingRedis);
      return checks;
    },
    async close() {
      await scheduler.stop();
      await dispatcher.stop();
      await store.close?.();
    },
  };
}
