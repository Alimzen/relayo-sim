import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

describe('plans per project', () => {
  it('lets an admin set a project its own limits, and the sends follow them', async () => {
    const app = await NestFactory.create(
      AppModule.forRoot({
        httpPort: 0,
        host: '127.0.0.1',
        timeScale: 0,
        maxHangMs: 300,
        signup: true,
        secureCookies: false,
        adminToken: 'admin',
        retentionDays: 7,
        limits: { monthlyMessages: 100, messagesPerMinute: 0, liveMonthlyMessages: 0 },
      }),
      { logger: false },
    );
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const admin = (method: string, path: string, body?: unknown) =>
      fetch(`${base}${path}`, {
        method,
        headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
    try {
      const create = async (name: string) => (await (await admin('POST', '/v1/admin/projects', { name })).json()) as { id: string; apiKey: string };
      const small = await create('Pequeño');
      const other = await create('Otro');
      const send = (key: string) =>
        fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: 'a@empresa.com', to: ['ana@sim.relayo.dev'], subject: 's', text: 't' }),
        });

      const updated = await admin('PATCH', `/v1/admin/plans/${small.id}`, { monthlyMessages: 1, retentionDays: 30 });
      expect(updated.status).toBe(200);
      expect(await updated.json()).toMatchObject({ plan: { monthlyMessages: 1, retentionDays: 30 }, effective: { monthlyMessages: 1, retentionDays: 30 } });
      expect((await admin('PATCH', `/v1/admin/plans/${small.id}`, { monthlyMessages: -1 })).status).toBe(400);

      expect((await send(small.apiKey)).status).toBe(202);
      expect((await send(small.apiKey)).status).toBe(429);
      expect((await send(other.apiKey)).status).toBe(202);
      expect((await send(other.apiKey)).status).toBe(202);

      // The project sees its own plan.
      const usage = (await (await fetch(`${base}/v1/project/usage`, { headers: { authorization: `Bearer ${small.apiKey}` } })).json()) as {
        limits: { monthlyMessages: number };
        retentionDays: number;
      };
      expect(usage).toMatchObject({ limits: { monthlyMessages: 1 }, retentionDays: 30 });

      const list = (await (await admin('GET', '/v1/admin/plans?q=Peque')).json()) as {
        defaults: { monthlyMessages: number; retentionDays: number };
        data: Array<{ project: { id: string }; usage: { messages: number } }>;
      };
      expect(list.defaults).toMatchObject({ monthlyMessages: 100, retentionDays: 7 });
      expect(list.data).toEqual([expect.objectContaining({ project: expect.objectContaining({ id: small.id }), usage: { messages: 1, live: 0 } })]);

      // null goes back to the platform's value.
      await admin('PATCH', `/v1/admin/plans/${small.id}`, { monthlyMessages: null, retentionDays: null });
      expect((await send(small.apiKey)).status).toBe(202);
    } finally {
      await app.close();
    }
  });
});
