import { createHmac } from 'node:crypto';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Project } from '../src/domain.js';
import { LiveError, LiveService } from '../src/live/live.service.js';
import { SecretBox } from '../src/live/secrets.js';
import { MemoryStore } from '../src/store/memory-store.js';
import type { WebhookDispatcher } from '../src/webhooks/webhooks.js';

const PUBLIC_URL = 'https://relayo.example.com';
const project: Project = { id: 'prj_1', name: 'P', webhookSecret: 'whsec_x', createdAt: new Date() };

/** Twilio's Messages API, standing in: answers per number and records each request. */
function fakeTwilio(answer: (to: string, account: string) => Response = () => Response.json({ sid: 'SM1' }, { status: 201 })) {
  const calls: Array<{ account: string; form: Record<string, string> }> = [];
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init: RequestInit) => {
      const account = /Accounts\/([^/]+)\//.exec(url)![1]!;
      const form = Object.fromEntries(init.body as URLSearchParams);
      calls.push({ account, form });
      return answer(form.To!, account);
    }),
  );
  return calls;
}

/** A callback as Twilio posts it: form body, signed over the full URL with the auth token. */
function signed(url: string, params: Record<string, string>, token = 'token-1') {
  const data = url + Object.keys(params).sort().map((k) => k + params[k]).join('');
  const body = new URLSearchParams(params).toString();
  return {
    headers: { 'x-twilio-signature': createHmac('sha1', token).update(data).digest('base64') },
    body,
    rawBody: body,
    url: url.slice(PUBLIC_URL.length),
  };
}

async function setup() {
  const store = new MemoryStore();
  await store.createProject(project);
  const dispatched: unknown[] = [];
  const webhooks = { dispatch: async (event: unknown) => void dispatched.push(event) } as unknown as WebhookDispatcher;
  const live = new LiveService(store, webhooks, new SecretBox('test-key'), undefined, PUBLIC_URL);
  const twilio = (account: string, token = 'token-1') =>
    live.createConnection(project, { provider: 'twilio', values: { accountSid: account, authToken: token, from: '+15550001111' } });
  return { store, live, twilio };
}

afterEach(() => vi.unstubAllGlobals());

describe('live SMS', () => {
  it('needs an SMS connection, and the sender or a messaging service', async () => {
    const { live } = await setup();
    await expect(live.sendSms(project, { to: ['+34600111222'], body: 'Hola' })).rejects.toBeInstanceOf(LiveError);
    await expect(live.createConnection(project, { provider: 'twilio', values: { accountSid: 'AC1', authToken: 't' } })).rejects.toThrow(/Messaging Service/);
  });

  it('sends through Twilio with a status callback that maps back, and records the delivery', async () => {
    const calls = fakeTwilio();
    const { store, live, twilio } = await setup();
    const connection = await twilio('AC1');

    const message = await live.sendSms(project, { to: ['+34600111222'], body: 'Tu código: 1234', metadata: { userId: '42' } });

    expect(calls).toHaveLength(1);
    expect(calls[0]!.form).toMatchObject({
      To: '+34600111222',
      From: '+15550001111',
      Body: 'Tu código: 1234',
      StatusCallback: `${PUBLIC_URL}/v1/inbound/${connection.inboundToken}?relayo_message_id=${message.id}`,
    });
    const stored = await store.getMessage(project.id, message.id);
    expect(stored).toMatchObject({ mode: 'live', channel: 'sms', delivery: { connectionId: connection.id, provider: 'twilio', providerMessageId: 'SM1' } });
    expect(stored!.events.map((e) => e.type)).toEqual(['accepted']);
  });

  it('fails over to the next connection when Twilio is down', async () => {
    const calls = fakeTwilio((_to, account) => (account === 'AC1' ? new Response('down', { status: 503 }) : Response.json({ sid: 'SM2' }, { status: 201 })));
    const { live, twilio } = await setup();
    await twilio('AC1');
    const backup = await twilio('AC2');

    const message = await live.sendSms(project, { to: ['+34600111222'], body: 'x' });
    expect(calls.map((c) => c.account)).toEqual(['AC1', 'AC2']);
    expect(message.delivery).toMatchObject({ connectionId: backup.id, providerMessageId: 'SM2' });
  });

  it('turns signed status callbacks into events, suppressing dead numbers and STOP replies', async () => {
    fakeTwilio();
    const { store, live, twilio } = await setup();
    const connection = await twilio('AC1');
    const message = await live.sendSms(project, { to: ['+34600111222'], body: 'x', metadata: { userId: '42' } });
    const callback = `${PUBLIC_URL}/v1/inbound/${connection.inboundToken}?relayo_message_id=${message.id}`;

    await live.handleInbound(connection.inboundToken, signed(callback, { MessageSid: 'SM1', MessageStatus: 'undelivered', To: '+34600111222', ErrorCode: '30005' }));
    const events = (await store.getMessage(project.id, message.id))!.events;
    expect(events.at(-1)).toMatchObject({ type: 'bounced', bounceType: 'hard', channel: 'sms', metadata: { userId: '42' }, recipient: '+34600111222' });
    expect(await store.suppressed(project.id, ['+34600111222'])).toEqual(new Set(['+34600111222']));

    // A wrong signature is refused.
    await expect(
      live.handleInbound(connection.inboundToken, signed(callback, { MessageSid: 'SM1', MessageStatus: 'delivered', To: '+34600111222' }, 'other')),
    ).rejects.toMatchObject({ status: 401 });

    // STOP arrives on the number's incoming webhook: no message id, but the sender is suppressed.
    const incoming = `${PUBLIC_URL}/v1/inbound/${connection.inboundToken}`;
    await live.handleInbound(connection.inboundToken, signed(incoming, { MessageSid: 'SM9', From: '+34600999888', To: '+15550001111', Body: 'STOP', OptOutType: 'STOP' }));
    expect(await store.suppressed(project.id, ['+34600999888'])).toEqual(new Set(['+34600999888']));

    // Suppressed numbers are not sent to.
    const calls = fakeTwilio();
    const again = await live.sendSms(project, { to: ['+34600999888', '+34600555444'], body: 'x' });
    expect(calls.map((c) => c.form.To)).toEqual(['+34600555444']);
    const types = (await store.getMessage(project.id, again.id))!.events.map((e) => [e.recipient, e.type]);
    expect(types).toEqual(expect.arrayContaining([['+34600999888', 'rejected'], ['+34600555444', 'accepted']]));
  });

  it('tests an SMS connection with a short message to a phone number', async () => {
    const calls = fakeTwilio();
    const { live, twilio } = await setup();
    const connection = await twilio('AC1');
    await expect(live.testConnection(project, connection.id, { to: 'ana@cliente.com' })).rejects.toMatchObject({ status: 400 });
    await live.testConnection(project, connection.id, { to: '+34600111222' });
    expect(calls[0]!.form).toMatchObject({ To: '+34600111222', Body: 'Prueba de Relayo: la conexión funciona.' });
  });
});
