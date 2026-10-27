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
  it('stores projects and finds them through their active API keys', async () => {
    const store = await open();
    await store.createProject(project());
    const key = { id: 'key_1', projectId: 'prj_1', name: 'CI', prefix: 'sim_live_abcd', keyHash: 'hash_1', mode: 'test' as const, createdAt: new Date('2026-10-18T10:00:00Z') };
    await store.createApiKey(key);
    await store.createApiKey({ ...key, id: 'key_2', name: 'Local', keyHash: 'hash_2', createdAt: new Date('2026-10-18T11:00:00Z') });

    expect(await store.findProjectByApiKeyHash('hash_1')).toMatchObject({ project: { id: 'prj_1', name: 'Tests' }, key: { id: 'key_1' } });
    expect(await store.findProjectByApiKeyHash('nope')).toBeUndefined();
    expect((await store.listApiKeys('prj_1')).map((k) => k.name)).toEqual(['Local', 'CI']);

    await store.touchApiKey('key_1', new Date('2026-10-18T12:00:00Z'));
    expect(await store.revokeApiKey('prj_other', 'key_1')).toBe(false);
    expect(await store.revokeApiKey('prj_1', 'key_1')).toBe(true);
    expect(await store.revokeApiKey('prj_1', 'key_1')).toBe(false);
    expect(await store.findProjectByApiKeyHash('hash_1')).toBeUndefined();
    const revoked = (await store.listApiKeys('prj_1')).find((k) => k.id === 'key_1');
    expect(revoked).toMatchObject({ lastUsedAt: new Date('2026-10-18T12:00:00Z') });
    expect(revoked?.revokedAt).toBeInstanceOf(Date);

    await store.updateProject('prj_1', { webhookSecret: 'whsec_new' });
    expect((await store.getProject('prj_1'))?.webhookSecret).toBe('whsec_new');

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

  it('keeps the captured source of a message, only for its project', async () => {
    const store = await open();
    await store.createProject(project());
    const raw = Buffer.from('Subject: Hola\r\n\r\nCuerpo\r\n');
    await store.saveMessage(message('sim_raw', '2026-10-18T10:00:00Z', { size: raw.length }), raw);
    await store.saveMessage(message('sim_none', '2026-10-18T10:00:00Z'));

    expect((await store.getContent('prj_1', 'sim_raw'))?.toString()).toBe(raw.toString());
    expect((await store.getMessage('prj_1', 'sim_raw'))?.size).toBe(raw.length);
    expect(await store.getContent('prj_other', 'sim_raw')).toBeUndefined();
    expect(await store.getContent('prj_1', 'sim_none')).toBeUndefined();
  });

  it('keeps SMS with their text, and filters messages by channel', async () => {
    const store = await open();
    await store.createProject(project());
    await store.saveMessage(message('sim_mail', '2026-10-18T10:00:00Z'));
    await store.saveMessage(message('sim_sms', '2026-10-18T11:00:00Z', { channel: 'sms', body: 'Tu código es 1234', subject: '' }));

    expect(await store.getMessage('prj_1', 'sim_sms')).toMatchObject({ channel: 'sms', body: 'Tu código es 1234' });
    expect((await store.getMessage('prj_1', 'sim_mail'))?.channel).toBeUndefined();
    expect((await store.listMessages('prj_1', { limit: 10, channel: 'sms' })).map((m) => m.id)).toEqual(['sim_sms']);
    expect((await store.listMessages('prj_1', { limit: 10, channel: 'email' })).map((m) => m.id)).toEqual(['sim_mail']);
    expect((await store.listMessages('prj_1', { limit: 10, search: 'código' })).map((m) => m.id)).toEqual(['sim_sms']);
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

describe.each(stores)('%s store: accounts, filters and stats', (_, open) => {
  const user = { id: 'usr_1', email: 'ana@empresa.com', name: 'Ana', passwordHash: 'scrypt$x', createdAt: new Date('2026-10-18T09:00:00Z') };

  it('keeps users, unique by email, and lists their projects', async () => {
    const store = await open();
    await store.createUser(user);
    await expect(store.createUser({ ...user, id: 'usr_2' })).rejects.toThrow();
    expect(await store.findUserByEmail('ANA@empresa.com')).toMatchObject({ id: 'usr_1', name: 'Ana' });
    await store.updateUser('usr_1', { name: 'Ana P.' });
    expect((await store.getUser('usr_1'))?.name).toBe('Ana P.');

    await store.createProject({ ...project('prj_b'), ownerId: 'usr_1', createdAt: new Date('2026-10-18T11:00:00Z') });
    await store.createProject({ ...project('prj_a'), ownerId: 'usr_1' });
    await store.createProject(project('prj_admin'));
    expect((await store.listProjects('usr_1')).map((p) => p.id)).toEqual(['prj_a', 'prj_b']);
  });

  it('uses each password reset token once, and only before it expires', async () => {
    const store = await open();
    await store.createUser(user);
    await store.createPasswordReset({ tokenHash: 't1', userId: 'usr_1', expiresAt: new Date(Date.now() + 60_000) });
    await store.createPasswordReset({ tokenHash: 'expired', userId: 'usr_1', expiresAt: new Date(Date.now() - 1) });

    expect(await store.usePasswordReset('t1')).toBe('usr_1');
    expect(await store.usePasswordReset('t1')).toBeUndefined();
    expect(await store.usePasswordReset('expired')).toBeUndefined();
    expect(await store.usePasswordReset('nope')).toBeUndefined();
  });

  it('keeps a user\'s two-factor state, and clears it', async () => {
    const store = await open();
    await store.createUser(user);
    const enabledAt = new Date('2026-10-20T10:00:00Z');
    await store.setTwoFactor('usr_1', { secret: 'v1.sealed', enabledAt, recoveryCodes: ['h1', 'h2'] });
    expect((await store.getUser('usr_1'))?.twoFactor).toEqual({ secret: 'v1.sealed', enabledAt, recoveryCodes: ['h1', 'h2'] });
    await store.updateUser('usr_1', { name: 'Ana P.' });
    expect((await store.findUserByEmail('ana@empresa.com'))?.twoFactor?.secret).toBe('v1.sealed');
    await store.setTwoFactor('usr_1', null);
    expect((await store.getUser('usr_1'))?.twoFactor).toBeUndefined();
  });

  it('keeps verification tokens apart from reset tokens, and marks emails verified', async () => {
    const store = await open();
    await store.createUser(user);
    expect((await store.getUser('usr_1'))?.emailVerifiedAt).toBeUndefined();
    await store.createPasswordReset({ tokenHash: 'v1', userId: 'usr_1', expiresAt: new Date(Date.now() + 60_000), purpose: 'verify' });

    expect(await store.usePasswordReset('v1')).toBeUndefined();
    expect(await store.usePasswordReset('v1', 'verify')).toBe('usr_1');
    expect(await store.usePasswordReset('v1', 'verify')).toBeUndefined();

    const at = new Date('2026-10-20T10:00:00Z');
    await store.updateUser('usr_1', { emailVerifiedAt: at });
    await store.updateUser('usr_1', { name: 'Ana P.' });
    expect(await store.getUser('usr_1')).toMatchObject({ name: 'Ana P.', emailVerifiedAt: at });
  });

  it('lists and replaces the encrypted values of connections and domains', async () => {
    const store = await open();
    await store.createProject(project());
    await store.createConnection({
      id: 'con_1',
      projectId: 'prj_1',
      name: 'SMTP',
      channel: 'email',
      provider: 'smtp',
      settings: { host: 'smtp.empresa.com' },
      secrets: 'v1.sealed-1',
      priority: 0,
      inboundToken: 'tok_1',
      createdAt: new Date('2026-10-18T10:00:00Z'),
    });
    await store.createDomain({
      id: 'dom_1',
      projectId: 'prj_1',
      domain: 'empresa.com',
      selector: 'relayo',
      dkimPublicKey: 'pub',
      dkimPrivateKey: 'v1.sealed-2',
      checks: { dkim: false, spf: false, dmarc: false },
      createdAt: new Date('2026-10-18T10:00:00Z'),
    });

    const sealed = await store.listSealed();
    expect(sealed.map((s) => [s.kind, s.id, s.value]).sort()).toEqual([
      ['connection', 'con_1', 'v1.sealed-1'],
      ['domain', 'dom_1', 'v1.sealed-2'],
    ]);
    for (const item of sealed) await store.updateSealed(item, `${item.value}-new`);
    expect((await store.getConnection('prj_1', 'con_1'))?.secrets).toBe('v1.sealed-1-new');
    expect((await store.getDomain('prj_1', 'dom_1'))?.dkimPrivateKey).toBe('v1.sealed-2-new');
    // The project in the item must match.
    await store.updateSealed({ ...sealed[0]!, projectId: 'prj_other' }, 'stolen');
    expect((await store.listSealed()).map((s) => s.value)).not.toContain('stolen');
  });

  it('keeps the webhook delivery log, newest first, with failures and stats', async () => {
    const store = await open();
    await store.createProject(project());
    const attempt = (id: string, at: string, ok: boolean) => ({
      id,
      projectId: 'prj_1',
      eventId: 'evt_1',
      eventType: 'bounced' as const,
      recipient: 'ana@x.com',
      url: 'https://app.example/hooks',
      attempt: 1,
      maxAttempts: 8,
      trigger: 'auto' as const,
      ok,
      durationMs: 42,
      willRetry: !ok,
      createdAt: new Date(at),
      ...(ok ? { statusCode: 200 } : { error: 'No answer in 10 s' }),
    });
    await store.addWebhookAttempt(attempt('wha_1', '2026-10-18T10:00:00Z', false));
    await store.addWebhookAttempt({ ...attempt('wha_2', '2026-10-18T10:01:00Z', true), responseBody: 'ok' });
    await store.addWebhookAttempt({ ...attempt('wha_3', '2026-10-18T10:02:00Z', true), projectId: 'prj_other' }).catch(() => undefined);

    expect((await store.listWebhookAttempts('prj_1', { limit: 10 })).map((a) => a.id)).toEqual(['wha_2', 'wha_1']);
    expect((await store.listWebhookAttempts('prj_1', { limit: 10, failed: true })).map((a) => a.id)).toEqual(['wha_1']);
    expect((await store.listWebhookAttempts('prj_1', { limit: 10, before: new Date('2026-10-18T10:01:00Z') })).map((a) => a.id)).toEqual(['wha_1']);
    expect(await store.getWebhookAttempt('prj_1', 'wha_2')).toMatchObject({ statusCode: 200, responseBody: 'ok', willRetry: false });
    expect(await store.getWebhookAttempt('prj_1', 'wha_1')).toMatchObject({ error: 'No answer in 10 s', willRetry: true });
    expect(await store.webhookStats('prj_1', new Date('2026-10-18T00:00:00Z'))).toEqual({ ok: 1, failed: 1 });

    await store.purge(new Date('2026-10-18T10:00:30Z'));
    expect((await store.listWebhookAttempts('prj_1', { limit: 10 })).map((a) => a.id)).toEqual(['wha_2']);
  });

  it('deletes a project with everything in it, and an account with the projects it owns', async () => {
    const store = await open();
    await store.createUser(user);
    await store.createUser({ ...user, id: 'usr_2', email: 'luis@empresa.com' });
    await store.createProject({ ...project('prj_a'), ownerId: 'usr_1' });
    await store.createProject({ ...project('prj_b'), ownerId: 'usr_2' });
    for (const id of ['prj_a', 'prj_b']) {
      await store.saveMessage({ ...message(`sim_${id}`, '2026-10-18T10:00:00Z'), projectId: id }, Buffer.from('raw'));
      await store.addEvent({ ...event(`evt_${id}`, `sim_${id}`, 'delivered', '2026-10-18T10:00:01Z'), projectId: id });
      await store.suppress(id, 'x@y.com', 'manual');
      await store.incrementUsage(id, '2026-10');
    }
    await store.addMember({ projectId: 'prj_b', userId: 'usr_1', role: 'member', createdAt: new Date() });

    await store.deleteProject('prj_a');
    expect(await store.getProject('prj_a')).toBeUndefined();
    expect(await store.getMessage('prj_a', 'sim_prj_a')).toBeUndefined();
    expect(await store.getUsage('prj_a', '2026-10')).toBe(0);
    expect(await store.getMessage('prj_b', 'sim_prj_b')).toMatchObject({ events: [expect.objectContaining({ id: 'evt_prj_b' })] });

    await store.deleteUser('usr_1');
    expect(await store.getUser('usr_1')).toBeUndefined();
    expect(await store.getMember('prj_b', 'usr_1')).toBeUndefined();
    expect(await store.getProject('prj_b')).toBeDefined();
    await store.deleteUser('usr_2');
    expect(await store.getProject('prj_b')).toBeUndefined();
    expect(await store.suppressed('prj_b', ['x@y.com'])).toEqual(new Set());
  });

  it('keeps project members and invitations, and lists projects with each role', async () => {
    const store = await open();
    await store.createUser(user);
    await store.createUser({ ...user, id: 'usr_2', email: 'luis@empresa.com', name: 'Luis' });
    await store.createProject({ ...project('prj_a'), ownerId: 'usr_1' });
    await store.createProject({ ...project('prj_b'), ownerId: 'usr_2', createdAt: new Date('2026-10-18T11:00:00Z') });

    await store.addMember({ projectId: 'prj_b', userId: 'usr_1', role: 'member', createdAt: new Date('2026-10-18T12:00:00Z') });
    expect((await store.listProjectsFor('usr_1')).map((p) => [p.project.id, p.role])).toEqual([
      ['prj_a', 'owner'],
      ['prj_b', 'member'],
    ]);
    expect(await store.updateMemberRole('prj_b', 'usr_1', 'admin')).toBe(true);
    expect(await store.getMember('prj_b', 'usr_1')).toMatchObject({ role: 'admin' });
    expect((await store.listMembers('prj_b')).map((m) => m.userId)).toEqual(['usr_1']);
    expect(await store.updateMemberRole('prj_b', 'usr_nope', 'admin')).toBe(false);
    expect(await store.removeMember('prj_b', 'usr_1')).toBe(true);
    expect((await store.listProjectsFor('usr_1')).map((p) => p.project.id)).toEqual(['prj_a']);

    const invite = {
      id: 'inv_1',
      projectId: 'prj_a',
      email: 'eva@empresa.com',
      role: 'member' as const,
      tokenHash: 'h1',
      invitedBy: 'usr_1',
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: new Date('2026-10-18T10:00:00Z'),
    };
    await store.createInvite(invite);
    await store.createInvite({ ...invite, id: 'inv_2', tokenHash: 'h2', expiresAt: new Date(Date.now() - 1) });
    expect((await store.listInvites('prj_a')).map((i) => i.id)).toEqual(['inv_1']);
    expect(await store.findInvite('h1')).toMatchObject({ id: 'inv_1', email: 'eva@empresa.com' });
    expect(await store.findInvite('h2')).toBeUndefined();
    expect(await store.deleteInvite('prj_b', 'inv_1')).toBe(false);
    expect(await store.deleteInvite('prj_a', 'inv_1')).toBe(true);
  });

  it('claims due scheduled sends once, and cancels only pending ones', async () => {
    const store = await open();
    await store.createProject(project());
    const send = (id: string, at: string) => ({
      id,
      projectId: 'prj_1',
      mode: 'test' as const,
      channel: 'email' as const,
      request: { subject: 'S', to: ['a@x.com'] },
      sendAt: new Date(at),
      status: 'pending' as const,
      summary: 'S',
      recipients: ['a@x.com'],
      createdAt: new Date('2026-10-18T09:00:00Z'),
      updatedAt: new Date('2026-10-18T09:00:00Z'),
    });
    await store.createScheduled(send('sch_2', '2026-10-18T11:00:00Z'));
    await store.createScheduled(send('sch_1', '2026-10-18T10:00:00Z'));
    await store.createScheduled(send('sch_3', '2026-10-18T12:00:00Z'));

    expect((await store.listScheduled('prj_1', { mode: 'test', status: 'pending', limit: 10 })).map((s) => s.id)).toEqual(['sch_1', 'sch_2', 'sch_3']);
    expect(await store.listScheduled('prj_1', { mode: 'live', limit: 10 })).toEqual([]);

    const due = await store.claimDueScheduled(new Date('2026-10-18T11:30:00Z'), 10);
    expect(due.map((s) => [s.id, s.status])).toEqual([
      ['sch_1', 'sending'],
      ['sch_2', 'sending'],
    ]);
    expect(due[0]!.request).toEqual({ subject: 'S', to: ['a@x.com'] });
    expect(await store.claimDueScheduled(new Date('2026-10-18T11:30:00Z'), 10)).toEqual([]);
    // Stuck in "sending" for over 10 minutes (the server died): taken again.
    expect((await store.claimDueScheduled(new Date('2026-10-18T11:41:00Z'), 10)).map((s) => s.id)).toEqual(['sch_1', 'sch_2']);

    await store.finishScheduled('sch_1', { status: 'sent', messageId: 'sim_9' });
    await store.finishScheduled('sch_2', { status: 'failed', error: 'No connections' });
    expect(await store.getScheduled('prj_1', 'sch_2')).toMatchObject({ status: 'failed', error: 'No connections' });
    expect(await store.getScheduled('prj_1', 'sch_1')).toMatchObject({ status: 'sent', messageId: 'sim_9' });
    expect(await store.cancelScheduled('prj_1', 'sch_1')).toBe(false);
    expect(await store.cancelScheduled('prj_other', 'sch_3')).toBe(false);
    expect(await store.cancelScheduled('prj_1', 'sch_3')).toBe(true);
    expect(await store.claimDueScheduled(new Date('2026-10-18T13:00:00Z'), 10)).toEqual([]);
  });

  it('keeps templates, found by id or alias', async () => {
    const store = await open();
    await store.createProject(project());
    const base = { projectId: 'prj_1', channel: 'email' as const, createdAt: new Date('2026-10-18T10:00:00Z'), updatedAt: new Date('2026-10-18T10:00:00Z') };
    await store.createTemplate({ ...base, id: 'tpl_b', alias: 'pedido', name: 'Pedido', subject: 'S', html: '<p>h</p>' });
    await store.createTemplate({ ...base, id: 'tpl_a', alias: 'alta', name: 'Alta', subject: 'S', text: 't' });
    await expect(store.createTemplate({ ...base, id: 'tpl_c', alias: 'alta', name: 'Otra', subject: 'S', text: 't' })).rejects.toThrow();

    expect((await store.listTemplates('prj_1')).map((t) => t.alias)).toEqual(['alta', 'pedido']);
    expect(await store.getTemplate('prj_1', 'pedido')).toMatchObject({ id: 'tpl_b', html: '<p>h</p>' });
    expect((await store.getTemplate('prj_1', 'tpl_a'))?.text).toBe('t');
    expect(await store.getTemplate('prj_other', 'pedido')).toBeUndefined();

    const updated = { ...(await store.getTemplate('prj_1', 'tpl_b'))!, alias: 'pedido-enviado', text: 'nuevo', updatedAt: new Date('2026-10-19T10:00:00Z') };
    delete updated.html;
    await store.updateTemplate(updated);
    const read = await store.getTemplate('prj_1', 'pedido-enviado');
    expect(read).toMatchObject({ text: 'nuevo', updatedAt: new Date('2026-10-19T10:00:00Z') });
    expect(read?.html).toBeUndefined();

    expect(await store.deleteTemplate('prj_other', 'tpl_a')).toBe(false);
    expect(await store.deleteTemplate('prj_1', 'tpl_a')).toBe(true);
  });

  it('claims idempotency keys once until they expire', async () => {
    const store = await open();
    await store.createProject(project());
    expect(await store.claimIdempotencyKey('prj_1', 'k1', 'fp1', 60_000)).toEqual({ claimed: true });
    expect(await store.claimIdempotencyKey('prj_1', 'k1', 'fp1', 60_000)).toEqual({ claimed: false, fingerprint: 'fp1' });
    await store.completeIdempotencyKey('prj_1', 'k1', { id: 'sim_1', status: 'queued' });
    expect(await store.claimIdempotencyKey('prj_1', 'k1', 'fp2', 60_000)).toEqual({ claimed: false, fingerprint: 'fp1', response: { id: 'sim_1', status: 'queued' } });

    await store.releaseIdempotencyKey('prj_1', 'k1');
    expect(await store.claimIdempotencyKey('prj_1', 'k1', 'fp2', 60_000)).toEqual({ claimed: true });

    expect(await store.claimIdempotencyKey('prj_1', 'short', 'fp', 1)).toEqual({ claimed: true });
    await new Promise((r) => setTimeout(r, 20));
    expect(await store.claimIdempotencyKey('prj_1', 'short', 'other', 60_000)).toEqual({ claimed: true });
  });

  it('finds an event by id, only in its project', async () => {
    const store = await open();
    await store.createProject(project());
    await store.saveMessage(message('sim_1', '2026-10-18T10:00:00Z'));
    await store.addEvent(event('evt_1', 'sim_1', 'bounced', '2026-10-18T10:00:01Z'));
    expect(await store.getEvent('prj_1', 'evt_1')).toMatchObject({ type: 'bounced', timestamp: new Date('2026-10-18T10:00:01Z') });
    expect(await store.getEvent('prj_other', 'evt_1')).toBeUndefined();
  });

  it('keeps the review of Relayo\'s own sending per project', async () => {
    const store = await open();
    await store.createProject(project('prj_a'));
    await store.createProject({ ...project('prj_b'), createdAt: new Date('2026-10-19T10:00:00Z'), managedAccess: 'requested' });
    await store.createProject(project('prj_c'));
    await store.updateProject('prj_a', { managedAccess: 'approved' });

    expect((await store.listManagedAccess()).map((p) => [p.id, p.managedAccess])).toEqual([
      ['prj_b', 'requested'],
      ['prj_a', 'approved'],
    ]);
    await store.updateProject('prj_a', { managedAccess: null });
    expect((await store.getProject('prj_a'))?.managedAccess).toBeUndefined();
  });

  it('counts usage per project and month', async () => {
    const store = await open();
    await store.createProject(project());
    await store.createProject(project('prj_2'));
    expect(await store.incrementUsage('prj_1', '2026-10')).toBe(1);
    expect(await store.incrementUsage('prj_1', '2026-10')).toBe(2);
    expect(await store.incrementUsage('prj_1', '2026-11')).toBe(1);
    expect(await store.getUsage('prj_1', '2026-10')).toBe(2);
    expect(await store.getUsage('prj_2', '2026-10')).toBe(0);
  });

  it('purges old messages with their events and content, and expired sessions', async () => {
    const store = await open();
    await store.createUser(user);
    await store.createProject(project());
    await store.saveMessage(message('sim_old', '2026-10-01T10:00:00Z'), Buffer.from('raw old'));
    await store.saveMessage(message('sim_new', '2026-10-18T10:00:00Z'), Buffer.from('raw new'));
    await store.addEvent(event('e_old', 'sim_old', 'delivered', '2026-10-01T10:00:01Z'));
    await store.addEvent(event('e_new', 'sim_new', 'delivered', '2026-10-18T10:00:01Z'));
    const now = Date.now();
    await store.createSession({ idHash: 'live', userId: 'usr_1', createdAt: new Date(now), expiresAt: new Date(now + 60_000) });
    await store.createSession({ idHash: 'dead', userId: 'usr_1', createdAt: new Date(now), expiresAt: new Date(now - 1) });

    expect(await store.purge(new Date('2026-10-11T00:00:00Z'))).toEqual({ messages: 1 });
    expect(await store.getMessage('prj_1', 'sim_old')).toBeUndefined();
    expect(await store.getContent('prj_1', 'sim_old')).toBeUndefined();
    expect((await store.getMessage('prj_1', 'sim_new'))?.events).toHaveLength(1);
    expect((await store.getContent('prj_1', 'sim_new'))?.toString()).toBe('raw new');
    expect((await store.stats('prj_1', new Date('2026-09-30T00:00:00Z'))).events.delivered).toBe(1);
    expect(await store.getSession('live')).toBeDefined();
  });

  it('keeps sessions until they expire or are deleted', async () => {
    const store = await open();
    await store.createUser(user);
    const now = Date.now();
    await store.createSession({ idHash: 's1', userId: 'usr_1', createdAt: new Date(now), expiresAt: new Date(now + 60_000) });
    await store.createSession({ idHash: 's2', userId: 'usr_1', createdAt: new Date(now), expiresAt: new Date(now + 60_000) });
    await store.createSession({ idHash: 'old', userId: 'usr_1', createdAt: new Date(now), expiresAt: new Date(now - 1) });

    expect(await store.getSession('s1')).toMatchObject({ userId: 'usr_1' });
    expect(await store.getSession('old')).toBeUndefined();
    await store.deleteUserSessions('usr_1', 's1');
    expect(await store.getSession('s2')).toBeUndefined();
    expect(await store.getSession('s1')).toBeDefined();
    await store.deleteSession('s1');
    expect(await store.getSession('s1')).toBeUndefined();
  });

  it('searches and filters messages, with the latest status of each', async () => {
    const store = await open();
    await store.createProject(project());
    const recipients = (address: string) => [{ address, scenario: { name: 'x', source: 'address' as const } }];
    await store.saveMessage(message('sim_1', '2026-10-18T10:00:00Z', { subject: 'Factura octubre', recipients: recipients('hard-bounce@sim.relayo.dev') }));
    await store.saveMessage(message('sim_2', '2026-10-18T10:01:00Z', { subject: 'Bienvenida', recipients: recipients('ana@sim.relayo.dev') }));
    await store.addEvent(event('a1', 'sim_1', 'accepted', '2026-10-18T10:00:01Z'));
    await store.addEvent({ ...event('a2', 'sim_1', 'bounced', '2026-10-18T10:00:02Z'), bounceType: 'hard', reason: 'user_unknown' } as SimEvent);
    for (const e of [event('b1', 'sim_2', 'accepted', '2026-10-18T10:01:01Z'), event('b2', 'sim_2', 'delivered', '2026-10-18T10:01:02Z')]) {
      await store.addEvent(e);
    }
    // events reference their own recipients
    const all = await store.listMessages('prj_1', { limit: 10 });
    expect(all.map((m) => m.id)).toEqual(['sim_2', 'sim_1']);

    expect((await store.listMessages('prj_1', { limit: 10, search: 'FACTURA' })).map((m) => m.id)).toEqual(['sim_1']);
    expect((await store.listMessages('prj_1', { limit: 10, search: 'ana@sim' })).map((m) => m.id)).toEqual(['sim_2']);
    expect((await store.listMessages('prj_1', { limit: 10, search: '100%' }))).toEqual([]);
    expect((await store.listMessages('prj_1', { limit: 10, status: 'bounced' })).map((m) => m.id)).toEqual(['sim_1']);
  });

  it('counts messages, events and bounces by type and day', async () => {
    const store = await open();
    await store.createProject(project());
    const today = new Date();
    const at = (minutes: number) => new Date(today.getTime() - minutes * 60_000).toISOString();
    await store.saveMessage(message('sim_1', at(10)));
    await store.addEvent(event('e1', 'sim_1', 'delivered', at(9)));
    await store.addEvent({ ...event('e2', 'sim_1', 'bounced', at(8)), bounceType: 'block' } as SimEvent);
    await store.addEvent(event('e3', 'sim_1', 'complained', at(7)));

    const stats = await store.stats('prj_1', new Date(today.getTime() - 6 * 86_400_000));
    expect(stats.messages).toBe(1);
    expect(stats.events).toMatchObject({ delivered: 1, bounced: 1, complained: 1 });
    expect(stats.bounces).toEqual({ hard: 0, soft: 0, block: 1 });
    expect(stats.daily.length).toBeGreaterThanOrEqual(7);
    expect(stats.daily.reduce((sum, d) => sum + d.delivered + d.bounced + d.complained, 0)).toBe(3);
  });
});
