import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

describe('Idempotency-Key', () => {
  it('answers a repeated send with the first answer, without sending again', async () => {
    const app = await NestFactory.create(
      AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: true, secureCookies: false, adminToken: 'admin' }),
      { logger: false },
    );
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    try {
      const created = await fetch(`${base}/v1/admin/projects`, {
        method: 'POST',
        headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'P' }),
      });
      const { apiKey } = (await created.json()) as { apiKey: string };
      const send = (body: unknown, key?: string, path = '/v1/messages') =>
        fetch(`${base}${path}`, {
          method: 'POST',
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json', ...(key && { 'idempotency-key': key }) },
          body: JSON.stringify(body),
        });
      const email = { from: 'a@empresa.com', to: ['ana@sim.relayo.dev'], subject: 'Factura', text: 'x' };

      const first = await send(email, 'factura-42');
      const firstBody = (await first.json()) as { id: string };
      expect(first.status).toBe(202);
      const again = await send(email, 'factura-42');
      expect(again.status).toBe(202);
      expect(again.headers.get('idempotent-replayed')).toBe('true');
      expect(await again.json()).toEqual(firstBody);

      // Only one message was stored.
      const list = await fetch(`${base}/v1/messages`, { headers: { authorization: `Bearer ${apiKey}` } });
      expect(((await list.json()) as { data: unknown[] }).data).toHaveLength(1);

      expect((await send({ ...email, subject: 'Otra' }, 'factura-42')).status).toBe(422);
      expect((await send(email, 'factura-43')).status).toBe(202);
      expect((await send(email)).status).toBe(202);

      // A failed request frees its key.
      expect((await send({ ...email, from: 'nope' }, 'mal')).status).toBe(400);
      expect((await send(email, 'mal')).status).toBe(202);

      // SMS too, and a key is per endpoint.
      const sms = { to: ['+12015550100'], body: 'Código 1234' };
      const smsFirst = (await (await send(sms, 'otp-1', '/v1/sms')).json()) as { id: string };
      expect(await (await send(sms, 'otp-1', '/v1/sms')).json()).toEqual(smsFirst);
      expect((await send(email, 'otp-1')).status).toBe(422);
    } finally {
      await app.close();
    }
  });
});
