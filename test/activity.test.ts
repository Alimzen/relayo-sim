import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

/** The log is written once the response has gone out: wait until it shows up. */
async function eventually<T>(read: () => Promise<T>, until: (value: T) => boolean): Promise<T> {
  for (let i = 0; i < 50; i++) {
    const value = await read();
    if (until(value)) return value;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  return read();
}

interface Entry {
  actor: { kind: string; email?: string; name?: string };
  action: string;
  params?: Record<string, string>;
  details?: Record<string, unknown>;
}

interface Request {
  keyName: string;
  method: string;
  path: string;
  status: number;
  error?: string;
}

describe('activity logs', () => {
  it('records who changed what, and every request made with a key', async () => {
    const app = await NestFactory.create(
      AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: true, secureCookies: false, adminToken: 'admin' }),
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
      const signup = await panel('POST', '/v1/auth/signup', { email: 'ana-audit@empresa.com', name: 'Ana', password: 'una-clave-larga-1' });
      projectId = ((await signup.json()) as { projects: Array<{ id: string }> }).projects[0]!.id;
      const key = (await (await panel('POST', '/v1/project/keys', { name: 'Servidor', permission: 'full' })).json()) as { id: string; apiKey: string };
      const reader = (await (await panel('POST', '/v1/project/keys', { name: 'Lectura', permission: 'read' })).json()) as { apiKey: string };

      const call = (apiKey: string, method: string, path: string, body?: unknown) =>
        fetch(`${base}${path}`, {
          method,
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
      expect((await call(key.apiKey, 'POST', '/v1/project/templates', { alias: 'bienvenida', name: 'Bienvenida', subject: 's', text: 't' })).status).toBe(201);
      expect((await call(key.apiKey, 'POST', '/v1/project/templates/bienvenida/preview', {})).status).toBe(200);
      expect((await call(key.apiKey, 'POST', '/v1/messages', { from: 'a@empresa.com', to: ['ana@sim.relayo.dev'], subject: 's', text: 't' })).status).toBe(202);
      expect((await call(key.apiKey, 'POST', '/v1/messages', { to: ['ana@sim.relayo.dev'] })).status).toBe(400);
      expect((await call(reader.apiKey, 'DELETE', '/v1/project/templates/bienvenida')).status).toBe(403);
      await fetch(`${base}/v1/admin/plans/${projectId}`, {
        method: 'PATCH',
        headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
        body: JSON.stringify({ monthlyMessages: 500 }),
      });

      const audit = await eventually(
        async () => ((await (await panel('GET', '/v1/project/audit')).json()) as { data: Entry[] }).data,
        (list) => list.length >= 4,
      );
      // Newest first: the admin's plan, the key's template, then the keys created from the panel.
      expect(audit.map((e) => [e.actor.kind, e.action])).toEqual([
        ['admin', 'PATCH /v1/admin/plans/:projectId'],
        ['key', 'POST /v1/project/templates'],
        ['user', 'POST /v1/project/keys'],
        ['user', 'POST /v1/project/keys'],
      ]);
      expect(audit[1]).toMatchObject({ actor: { name: 'Servidor' }, details: { name: 'Bienvenida' } });
      expect(audit[3]).toMatchObject({ actor: { email: 'ana-audit@empresa.com' }, details: { name: 'Servidor', permission: 'full' } });
      expect(audit[0]!.details).toEqual({ monthlyMessages: 500 });
      // Secrets never reach the log.
      expect(JSON.stringify(audit)).not.toContain(key.apiKey);

      const requests = await eventually(
        async () => ((await (await call(key.apiKey, 'GET', '/v1/project/requests')).json()) as { data: Request[] }).data,
        (list) => list.length >= 5,
      );
      expect(requests.map((r) => [r.keyName, r.method, r.path, r.status])).toEqual([
        ['Lectura', 'DELETE', '/v1/project/templates/bienvenida', 403],
        ['Servidor', 'POST', '/v1/messages', 400],
        ['Servidor', 'POST', '/v1/messages', 202],
        ['Servidor', 'POST', '/v1/project/templates/bienvenida/preview', 200],
        ['Servidor', 'POST', '/v1/project/templates', 201],
      ]);
      expect(requests[0]!.error).toContain('can only read');
      const failed = ((await (await panel('GET', `/v1/project/requests?status=failed&key=${key.id}`)).json()) as { data: Request[] }).data;
      expect(failed.map((r) => r.status)).toEqual([400]);
    } finally {
      await app.close();
    }
  });
});
