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
    AppModule.forRoot({ httpPort: 0, smtpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, adminToken: ADMIN, signup: true, secureCookies: false }),
    { logger: false },
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();

  const created = await post('/v1/admin/projects', { name: 'Tests', webhookUrl: hooks.url }, ADMIN);
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
    expect((await post('/v1/admin/projects', { name: 'x' }, apiKey)).status).toBe(401);
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

  it('captures API sends as the email a provider would send, with bodies, headers and attachments', async () => {
    const pixel = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR4nGNgYPgPAAEDAQAIicLsAAAAAElFTkSuQmCC', 'base64');
    const { id } = (await (
      await post('/v1/messages', {
        from: { address: 'facturas@empresa.com', name: 'Empresa, S.A.' },
        to: ['ana@sim.relayo.dev'],
        cc: [{ address: 'copia@sim.relayo.dev' }],
        bcc: ['oculta@sim.relayo.dev'],
        replyTo: 'soporte@empresa.com',
        subject: 'Tu factura de octubre',
        text: 'Hola Ana',
        html: '<p>Hola <b>Ana</b></p><img src="cid:logo@empresa">',
        headers: { 'X-Campaign': 'octubre' },
        attachments: [
          { filename: 'factura.pdf', content: Buffer.from('%PDF-1.4 fake').toString('base64'), contentType: 'application/pdf' },
          { filename: 'logo.png', content: pixel.toString('base64'), contentType: 'image/png', cid: 'logo@empresa' },
        ],
        metadata: { facturaId: '123' },
        relayoMessageId: 'msg_capture',
      })
    ).json()) as { id: string };

    const detail = (await (await get(`/v1/messages/${id}`)).json()) as { size: number; headers: Record<string, string> };
    expect(detail.size).toBeGreaterThan(0);
    expect(detail.headers['x-relayo-message-id']).toBe('msg_capture');

    const content = (await (await get(`/v1/messages/${id}/content`)).json()) as {
      from: string; to: string; cc: string; replyTo: string; subject: string; text: string; html: string;
      headers: Array<{ name: string; value: string }>;
      attachments: Array<{ index: number; filename: string; contentType: string; size: number; inline: boolean }>;
    };
    expect(content).toMatchObject({
      from: '"Empresa, S.A." <facturas@empresa.com>',
      to: 'ana@sim.relayo.dev',
      cc: 'copia@sim.relayo.dev',
      replyTo: 'soporte@empresa.com',
      subject: 'Tu factura de octubre',
      text: 'Hola Ana',
    });
    expect(content.html).toContain('<b>Ana</b>');
    expect(content.html).toContain(`src="data:image/png;base64,${pixel.toString('base64')}"`);
    expect(content.headers).toContainEqual({ name: 'X-Campaign', value: 'octubre' });
    expect(content.headers.map((h) => h.name.toLowerCase())).not.toContain('bcc');
    const pdf = content.attachments.find((a) => a.filename === 'factura.pdf');
    expect(pdf).toMatchObject({ contentType: 'application/pdf', size: 13, inline: false });
    expect(content.attachments.find((a) => a.filename === 'logo.png')).toMatchObject({ contentType: 'image/png', size: pixel.length, inline: true });

    const file = await get(`/v1/messages/${id}/attachments/${pdf!.index}`);
    expect(file.headers.get('content-type')).toBe('application/octet-stream');
    expect(file.headers.get('content-disposition')).toContain('factura.pdf');
    expect(Buffer.from(await file.arrayBuffer()).toString()).toBe('%PDF-1.4 fake');
    expect((await get(`/v1/messages/${id}/attachments/9`)).status).toBe(404);

    const raw = await get(`/v1/messages/${id}/raw`);
    expect(raw.headers.get('content-type')).toContain('message/rfc822');
    expect(await raw.text()).toContain('Subject: Tu factura de octubre');
  });

  it('refuses malformed attachments', async () => {
    const response = await post('/v1/messages', { from: 'a@b.co', to: ['ana@sim.relayo.dev'], subject: 's', attachments: [{ filename: 'x' }] });
    expect(response.status).toBe(400);
  });

  it('sends SMS like a provider API, each number playing its scenario as signed webhooks', async () => {
    const response = await post('/v1/sms', {
      from: 'Empresa',
      to: ['+12015550101', '+12015550105', '+34600111222'],
      body: 'Tu código es 1234',
      metadata: { pedido: '77' },
      relayoMessageId: 'msg_sms_1',
    });
    expect(response.status).toBe(202);
    const { id } = (await response.json()) as { id: string };

    const ofSms = () => hooks.events.filter((e) => e.messageId === 'msg_sms_1');
    await vi.waitFor(() => expect(ofSms().map((e) => `${e.recipient}:${e.type}`)).toEqual(expect.arrayContaining([
      '+12015550101:bounced',
      '+12015550105:unsubscribed',
      '+34600111222:delivered',
    ])));
    expect(ofSms().every((e) => e.channel === 'sms' && e.metadata?.pedido === '77')).toBe(true);
    expect(ofSms().find((e) => e.type === 'bounced')).toMatchObject({ bounceType: 'hard', reason: 'user_unknown' });
    expect(hooks.invalid).toEqual([]);

    const detail = (await (await get(`/v1/messages/${id}`)).json()) as { channel: string; body: string; from: string; recipients: Array<{ scenario: { name: string; source: string } }> };
    expect(detail).toMatchObject({ channel: 'sms', body: 'Tu código es 1234', from: 'Empresa' });
    expect(detail.recipients.map((r) => r.scenario)).toEqual([
      { name: 'invalid-number', source: 'number' },
      { name: 'opt-out', source: 'number' },
      { name: 'delivered', source: 'default' },
    ]);
    const smsOnly = (await (await get('/v1/messages?channel=sms&q=1234')).json()) as { data: Array<{ id: string }> };
    expect(smsOnly.data.map((m) => m.id)).toEqual([id]);
    expect((await get(`/v1/messages/${id}/events/${encodeURIComponent(`${id}:+12015550101:001`)}/report`)).status).toBe(404);
  });

  it('lets an SMS pick its scenario with a field, and validates SMS requests', async () => {
    const forced = await post('/v1/sms', { to: '+34600111222', body: 'Hola', scenario: 'carrier-filtered', relayoMessageId: 'msg_sms_2' });
    expect(forced.status).toBe(202);
    await vi.waitFor(() =>
      expect(hooks.events.find((e) => e.messageId === 'msg_sms_2' && e.type === 'bounced')).toMatchObject({ bounceType: 'block', reason: 'content_rejected' }),
    );
    expect((await post('/v1/sms', { to: '600111222', body: 'x' })).status).toBe(400);
    expect((await post('/v1/sms', { to: '+34600111222', body: '' })).status).toBe(400);
    expect((await post('/v1/sms', { to: '+34600111222', body: 'x', from: 'UnNombreMuyLargo' })).status).toBe(400);
    expect((await post('/v1/sms', { to: '+34600111222', body: 'x', scenario: 'nope' })).status).toBe(400);

    const scenarios = (await (await fetch(`${base}/v1/scenarios`)).json()) as { data: Array<{ name: string; channel: string; example: string }> };
    expect(scenarios.data).toContainEqual(expect.objectContaining({ name: 'landline', channel: 'sms', example: '+12015550102' }));
    expect(scenarios.data).toContainEqual(expect.objectContaining({ name: 'greylist', channel: 'email' }));
  });

  it('starts the SMTP server with the app', () => {
    expect(app.get(Lifecycle).smtpPort).toBeGreaterThan(0);
  });
});
