import { randomUUID } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import type { Project, SimEvent, SimMessage } from '../src/domain.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { PostgresStore } from '../src/store/postgres-store.js';
import type { SimStore } from '../src/store/store.js';

try {
  process.loadEnvFile('.env');
} catch {
  // no .env: PostgreSQL tests are skipped
}
const DATABASE_URL = process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL;
const schema = `test_${randomUUID().replaceAll('-', '').slice(0, 12)}`;
let postgres: PostgresStore | undefined;

afterAll(async () => {
  await postgres?.dropSchema(schema);
  await postgres?.close();
});

const stores: Array<[string, () => Promise<SimStore>]> = [['memory', async () => new MemoryStore()]];
if (DATABASE_URL) {
  stores.push([
    'postgres',
    async () => {
      postgres ??= await PostgresStore.connect(DATABASE_URL, { schema });
      await postgres.truncate();
      return postgres;
    },
  ]);
}

const project = (id = 'prj_1'): Project => ({
  id,
  name: 'Tests',
  apiKeyHash: `hash_${id}`,
  webhookSecret: 'whsec_x',
  createdAt: new Date('2026-10-18T10:00:00Z'),
});

const message = (id: string, createdAt: string, extra: Partial<SimMessage> = {}): SimMessage => ({
  id,
  projectId: 'prj_1',
  via: 'api',
  from: 'a@empresa.com',
  recipients: [{ address: 'ana@sim.relayo.dev', scenario: { name: 'delivered', source: 'default' } }],
  subject: 'Hola',
  createdAt: new Date(createdAt),
  ...extra,
});

const event = (id: string, messageId: string, type: SimEvent['type'], at: string): SimEvent => ({
  id,
  type,
  channel: 'email',
  provider: 'simulator',
  messageId: 'msg_1',
  providerMessageId: messageId,
  recipient: 'ana@sim.relayo.dev',
  timestamp: new Date(at),
  raw: { step: type },
  projectId: 'prj_1',
});

describe.each(stores)('%s store', (_, open) => {
  it('stores projects and finds them by API key hash', async () => {
    const store = await open();
    await store.createProject(project());
    expect(await store.findProjectByApiKeyHash('hash_prj_1')).toMatchObject({ id: 'prj_1', name: 'Tests' });
    expect(await store.findProjectByApiKeyHash('nope')).toBeUndefined();

    await store.updateProject('prj_1', { webhookUrl: 'https://app.example.com/hooks' });
    expect(await store.getProject('prj_1')).toMatchObject({ webhookUrl: 'https://app.example.com/hooks', name: 'Tests' });
    await store.updateProject('prj_1', { reportsSmtpUrl: 'smtp://u:p@mail.example.com:25' });
    expect(await store.getProject('prj_1')).toMatchObject({ reportsSmtpUrl: 'smtp://u:p@mail.example.com:25', webhookUrl: 'https://app.example.com/hooks' });
    await store.updateProject('prj_1', { reportsSmtpUrl: null });
    const cleared = await store.getProject('prj_1');
    expect(cleared?.reportsSmtpUrl).toBeUndefined();
    expect(cleared?.webhookUrl).toBe('https://app.example.com/hooks');
  });

  it('keeps messages with their timeline, ignoring duplicate events', async () => {
    const store = await open();
    await store.createProject(project());
    await store.saveMessage(
      message('sim_1', '2026-10-18T10:00:00Z', {
        relayoMessageId: 'msg_1',
        metadata: { k: 'v' },
        tags: ['t'],
        envelopeFrom: 'bounces@empresa.com',
        headers: { subject: 'Hola', 'message-id': '<msg_1@empresa.com>' },
      }),
    );
    await store.addEvent(event('e2', 'sim_1', 'delivered', '2026-10-18T10:00:02Z'));
    await store.addEvent(event('e1', 'sim_1', 'accepted', '2026-10-18T10:00:01Z'));
    await store.addEvent(event('e1', 'sim_1', 'accepted', '2026-10-18T10:00:01Z'));

    const stored = await store.getMessage('prj_1', 'sim_1');
    expect(stored).toMatchObject({
      id: 'sim_1',
      relayoMessageId: 'msg_1',
      metadata: { k: 'v' },
      tags: ['t'],
      via: 'api',
      envelopeFrom: 'bounces@empresa.com',
      headers: { subject: 'Hola', 'message-id': '<msg_1@empresa.com>' },
    });
    expect(stored!.recipients).toEqual([{ address: 'ana@sim.relayo.dev', scenario: { name: 'delivered', source: 'default' } }]);
    expect(stored!.events.map((e) => [e.id, e.type])).toEqual([
      ['e1', 'accepted'],
      ['e2', 'delivered'],
    ]);
    expect(stored!.events[0]!.timestamp).toEqual(new Date('2026-10-18T10:00:01Z'));
  });

  it('only shows a project its own messages', async () => {
    const store = await open();
    await store.createProject(project());
    await store.saveMessage(message('sim_1', '2026-10-18T10:00:00Z'));
    expect(await store.getMessage('prj_other', 'sim_1')).toBeUndefined();
    expect(await store.listMessages('prj_other', { limit: 10 })).toEqual([]);
  });

  it('lists messages newest first, with paging', async () => {
    const store = await open();
    await store.createProject(project());
    await store.saveMessage(message('sim_a', '2026-10-18T10:00:00Z'));
    await store.saveMessage(message('sim_b', '2026-10-18T11:00:00Z'));
    await store.saveMessage(message('sim_c', '2026-10-18T12:00:00Z'));

    expect((await store.listMessages('prj_1', { limit: 2 })).map((m) => m.id)).toEqual(['sim_c', 'sim_b']);
    expect((await store.listMessages('prj_1', { limit: 2, before: new Date('2026-10-18T11:00:00Z') })).map((m) => m.id)).toEqual(['sim_a']);
  });

  it('counts greylisting attempts and forgets them after the TTL', async () => {
    const store = await open();
    expect(await store.nextAttempt('k', 60_000)).toBe(1);
    expect(await store.nextAttempt('k', 60_000)).toBe(2);
    expect(await store.nextAttempt('other', 60_000)).toBe(1);
    expect(await store.nextAttempt('short', 1)).toBe(1);
    await new Promise((r) => setTimeout(r, 20));
    expect(await store.nextAttempt('short', 1)).toBe(1);
  });
});

describe.runIf(!DATABASE_URL)('postgres store', () => {
  it.skip('needs DATABASE_URL or TEST_DATABASE_URL (in .env) to run', () => {});
});
