import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ScheduledSends } from '../src/api/scheduled.js';
import { AppModule } from '../src/app.module.js';

let app: INestApplication;
let base = '';
let apiKey = '';

const call = (method: string, path: string, body?: unknown) =>
  fetch(`${base}${path}`, {
    method,
    headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
    ...(body !== undefined && { body: JSON.stringify(body) }),
  });

beforeAll(async () => {
  app = await NestFactory.create(
    AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: true, secureCookies: false, adminToken: 'admin' }),
    { logger: false },
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
  const created = await fetch(`${base}/v1/admin/projects`, {
    method: 'POST',
    headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
    body: JSON.stringify({ name: 'P' }),
  });
  apiKey = ((await created.json()) as { apiKey: string }).apiKey;
});

afterAll(() => app.close());

const email = { from: 'a@empresa.com', to: ['ana@sim.relayo.dev'], subject: 'Recordatorio', text: 'Mañana a las 10' };

describe('scheduled sends', () => {
  it('stores a send with sendAt and sends it when its time comes', async () => {
    const soon = new Date(Date.now() + 60_000);
    const scheduled = await call('POST', '/v1/messages', { ...email, sendAt: soon.toISOString() });
    expect(scheduled.status).toBe(202);
    const answer = (await scheduled.json()) as { id: string; status: string; sendAt: string };
    expect(answer).toMatchObject({ status: 'scheduled', sendAt: soon.toISOString() });
    expect(answer.id).toMatch(/^sch_/);

    const pending = (await (await call('GET', '/v1/scheduled?status=pending')).json()) as { data: Array<{ id: string; summary: string; recipients: string[] }> };
    expect(pending.data).toEqual([expect.objectContaining({ id: answer.id, summary: 'Recordatorio', recipients: ['ana@sim.relayo.dev'] })]);
    expect(((await (await call('GET', '/v1/messages')).json()) as { data: unknown[] }).data).toHaveLength(0);

    // Not yet; then, once its time has come.
    const runner = app.get(ScheduledSends);
    expect(await runner.runDue(new Date())).toBe(0);
    expect(await runner.runDue(new Date(soon.getTime() + 1000))).toBe(1);
    const sent = (await (await call('GET', `/v1/scheduled/${answer.id}`)).json()) as { status: string; messageId: string };
    expect(sent.status).toBe('sent');
    const message = (await (await call('GET', `/v1/messages/${sent.messageId}`)).json()) as { subject: string };
    expect(message.subject).toBe('Recordatorio');
    expect((await call('DELETE', `/v1/scheduled/${answer.id}`)).status).toBe(409);
  });

  it('cancels a pending send, and refuses bad requests when they arrive', async () => {
    const later = new Date(Date.now() + 3_600_000).toISOString();
    const { id } = (await (await call('POST', '/v1/sms', { to: ['+12015550100'], body: 'Tu cita es mañana', sendAt: later })).json()) as { id: string };
    expect((await call('DELETE', `/v1/scheduled/${id}`)).status).toBe(204);
    expect((await call('DELETE', `/v1/scheduled/${id}`)).status).toBe(409);
    expect(await app.get(ScheduledSends).runDue(new Date(Date.now() + 2 * 3_600_000))).toBe(0);

    expect((await call('POST', '/v1/messages', { ...email, to: ['nope'], sendAt: later })).status).toBe(400);
    expect((await call('POST', '/v1/messages', { ...email, sendAt: 'mañana' })).status).toBe(400);
    expect((await call('POST', '/v1/messages', { ...email, sendAt: new Date(Date.now() + 40 * 86_400_000).toISOString() })).status).toBe(400);
  });

  it('records why a send failed when its time came', async () => {
    await call('POST', '/v1/project/templates', { alias: 'aviso', subject: 'Aviso', text: 'Hola {{nombre}}' });
    const { id } = (await (
      await call('POST', '/v1/messages', { from: 'a@empresa.com', to: ['ana@sim.relayo.dev'], template: 'aviso', variables: { nombre: 'Ana' }, sendAt: new Date().toISOString() })
    ).json()) as { id: string };
    // The template is gone by the time it is sent.
    await call('DELETE', '/v1/project/templates/aviso');
    await app.get(ScheduledSends).runDue(new Date(Date.now() + 1000));
    const failed = (await (await call('GET', `/v1/scheduled/${id}`)).json()) as { status: string; error: string };
    expect(failed).toMatchObject({ status: 'failed', error: expect.stringContaining('aviso') });
  });
});
