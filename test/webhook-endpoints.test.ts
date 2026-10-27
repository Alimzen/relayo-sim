import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { WebhookAttempt } from '../src/domain.js';
import { SIM_STORE, type SimStore } from '../src/store/store.js';
import { webhookReceiver } from './helpers.js';

async function eventually<T>(read: () => T | Promise<T>, until: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 100; i++) {
    const value = await read();
    if (until(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return read();
}

describe('webhook endpoints', () => {
  it('sends each event to the main URL and to the endpoints that want it, each signed with its own secret', async () => {
    const app = await NestFactory.create(
      AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: false, secureCookies: false, adminToken: 'admin' }),
      { logger: false },
    );
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const main = await webhookReceiver();
    const bounces = await webhookReceiver();
    const off = await webhookReceiver();
    try {
      const admin = (method: string, path: string, body?: unknown) =>
        fetch(`${base}${path}`, {
          method,
          headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
      const project = (await (await admin('POST', '/v1/admin/projects', { name: 'Hooks', webhookUrl: main.url })).json()) as {
        id: string;
        apiKey: string;
        webhookSecret: string;
      };
      main.setSecret(project.webhookSecret);
      const call = (method: string, path: string, body?: unknown) =>
        fetch(`${base}${path}`, {
          method,
          headers: { authorization: `Bearer ${project.apiKey}`, 'content-type': 'application/json' },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });

      const created = await call('POST', '/v1/project/webhook/endpoints', { url: bounces.url, description: 'CRM', events: ['bounced'], mode: 'test' });
      expect(created.status).toBe(201);
      const endpoint = (await created.json()) as { id: string; secret: string; events: string[]; mode: string };
      expect(endpoint).toMatchObject({ events: ['bounced'], mode: 'test', secret: expect.stringMatching(/^whsec_/) });
      bounces.setSecret(endpoint.secret);
      const disabled = (await (await call('POST', '/v1/project/webhook/endpoints', { url: off.url })).json()) as { id: string; secret: string };
      off.setSecret(disabled.secret);
      expect((await call('PATCH', `/v1/project/webhook/endpoints/${disabled.id}`, { enabled: false })).status).toBe(200);
      expect((await call('POST', '/v1/project/webhook/endpoints', { url: 'ftp://x' })).status).toBe(400);
      expect((await call('POST', '/v1/project/webhook/endpoints', { url: bounces.url, events: ['nope'] })).status).toBe(400);
      // The secret is only for the panel.
      expect((await call('GET', `/v1/project/webhook/endpoints/${endpoint.id}/secret`)).status).toBe(403);

      await call('POST', '/v1/messages', { from: 'a@empresa.com', to: ['hard-bounce@sim.relayo.dev'], subject: 's', text: 't' });
      await eventually(() => main.events.length, (n) => n >= 2);
      await eventually(() => bounces.events.length, (n) => n >= 1);
      expect(main.events.map((e) => e.type)).toEqual(['accepted', 'bounced']);
      expect(bounces.events.map((e) => e.type)).toEqual(['bounced']);
      expect(off.events).toEqual([]);
      expect([...main.invalid, ...bounces.invalid]).toEqual([]);

      // The log says where each try went, and can show one endpoint's.
      const forEndpoint = (await (await call('GET', `/v1/project/webhook/deliveries?endpoint=${endpoint.id}`)).json()) as { data: WebhookAttempt[] };
      expect(forEndpoint.data.map((a) => [a.eventType, a.endpointId])).toEqual([['bounced', endpoint.id]]);
      const forMain = (await (await call('GET', '/v1/project/webhook/deliveries?endpoint=main')).json()) as { data: WebhookAttempt[] };
      expect(forMain.data).toHaveLength(2);

      // A test event to one endpoint.
      const test = (await (await call('POST', '/v1/project/webhook/test', { endpoint: endpoint.id })).json()) as WebhookAttempt;
      expect(test).toMatchObject({ ok: true, endpointId: endpoint.id, trigger: 'test' });

      // Batch redelivery: the events whose last try failed for good go again, each to its endpoint.
      const store = app.get<SimStore>(SIM_STORE);
      const bounced = forEndpoint.data[0]!;
      const accepted = forMain.data.find((a) => a.eventType === 'accepted')!;
      // Newer than the real tries, so they are each event's latest.
      const attempt = (id: string, from: WebhookAttempt, secondsAhead: number, ok = false): WebhookAttempt => {
        const { endpointId: _e, ...rest } = from;
        return {
          ...rest,
          projectId: project.id,
          ...(from.endpointId && { endpointId: from.endpointId }),
          id,
          ok,
          willRetry: false,
          trigger: 'auto',
          statusCode: ok ? 200 : 500,
          createdAt: new Date(Date.now() + secondsAhead * 1000),
        };
      };
      const mainBounced = forMain.data.find((a) => a.eventType === 'bounced')!;
      await store.addWebhookAttempt(attempt('wha_crm_failed', bounced, 1));
      await store.addWebhookAttempt(attempt('wha_main_failed', mainBounced, 1));
      // Failed, then delivered by a redelivery: not again.
      await store.addWebhookAttempt(attempt('wha_old', accepted, 1));
      await store.addWebhookAttempt(attempt('wha_fixed', accepted, 2, true));

      const before = { main: main.events.length, crm: bounces.events.length };
      const since = new Date(Date.now() - 3_600_000).toISOString();
      expect((await call('POST', '/v1/project/webhook/redeliver', {})).status).toBe(400);
      const redelivered = await call('POST', '/v1/project/webhook/redeliver', { since });
      expect(redelivered.status).toBe(202);
      expect(await redelivered.json()).toEqual({ events: 2 });
      await eventually(() => main.events.length + bounces.events.length, (n) => n >= before.main + before.crm + 2);
      expect(main.events.length).toBe(before.main + 1);
      expect(bounces.events.length).toBe(before.crm + 1);
      expect(main.events.at(-1)?.type).toBe('bounced');

      expect((await call('DELETE', `/v1/project/webhook/endpoints/${endpoint.id}`)).status).toBe(204);
      const left = (await (await call('GET', '/v1/project/webhook/endpoints')).json()) as { data: Array<{ id: string; enabled: boolean }> };
      expect(left.data).toEqual([expect.objectContaining({ id: disabled.id, enabled: false })]);
      expect(JSON.stringify(left)).not.toContain('whsec_');
    } finally {
      await Promise.all([main.close(), bounces.close(), off.close()]);
      await app.close();
    }
  });
});
