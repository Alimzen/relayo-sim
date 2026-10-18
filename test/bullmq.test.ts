import { randomUUID } from 'node:crypto';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it, vi } from 'vitest';
import type { SimEvent } from '../src/domain.js';
import { BullDispatcher, BullScheduler } from '../src/queues/bullmq.js';
import type { ScheduledStep } from '../src/scheduler/scheduler.js';
import { SimulationService } from '../src/simulation/simulation.service.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { PostgresStore } from '../src/store/postgres-store.js';
import { webhookReceiver } from './helpers.js';

try {
  process.loadEnvFile('.env');
} catch {
  // no .env: BullMQ tests are skipped
}
const REDIS_URL = process.env.TEST_REDIS_URL ?? process.env.REDIS_URL;
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const prefix = `test-${randomUUID().slice(0, 8)}`;
const closers: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const close of closers.reverse()) await close();
});

const step = (index: number, after = 0): ScheduledStep => ({
  projectId: 'prj_1',
  messageId: 'sim_1',
  recipient: 'ana@sim.relayo.dev',
  index,
  at: Date.now() + after,
  step: { after, type: index === 0 ? 'accepted' : 'delivered' },
});

describe.runIf(REDIS_URL)('BullMQ adapters (Redis)', () => {
  it('runs timeline steps after their delay, once each', async () => {
    const scheduler = new BullScheduler(REDIS_URL!, { prefix });
    closers.push(() => scheduler.stop());
    const ran: Array<{ index: number; at: number }> = [];
    const started = Date.now();
    scheduler.start(async (job) => {
      ran.push({ index: job.index, at: Date.now() - started });
    });

    await scheduler.schedule(step(1, 400), 400);
    await scheduler.schedule(step(0), 0);
    await scheduler.schedule(step(0), 0); // same step again: same job id, ignored

    await vi.waitFor(() => expect(ran.map((r) => r.index)).toEqual([0, 1]), { timeout: 5000 });
    expect(ran[1]!.at).toBeGreaterThanOrEqual(350);
    await new Promise((r) => setTimeout(r, 300));
    expect(ran).toHaveLength(2);
  });

  it('delivers signed webhooks and retries until the endpoint answers 2xx', async () => {
    let calls = 0;
    const received: string[] = [];
    const server = createServer((req, res) => {
      const chunks: Buffer[] = [];
      req.on('data', (c: Buffer) => chunks.push(c));
      req.on('end', () => {
        calls++;
        if (calls < 3) return res.writeHead(503).end();
        received.push(`${req.headers['relayo-signature']}|${Buffer.concat(chunks).toString('utf8')}`);
        res.writeHead(200).end();
      });
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    closers.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`;

    const dispatcher = new BullDispatcher(REDIS_URL!, { prefix, webhookBackoffMs: 50 });
    closers.push(() => dispatcher.stop());
    const event: SimEvent = {
      id: `sim_1:ana@sim.relayo.dev:${randomUUID()}`,
      type: 'delivered',
      channel: 'email',
      provider: 'simulator',
      messageId: 'msg_1',
      providerMessageId: 'sim_1',
      recipient: 'ana@sim.relayo.dev',
      timestamp: new Date('2026-10-18T12:00:00Z'),
      raw: {},
      projectId: 'prj_1',
    };

    await dispatcher.dispatch(event, { url, secret: 'whsec_x' });

    await vi.waitFor(() => expect(received).toHaveLength(1), { timeout: 10_000 });
    expect(calls).toBe(3);
    const [signature, body] = received[0]!.split('|');
    expect(signature).toMatch(/^t=\d+,v1=[0-9a-f]{64}$/);
    expect(JSON.parse(body!)).toMatchObject({ type: 'delivered', timestamp: '2026-10-18T12:00:00.000Z' });
    expect(JSON.parse(body!)).not.toHaveProperty('projectId');
  });

  it('plays a whole scenario through Redis queues and PostgreSQL (or memory) into webhooks', async () => {
    const store = DATABASE_URL
      ? await PostgresStore.connect(DATABASE_URL, { schema: `test_${prefix.replaceAll('-', '_')}` })
      : new MemoryStore();
    closers.push(async () => {
      if (store instanceof PostgresStore) {
        await store.dropSchema(`test_${prefix.replaceAll('-', '_')}`);
        await store.close();
      }
    });
    const scheduler = new BullScheduler(REDIS_URL!, { prefix: `${prefix}-e2e` });
    const dispatcher = new BullDispatcher(REDIS_URL!, { prefix: `${prefix}-e2e`, webhookBackoffMs: 50 });
    closers.push(() => scheduler.stop(), () => dispatcher.stop());
    const hooks = await webhookReceiver();
    closers.push(() => hooks.close());

    // timeScale 0: every step is due at once and workers run them concurrently, in any order.
    const sim = new SimulationService(store, scheduler, dispatcher, { timeScale: 0 });
    const { project } = await sim.createProject('Redis e2e', hooks.url);
    hooks.setSecret(project.webhookSecret);

    const message = await sim.acceptFromApi(project, {
      from: 'a@empresa.com',
      to: ['mailbox-full@sim.relayo.dev'],
      subject: 's',
      relayoMessageId: 'msg_redis',
    });

    // Webhooks may arrive in any order; receivers order them by timestamp (then id).
    const ordered = () =>
      [...hooks.events].sort((a, b) => Date.parse(String(a.timestamp)) - Date.parse(String(b.timestamp)) || a.id.localeCompare(b.id));
    await vi.waitFor(() => expect(ordered().map((e) => e.type)).toEqual(['accepted', 'deferred', 'deferred', 'bounced']), {
      timeout: 10_000,
    });
    expect(ordered().at(-1)).toMatchObject({ bounceType: 'soft', reason: 'mailbox_full', messageId: 'msg_redis' });
    expect(hooks.invalid).toEqual([]);
    const stored = await store.getMessage(project.id, message.id);
    expect(stored!.events.map((e) => e.type)).toEqual(['accepted', 'deferred', 'deferred', 'bounced']);
  });
});

describe.runIf(!REDIS_URL)('BullMQ adapters', () => {
  it.skip('need REDIS_URL or TEST_REDIS_URL (in .env) to run', () => {});
});
