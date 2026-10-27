import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

interface Item {
  index: number;
  id?: string;
  status: string;
  error?: { statusCode: number; message: string };
}

describe('batch sends', () => {
  it('sends many emails and SMS in one request, each with its own variables, failing one by one', async () => {
    const app = await NestFactory.create(
      AppModule.forRoot({
        httpPort: 0,
        host: '127.0.0.1',
        timeScale: 0,
        maxHangMs: 300,
        signup: true,
        secureCookies: false,
        adminToken: 'admin',
      }),
      { logger: false },
    );
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    try {
      let cookie = '';
      let projectId = '';
      const panel = async (method: string, path: string, body?: unknown) => {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { 'content-type': 'application/json', cookie, 'x-relayo-client': 'panel', 'x-relayo-project': projectId },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
        cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
        return response;
      };
      const signup = await panel('POST', '/v1/auth/signup', { email: 'ana-batch@empresa.com', name: 'Ana', password: 'una-clave-larga-1' });
      projectId = ((await signup.json()) as { projects: Array<{ id: string }> }).projects[0]!.id;
      const full = (await (await panel('POST', '/v1/project/keys', { name: 'Servidor' })).json()) as { apiKey: string };
      const limited = (await (await panel('POST', '/v1/project/keys', { name: 'Envíos', permission: 'send', allowedDomains: ['empresa.com'] })).json()) as {
        apiKey: string;
      };
      const call = (key: string, method: string, path: string, body?: unknown, headers: Record<string, string> = {}) =>
        fetch(`${base}${path}`, {
          method,
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json', ...headers },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
      await call(full.apiKey, 'POST', '/v1/project/templates', { alias: 'aviso', subject: 'Hola {{nombre}}', text: 'Tu pedido {{pedido}}' });

      const batch = await call(full.apiKey, 'POST', '/v1/messages/batch', {
        from: 'avisos@empresa.com',
        subject: 'Hola {{nombre}}',
        html: '<p>Hola {{nombre}}</p>',
        metadata: { campaign: 'octubre' },
        messages: [
          { to: 'ana@sim.relayo.dev', variables: { nombre: 'Ana' } },
          { to: 'luis@sim.relayo.dev', variables: { nombre: '<Luis>' }, metadata: { user: '7' } },
          { to: 'eva@sim.relayo.dev' },
          { to: 'no-es-un-email', variables: { nombre: 'X' } },
          { to: 'marta@sim.relayo.dev', template: 'aviso', variables: { nombre: 'Marta', pedido: 'A-1' } },
          { to: 'pablo@sim.relayo.dev', variables: { nombre: 'Pablo' }, sendAt: new Date(Date.now() + 3_600_000).toISOString() },
        ],
      });
      expect(batch.status).toBe(202);
      const items = ((await batch.json()) as { data: Item[] }).data;
      expect(items.map((i) => [i.index, i.status])).toEqual([
        [0, 'queued'],
        [1, 'queued'],
        [2, 'failed'],
        [3, 'failed'],
        [4, 'queued'],
        [5, 'scheduled'],
      ]);
      expect(items[2]!.error).toEqual({ statusCode: 400, message: expect.stringContaining('nombre') });
      expect(items[3]!.error?.statusCode).toBe(400);

      const show = async (id: string) =>
        (await (await call(full.apiKey, 'GET', `/v1/messages/${id}`)).json()) as { subject: string; metadata?: Record<string, string> };
      expect(await show(items[0]!.id!)).toMatchObject({ subject: 'Hola Ana', metadata: { campaign: 'octubre' } });
      expect(await show(items[1]!.id!)).toMatchObject({ subject: 'Hola <Luis>', metadata: { campaign: 'octubre', user: '7' } });
      expect((await show(items[4]!.id!)).subject).toBe('Hola Marta');
      // HTML values are escaped.
      const content = (await (await call(full.apiKey, 'GET', `/v1/messages/${items[1]!.id}/content`)).json()) as { html?: string };
      expect(content.html).toContain('Hola &lt;Luis&gt;');

      // A send key with domains: checked message by message.
      const mixed = await call(limited.apiKey, 'POST', '/v1/messages/batch', {
        subject: 's',
        text: 't',
        messages: [
          { from: 'a@empresa.com', to: 'ana@sim.relayo.dev' },
          { from: 'a@otra.com', to: 'ana@sim.relayo.dev' },
        ],
      });
      expect(((await mixed.json()) as { data: Item[] }).data.map((i) => i.error?.statusCode ?? i.status)).toEqual(['queued', 403]);

      const sms = await call(full.apiKey, 'POST', '/v1/sms/batch', {
        body: 'Tu código es {{codigo}}',
        messages: [
          { to: '+12015550100', variables: { codigo: '1234' } },
          { to: '+12015550101', variables: { codigo: '5678' } },
        ],
      });
      const smsItems = ((await sms.json()) as { data: Item[] }).data;
      expect(smsItems.map((i) => i.status)).toEqual(['queued', 'queued']);
      const smsMessage = (await (await call(full.apiKey, 'GET', `/v1/messages/${smsItems[1]!.id}`)).json()) as { text?: string; body?: string };
      expect(JSON.stringify(smsMessage)).toContain('Tu código es 5678');

      expect((await call(full.apiKey, 'POST', '/v1/messages/batch', { messages: [] })).status).toBe(400);
      expect((await call(full.apiKey, 'POST', '/v1/messages/batch', { messages: Array.from({ length: 501 }, () => ({})) })).status).toBe(400);

      // Idempotent like single sends.
      const again = () => call(full.apiKey, 'POST', '/v1/sms/batch', { body: 'x', messages: [{ to: '+12015550100' }] }, { 'idempotency-key': 'lote-1' });
      const first = (await (await again()).json()) as { data: Item[] };
      const second = await again();
      expect(second.headers.get('idempotent-replayed')).toBe('true');
      expect(await second.json()).toEqual(first);
    } finally {
      await app.close();
    }
  });
});
