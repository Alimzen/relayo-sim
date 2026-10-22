import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { webhookReceiver } from './helpers.js';

/** An SMTP server standing in for the customer's provider: it records what it receives. */
async function fakeProvider() {
  const received: Array<{ from: string; to: string[]; raw: string }> = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({
          from: session.envelope.mailFrom ? session.envelope.mailFrom.address : '',
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { received, port: (server.server.address() as AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

let app: INestApplication;
let base: string;
let provider: Awaited<ReturnType<typeof fakeProvider>>;
let hooks: Awaited<ReturnType<typeof webhookReceiver>>;
let cookie = '';
let projectId = '';
let liveKey = '';
let testKey = '';

/** The panel: session cookie, project header, and the mode it looks at. */
async function panel(method: string, path: string, body?: unknown, mode: 'test' | 'live' = 'test') {
  const response = await fetch(`${base}${path}`, {
    method,
    headers: {
      ...(body !== undefined && { 'content-type': 'application/json' }),
      cookie,
      'x-relayo-client': 'panel',
      'x-relayo-project': projectId,
      'x-relayo-mode': mode,
    },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });
  const setCookie = response.headers.get('set-cookie');
  if (setCookie) cookie = setCookie.split(';')[0]!;
  return response;
}

function api(key: string, path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

const email = (to: string[], extra: Record<string, unknown> = {}) => ({
  from: { address: 'facturas@empresa.com', name: 'Empresa' },
  to,
  subject: 'Tu factura',
  text: 'Hola',
  html: '<p>Hola</p>',
  metadata: { facturaId: '123' },
  ...extra,
});

beforeAll(async () => {
  provider = await fakeProvider();
  hooks = await webhookReceiver();
  app = await NestFactory.create(
    AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: true, secureCookies: false, secretsKey: 'live-test-key' }),
    { logger: false },
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  const signup = await panel('POST', '/v1/auth/signup', { email: `live${Date.now()}@empresa.com`, name: 'Ana', password: 'una-clave-larga-1' });
  projectId = ((await signup.json()) as { projects: Array<{ id: string }> }).projects[0]!.id;
  liveKey = ((await (await panel('POST', '/v1/project/keys', { name: 'Producción', mode: 'live' })).json()) as { apiKey: string }).apiKey;
  testKey = ((await (await panel('POST', '/v1/project/keys', { name: 'CI' })).json()) as { apiKey: string }).apiKey;
  await panel('PATCH', '/v1/project', { webhookUrl: hooks.url });
  hooks.setSecret(((await (await panel('GET', '/v1/project/webhook-secret')).json()) as { webhookSecret: string }).webhookSecret);
});

afterAll(async () => {
  await app.close();
  await provider.close();
  await hooks.close();
});

describe('live mode', () => {
  it('creates live and test keys with their own prefixes', () => {
    expect(liveKey).toMatch(/^rly_live_/);
    expect(testKey).toMatch(/^rly_test_/);
  });

  it('refuses live sends until the project has a connection, with a clear message', async () => {
    const response = await api(liveKey, '/v1/messages', email(['ana@cliente.com']));
    expect(response.status).toBe(400);
    expect(((await response.json()) as { message: string }).message).toContain('Conexiones');
  });

  it('keeps provider credentials secret', async () => {
    const created = await panel('POST', '/v1/project/connections', {
      name: 'Postmark',
      provider: 'postmark',
      values: { serverToken: 'pm-secret-token', messageStream: 'outbound' },
    });
    expect(created.status).toBe(201);
    const listed = await (await panel('GET', '/v1/project/connections')).text();
    expect(listed).not.toContain('pm-secret-token');
    expect(JSON.parse(listed).data[0]).toMatchObject({ provider: 'postmark', secretsSet: ['serverToken'], settings: { messageStream: 'outbound' } });
    expect((await panel('POST', '/v1/project/connections', { provider: 'ses', values: { region: 'eu-west-1' } })).status).toBe(400);
  });

  it('delivers through the first working connection, failing over, and reports the event', async () => {
    const connections = (await (await panel('GET', '/v1/project/connections')).json()) as { data: Array<{ id: string }> };
    const broken = (await (
      await panel('POST', '/v1/project/connections', { name: 'Caído', provider: 'smtp', values: { host: '127.0.0.1', port: '1', security: 'none' } })
    ).json()) as { id: string };
    const working = (await (
      await panel('POST', '/v1/project/connections', { name: 'Local', provider: 'smtp', values: { host: '127.0.0.1', port: String(provider.port), security: 'none' } })
    ).json()) as { id: string };
    // The broken one first, then the working one; Postmark (fake token) last.
    expect((await panel('POST', '/v1/project/connections/order', { ids: [broken.id, working.id, connections.data[0]!.id] })).status).toBe(204);

    const response = await api(liveKey, '/v1/messages', email(['ana@cliente.com'], { relayoMessageId: 'msg_live_1' }));
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as { id: string };

    expect(provider.received).toHaveLength(1);
    expect(provider.received[0]!.to).toEqual(['ana@cliente.com']);
    expect(provider.received[0]!.raw).toContain(`X-Relayo-Message-ID: ${id}`);

    await vi.waitFor(() => expect(hooks.events.find((e) => e.messageId === 'msg_live_1')).toMatchObject({ type: 'accepted', provider: 'relayo' }));
    const detail = (await (await panel('GET', `/v1/messages/${id}`, undefined, 'live')).json()) as { mode: string; delivery: { connectionId: string } };
    expect(detail).toMatchObject({ mode: 'live', delivery: { connectionId: working.id, provider: 'smtp' } });
  });

  it('turns provider webhooks into Relayo events, and suppresses hard bounces', async () => {
    const response = await api(liveKey, '/v1/messages', email(['noexiste@cliente.com'], { relayoMessageId: 'msg_live_2' }));
    const { id } = (await response.json()) as { id: string };
    const postmark = ((await (await panel('GET', '/v1/project/connections')).json()) as { data: Array<{ provider: string; inboundPath: string }> }).data.find(
      (c) => c.provider === 'postmark',
    )!;

    const bounce = {
      RecordType: 'Bounce',
      ID: 692560173,
      Type: 'HardBounce',
      TypeCode: 1,
      MessageID: 'pm-883953f4',
      Metadata: { relayo_message_id: id },
      Details: 'smtp;550 5.1.1 The email account that you tried to reach does not exist',
      Email: 'noexiste@cliente.com',
      BouncedAt: new Date().toISOString(),
    };
    const inbound = await fetch(`${base}${postmark.inboundPath}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bounce) });
    expect(inbound.status).toBe(200);
    expect(await inbound.json()).toEqual({ received: 1 });

    await vi.waitFor(() =>
      expect(hooks.events.find((e) => e.messageId === 'msg_live_2' && e.type === 'bounced')).toMatchObject({ bounceType: 'hard', provider: 'relayo', metadata: { facturaId: '123' } }),
    );
    const suppressions = (await (await panel('GET', '/v1/project/suppressions')).json()) as { data: Array<{ address: string; reason: string }> };
    expect(suppressions.data).toContainEqual(expect.objectContaining({ address: 'noexiste@cliente.com', reason: 'hard_bounce' }));

    // The next send skips the suppressed address: rejected, never handed to the provider.
    const before = provider.received.length;
    await api(liveKey, '/v1/messages', email(['noexiste@cliente.com'], { relayoMessageId: 'msg_live_3' }));
    expect(provider.received.length).toBe(before);
    await vi.waitFor(() => expect(hooks.events.find((e) => e.messageId === 'msg_live_3')).toMatchObject({ type: 'rejected', reason: 'suppressed' }));

    expect((await fetch(`${base}/v1/inbound/not-a-token`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(404);
  });

  it('keeps test and live apart: test keys still simulate, and each mode lists its own messages', async () => {
    const before = provider.received.length;
    const simulated = await api(testKey, '/v1/messages', email(['hard-bounce@sim.relayo.dev'], { relayoMessageId: 'msg_test_1' }));
    expect(simulated.status).toBe(202);
    expect(provider.received.length).toBe(before);

    const live = (await (await panel('GET', '/v1/messages', undefined, 'live')).json()) as { data: Array<{ relayoMessageId?: string }> };
    const test = (await (await panel('GET', '/v1/messages', undefined, 'test')).json()) as { data: Array<{ relayoMessageId?: string }> };
    expect(live.data.map((m) => m.relayoMessageId)).toEqual(expect.arrayContaining(['msg_live_1', 'msg_live_2']));
    expect(live.data.map((m) => m.relayoMessageId)).not.toContain('msg_test_1');
    expect(test.data.map((m) => m.relayoMessageId)).toEqual(['msg_test_1']);
  });

  it('sends a real test email through one connection', async () => {
    const working = ((await (await panel('GET', '/v1/project/connections')).json()) as { data: Array<{ id: string; name: string }> }).data.find((c) => c.name === 'Local')!;
    const response = await panel('POST', `/v1/project/connections/${working.id}/test`, { to: 'yo@empresa.com', from: 'pruebas@empresa.com' });
    expect(response.status).toBe(201);
    expect(provider.received.at(-1)).toMatchObject({ to: ['yo@empresa.com'] });
    expect((await panel('POST', `/v1/project/connections/${working.id}/test`, { to: 'yo@empresa.com' })).status).toBe(400);
  });

  it('only lets a signed-in person manage connections', async () => {
    const response = await fetch(`${base}/v1/project/connections`, {
      method: 'POST',
      headers: { authorization: `Bearer ${liveKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ provider: 'smtp', values: { host: 'x', port: '25' } }),
    });
    expect(response.status).toBe(403);
  });
});
