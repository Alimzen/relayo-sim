import 'reflect-metadata';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { createRelayo, type BounceEvent, type RelayoEvent } from '@alimzen/core';
import { scenarioAddress, simulator } from '@alimzen/simulator';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';

/**
 * The whole loop as a user's test suite would run it: an app sends through Relayo with the simulator
 * driver, Relayo Sim plays the scenario, and its webhooks come back through relayo.handleWebhook to the
 * app's relayo.on(...) handlers.
 */
const ADMIN = 'admin';
let sim: INestApplication;
let appServer: Server;
let relayo: ReturnType<typeof createRelayo>;
const seen: RelayoEvent[] = [];

beforeAll(async () => {
  sim = await NestFactory.create(
    AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, adminToken: ADMIN }),
    { logger: false },
  );
  await sim.listen(0, '127.0.0.1');
  const simUrl = await sim.getUrl();

  // The user's app: an HTTP endpoint for webhooks, handled by Relayo.
  appServer = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const rawBody = Buffer.concat(chunks).toString('utf8');
      relayo
        .handleWebhook('email', { headers: req.headers, body: rawBody, rawBody })
        .then(() => res.writeHead(200).end())
        .catch(() => res.writeHead(401).end());
    });
  });
  await new Promise<void>((resolve) => appServer.listen(0, '127.0.0.1', resolve));
  const webhookUrl = `http://127.0.0.1:${(appServer.address() as AddressInfo).port}/webhooks/relayo`;

  const created = await fetch(`${simUrl}/v1/projects`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${ADMIN}` },
    body: JSON.stringify({ name: 'My app CI', webhookUrl }),
  });
  const project = (await created.json()) as { apiKey: string; webhookSecret: string };

  relayo = createRelayo({
    email: simulator({ apiKey: project.apiKey, baseUrl: simUrl, webhook: { secret: project.webhookSecret } }),
  });
  relayo.on('*', (event) => {
    seen.push(event);
  });
});

afterAll(async () => {
  await sim.close();
  await new Promise<void>((resolve) => appServer.close(() => resolve()));
});

const send = (to: string, metadata?: Record<string, string>) =>
  relayo.email.send({
    from: { address: 'facturas@empresa.com' },
    to: { address: to },
    subject: 'Tu factura',
    text: 'Hola',
    ...(metadata && { metadata }),
  });

describe('Relayo + simulator driver + Relayo Sim', () => {
  it('a hard bounce reaches the app\'s handlers with its messageId and metadata', async () => {
    const { messageId } = await send(scenarioAddress('hard-bounce'), { invoiceId: '42' });

    await vi.waitFor(() => expect(seen.filter((e) => e.messageId === messageId).map((e) => e.type)).toEqual(['accepted', 'bounced']));
    const bounce = seen.find((e) => e.messageId === messageId && e.type === 'bounced') as BounceEvent;
    expect(bounce).toMatchObject({ bounceType: 'hard', reason: 'user_unknown', metadata: { invoiceId: '42' }, provider: 'simulator' });
  });

  it('a blocklisted sender is reported as a block, so the app keeps the contact', async () => {
    const { messageId } = await send(scenarioAddress('blocklisted'));
    await vi.waitFor(() => expect(seen.find((e) => e.messageId === messageId && e.type === 'bounced')).toMatchObject({
      bounceType: 'block',
      reason: 'reputation_block',
    }));
  });

  it('greylisting over the API shows up as deferrals before delivery', async () => {
    const { messageId } = await send(scenarioAddress('greylist', 3));
    await vi.waitFor(() =>
      expect(seen.filter((e) => e.messageId === messageId).map((e) => e.type)).toEqual(['accepted', 'deferred', 'deferred', 'delivered']),
    );
  });

  it('suppressed recipients are rejected without delivery', async () => {
    const { messageId } = await send(scenarioAddress('suppressed'));
    await vi.waitFor(() => expect(seen.filter((e) => e.messageId === messageId)).toEqual([
      expect.objectContaining({ type: 'rejected', reason: 'suppressed' }),
    ]));
  });
});
