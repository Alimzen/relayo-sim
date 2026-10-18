import type { SimConfig } from './config.js';
import { MemoryScheduler, type EventScheduler } from './scheduler/scheduler.js';
import { MemoryStore } from './store/memory-store.js';
import type { SimStore } from './store/store.js';
import { MemoryDispatcher, type WebhookDispatcher } from './webhooks/webhooks.js';

export interface Infrastructure {
  store: SimStore;
  scheduler: EventScheduler;
  dispatcher: WebhookDispatcher;
  close(): Promise<void>;
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
  if (config.redisUrl) {
    const { BullScheduler, BullDispatcher } = await import('./queues/bullmq.js');
    scheduler = new BullScheduler(config.redisUrl);
    dispatcher = new BullDispatcher(config.redisUrl);
  } else {
    scheduler = new MemoryScheduler();
    dispatcher = new MemoryDispatcher();
  }

  return {
    store,
    scheduler,
    dispatcher,
    async close() {
      await scheduler.stop();
      await dispatcher.stop();
      await store.close?.();
    },
  };
}
