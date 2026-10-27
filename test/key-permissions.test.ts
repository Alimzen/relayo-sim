import 'reflect-metadata';
import { createRelayo, isRelayoError } from '@alimzen/relayo';
import { smtp } from '@alimzen/relayo-smtp';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { SmtpSimServer } from '../src/smtp/smtp-sim.server.js';
import { memorySimulation } from './helpers.js';

const email = (from: string) => ({ from, to: ['ana@sim.relayo.dev'], subject: 'Hola', text: 'x' });

describe('key permissions', () => {
  it('lets send keys only send (from their domains), and read keys only read', async () => {
    const app = await NestFactory.create(
      AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: true, secureCookies: false }),
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
      const signup = await panel('POST', '/v1/auth/signup', { email: 'ana-keys@empresa.com', name: 'Ana', password: 'una-clave-larga-1' });
      projectId = ((await signup.json()) as { projects: Array<{ id: string }> }).projects[0]!.id;
      const create = async (body: unknown) => (await panel('POST', '/v1/project/keys', body)).json() as Promise<{ apiKey: string; permission: string; allowedDomains: string[] | null }>;

      const send = await create({ name: 'Envíos', permission: 'send', allowedDomains: 'empresa.com, @tienda.es' });
      expect(send).toMatchObject({ permission: 'send', allowedDomains: ['empresa.com', 'tienda.es'] });
      const read = await create({ name: 'Lectura', permission: 'read' });
      expect((await panel('POST', '/v1/project/keys', { name: 'Mal', permission: 'read', allowedDomains: ['empresa.com'] })).status).toBe(400);
      expect((await panel('POST', '/v1/project/keys', { name: 'Mal', permission: 'admin' })).status).toBe(400);

      const call = (key: string, method: string, path: string, body?: unknown) =>
        fetch(`${base}${path}`, {
          method,
          headers: { authorization: `Bearer ${key}`, 'content-type': 'application/json' },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });

      expect((await call(send.apiKey, 'POST', '/v1/messages', email('facturas@empresa.com'))).status).toBe(202);
      expect((await call(send.apiKey, 'POST', '/v1/messages', email('x@mail.empresa.com'))).status).toBe(202);
      const otherDomain = await call(send.apiKey, 'POST', '/v1/messages', email('x@otra.com'));
      expect(otherDomain.status).toBe(403);
      expect(((await otherDomain.json()) as { message: string }).message).toContain('empresa.com, tienda.es');
      expect((await call(send.apiKey, 'POST', '/v1/sms', { to: ['+12015550100'], body: 'x' })).status).toBe(202);
      expect((await call(send.apiKey, 'GET', '/v1/messages')).status).toBe(403);
      expect((await call(send.apiKey, 'POST', '/v1/project/templates', { alias: 'x', subject: 's', text: 't' })).status).toBe(403);

      expect((await call(read.apiKey, 'GET', '/v1/messages')).status).toBe(200);
      expect((await call(read.apiKey, 'GET', '/v1/project/stats')).status).toBe(200);
      expect((await call(read.apiKey, 'POST', '/v1/messages', email('facturas@empresa.com'))).status).toBe(403);
      expect((await call(read.apiKey, 'PATCH', '/v1/project', { name: 'x' })).status).toBe(403);

      const keys = (await (await panel('GET', '/v1/project/keys')).json()) as { data: Array<{ name: string; permission: string }> };
      expect(keys.data.map((k) => [k.name, k.permission])).toEqual(
        expect.arrayContaining([
          ['Envíos', 'send'],
          ['Lectura', 'read'],
        ]),
      );
    } finally {
      await app.close();
    }
  });

  it('applies the same limits over SMTP', async () => {
    const { sim } = memorySimulation();
    const { project } = await sim.createProject('P');
    const { apiKey: send } = await sim.createApiKey(project.id, 'Envíos', 'test', { permission: 'send', allowedDomains: ['empresa.com'] });
    const { apiKey: read } = await sim.createApiKey(project.id, 'Lectura', 'test', { permission: 'read' });
    const server = new SmtpSimServer(sim, { port: 0, host: '127.0.0.1' });
    const port = await server.listen();
    try {
      const via = (key: string) => createRelayo({ email: smtp({ host: '127.0.0.1', port, secure: false, ignoreTLS: true, auth: { user: 'x', pass: key } }) });
      const message = (from: string) => ({ from: { address: from }, to: { address: 'ana@sim.relayo.dev' }, subject: 's', text: 't' });
      await expect(via(send).email.send(message('a@empresa.com'))).resolves.toMatchObject({ provider: 'smtp' });
      const wrong = await via(send).email.send(message('a@otra.com')).catch((e: unknown) => e);
      expect(isRelayoError(wrong) && String((wrong as Error).message)).toContain('empresa.com');
      const readOnly = await via(read).email.send(message('a@empresa.com')).catch((e: unknown) => e);
      expect(isRelayoError(readOnly)).toBe(true);
      expect(String((readOnly as Error).message)).toMatch(/only read|535/);
    } finally {
      await server.close();
    }
  });
});
