import 'reflect-metadata';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { SimEvent, WebhookAttempt } from '../src/domain.js';
import { MemoryDispatcher } from '../src/webhooks/webhooks.js';

/** An endpoint that answers each request with the next status of a list (the last one repeats). */
async function endpoint(statuses: number[]) {
  const received: Array<{ headers: Record<string, unknown>; body: string }> = [];
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      received.push({ headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
      const status = statuses[Math.min(received.length - 1, statuses.length - 1)]!;
      res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify({ status }));
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/hooks`,
    received,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

const event: SimEvent = {
  id: 'sim_1:ana@x.com:bounced',
  type: 'bounced',
  channel: 'email',
  provider: 'relayo',
  messageId: 'msg_1',
  providerMessageId: 'sim_1',
  recipient: 'ana@x.com',
  timestamp: new Date(),
  raw: {},
  projectId: 'prj_1',
  bounceType: 'hard',
  reason: 'user_unknown',
} as SimEvent;

describe('webhook delivery log', () => {
  it('records every try with its answer, and whether another one follows', async () => {
    const hooks = await endpoint([500, 503, 200]);
    const log: WebhookAttempt[] = [];
    const dispatcher = new MemoryDispatcher({ attempts: 5, delayMs: () => 5 }, fetch, async (a) => void log.push(a));
    try {
      await dispatcher.dispatch(event, { url: hooks.url, secret: 's' });
      await expect.poll(() => log.length).toBe(3);
      expect(log.map((a) => [a.attempt, a.statusCode, a.ok, a.willRetry])).toEqual([
        [1, 500, false, true],
        [2, 503, false, true],
        [3, 200, true, false],
      ]);
      expect(log[0]).toMatchObject({ eventId: event.id, eventType: 'bounced', recipient: 'ana@x.com', trigger: 'auto', maxAttempts: 5, responseBody: '{"status":500}' });
    } finally {
      await dispatcher.stop();
      await hooks.close();
    }
  });

  it('says why a try got no answer', async () => {
    const log: WebhookAttempt[] = [];
    const dispatcher = new MemoryDispatcher({ attempts: 1, delayMs: () => 5 }, fetch, async (a) => void log.push(a));
    // A port that was just free: nothing listens there.
    const gone = await endpoint([200]);
    await gone.close();
    await dispatcher.dispatch(event, { url: gone.url, secret: 's' });
    expect(log[0]).toMatchObject({ ok: false, willRetry: false, error: expect.stringMatching(/ECONNREFUSED/) });
    expect(log[0]!.statusCode).toBeUndefined();
  });

  it('shows deliveries in the API, sends test events and redelivers', async () => {
    const hooks = await endpoint([200]);
    const app = await NestFactory.create(
      AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: true, secureCookies: false }),
      { logger: false },
    );
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    let cookie = '';
    let projectId = '';
    const call = async (method: string, path: string, body?: unknown) => {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', cookie, 'x-relayo-client': 'panel', 'x-relayo-project': projectId },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      return response;
    };
    try {
      const signup = await call('POST', '/v1/auth/signup', { email: `w${Date.now()}@empresa.com`, name: 'Ana', password: 'una-clave-larga-1' });
      projectId = ((await signup.json()) as { projects: Array<{ id: string }> }).projects[0]!.id;

      expect((await call('POST', '/v1/project/webhook/test')).status).toBe(400);
      await call('PATCH', '/v1/project', { webhookUrl: hooks.url });

      const test = (await (await call('POST', '/v1/project/webhook/test')).json()) as WebhookAttempt;
      expect(test).toMatchObject({ trigger: 'test', ok: true, statusCode: 200, eventType: 'delivered' });
      expect(hooks.received[0]!.headers['relayo-test']).toBe('true');

      // A simulated message: its events reach the webhook and the log.
      await call('POST', '/v1/messages', { from: 'a@empresa.com', to: ['hard-bounce@sim.relayo.dev'], subject: 'Hola', text: 'x' });
      let deliveries: WebhookAttempt[] = [];
      await expect
        .poll(async () => {
          deliveries = ((await (await call('GET', '/v1/project/webhook/deliveries')).json()) as { data: WebhookAttempt[] }).data;
          return deliveries.some((d) => d.eventType === 'bounced');
        })
        .toBe(true);
      const bounce = deliveries.find((d) => d.eventType === 'bounced')!;
      expect(bounce).toMatchObject({ trigger: 'auto', ok: true, recipient: 'hard-bounce@sim.relayo.dev' });

      const detail = (await (await call('GET', `/v1/project/webhook/deliveries/${bounce.id}`)).json()) as { event: { type: string; bounceType: string } };
      expect(detail.event).toMatchObject({ type: 'bounced', bounceType: 'hard' });

      const again = (await (await call('POST', `/v1/project/webhook/deliveries/${bounce.id}/redeliver`)).json()) as WebhookAttempt;
      expect(again).toMatchObject({ trigger: 'redeliver', ok: true, eventId: bounce.eventId });

      const stats = (await (await call('GET', '/v1/project/webhook/stats')).json()) as { ok: number; failed: number };
      expect(stats.ok).toBeGreaterThanOrEqual(3);
      expect(stats.failed).toBe(0);
      expect(((await (await call('GET', '/v1/project/webhook/deliveries?status=failed')).json()) as { data: unknown[] }).data).toEqual([]);
    } finally {
      await app.close();
      await hooks.close();
    }
  });
});
