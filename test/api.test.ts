import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule, Lifecycle } from '../src/app.module.js';
import { webhookReceiver } from './helpers.js';

let app: INestApplication;
let base: string;
let hooks: Awaited<ReturnType<typeof webhookReceiver>>;
let apiKey: string;

const ADMIN = 'admin-token-for-tests';

beforeAll(async () => {
  hooks = await webhookReceiver();
  app = await NestFactory.create(
    AppModule.forRoot({ httpPort: 0, smtpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, adminToken: ADMIN }),
    { logger: false },
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  const created = await post('/v1/projects', { name: 'Tests', webhookUrl: hooks.url }, ADMIN);
  expect(created.status).toBe(201);
  const project = (await created.json()) as { apiKey: string; webhookSecret: string; id: string };
  apiKey = project.apiKey;
  hooks.setSecret(project.webhookSecret);
});

afterAll(async () => {
  await app.close();
  await hooks.close();
});

function post(path: string, body: unknown, token = apiKey) {
  return fetch(`${base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: JSON.stringify(body),
  });
}

function get(path: string, token = apiKey) {
  return fetch(`${base}${path}`, { headers: { authorization: `Bearer ${token}` } });
}

describe('HTTP API', () => {
  it('lists the scenario catalog without authentication', async () => {
    const body = (await (await fetch(`${base}/v1/scenarios`)).json()) as { data: Array<{ name: string }> };
    expect(body.data.map((s) => s.name)).toContain('greylist');
  });

  it('accepts a message like a provider API and plays the scenario as signed webhooks', async () => {
    const response = await post('/v1/messages', {
      from: { address: 'facturas@empresa.com' },
      to: ['hard-bounce@sim.relayo.dev'],
      subject: 'Tu factura',
      text: 'Hola',
      metadata: { facturaId: '123' },
      relayoMessageId: 'msg_api_1',
    });
    expect(response.status).toBe(202);
    const { id, status } = (await response.json()) as { id: string; status: string };
    expect(status).toBe('queued');

    await vi.waitFor(() => expect(hooks.events.filter((e) => e.messageId === 'msg_api_1')).toHaveLength(2));
    expect(hooks.events.filter((e) => e.messageId === 'msg_api_1')).toEqual([
      expect.objectContaining({ type: 'accepted', providerMessageId: id }),
      expect.objectContaining({ type: 'bounced', bounceType: 'hard', reason: 'user_unknown', metadata: { facturaId: '123' } }),
    ]);
    expect(hooks.invalid).toEqual([]);

    const timeline = (await (await get(`/v1/messages/${id}`)).json()) as { events: Array<{ type: string }>; via: string };
    expect(timeline.via).toBe('api');
    expect(timeline.events.map((e) => e.type)).toEqual(['accepted', 'bounced']);
  });

  it('lets X-Sim-Scenario pick the scenario for every recipient', async () => {
    const response = await post('/v1/messages', {
      from: 'a@empresa.com',
      to: ['ana@sim.relayo.dev'],
      subject: 's',
      headers: { 'X-Sim-Scenario': 'engaged' },
      relayoMessageId: 'msg_api_2',
    });
    expect(response.status).toBe(202);
    await vi.waitFor(() =>
      expect(hooks.events.filter((e) => e.messageId === 'msg_api_2').map((e) => e.type)).toEqual([
        'accepted',
        'delivered',
        'opened',
        'clicked',
      ]),
    );
  });

  it('lists the newest messages first', async () => {
    const body = (await (await get('/v1/messages?limit=1')).json()) as { data: Array<{ relayoMessageId: string }> };
    expect(body.data).toHaveLength(1);
    expect(body.data[0]!.relayoMessageId).toBe('msg_api_2');
  });

  it('validates input and authentication', async () => {
    expect((await post('/v1/messages', { from: 'nope', to: ['a@b.c'], subject: 's' })).status).toBe(400);
    expect((await post('/v1/messages', { from: 'a@b.c', to: [], subject: 's' })).status).toBe(400);
    expect((await post('/v1/messages', { from: 'a@b.c', to: ['x@y.z'], subject: 's' }, 'wrong')).status).toBe(401);
    expect((await post('/v1/projects', { name: 'x' }, apiKey)).status).toBe(401);
    expect((await get('/v1/messages/sim_unknown')).status).toBe(404);
  });

  it('updates the project webhook URL', async () => {
    const response = await fetch(`${base}/v1/project`, {
      method: 'PATCH',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
      body: JSON.stringify({ webhookUrl: 'ftp://nope' }),
    });
    expect(response.status).toBe(400);
    const project = (await (await get('/v1/project')).json()) as { webhookUrl: string };
    expect(project.webhookUrl).toBe(hooks.url);
  });

  it('stores the reports SMTP server, showing it without its password', async () => {
    const patch = (body: unknown) =>
      fetch(`${base}/v1/project`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${apiKey}` },
        body: JSON.stringify(body),
      });
    expect((await patch({ reportsSmtpUrl: 'http://nope' })).status).toBe(400);
    const project = (await (await patch({ reportsSmtpUrl: 'smtp://user:secret@127.0.0.1:1' })).json()) as { reportsSmtpUrl: string };
    expect(project.reportsSmtpUrl).toBe('smtp://user:****@127.0.0.1:1');
    const cleared = (await (await patch({ reportsSmtpUrl: '' })).json()) as { reportsSmtpUrl: string | null };
    expect(cleared.reportsSmtpUrl).toBeNull();
  });

  it('serves the DSN of a bounce as message/rfc822', async () => {
    const { id } = (await (
      await post('/v1/messages', { from: 'a@empresa.com', to: ['no-mx@sim.relayo.dev'], subject: 's', relayoMessageId: 'msg_dsn' })
    ).json()) as { id: string };
    await vi.waitFor(async () => {
      const detail = (await (await get(`/v1/messages/${id}`)).json()) as { events: Array<{ type: string }> };
      expect(detail.events.map((e) => e.type)).toContain('bounced');
    });
    const report = await get(`/v1/messages/${id}/events/${encodeURIComponent(`${id}:no-mx@sim.relayo.dev:001`)}/report`);
    expect(report.status).toBe(200);
    expect(report.headers.get('content-type')).toContain('message/rfc822');
    const text = await report.text();
    expect(text).toContain('Status: 5.1.2');
    expect(text).toContain('X-Relayo-Message-ID: msg_dsn');
    expect((await get(`/v1/messages/${id}/events/${encodeURIComponent(`${id}:no-mx@sim.relayo.dev:000`)}/report`)).status).toBe(404);
  });

  it('starts the SMTP server with the app', () => {
    expect(app.get(Lifecycle).smtpPort).toBeGreaterThan(0);
  });
});
