import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

let app: INestApplication;
let base = '';

beforeAll(async () => {
  app = await NestFactory.create(
    AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: true, secureCookies: false }),
    { logger: false },
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterAll(() => app.close());

function person() {
  let cookie = '';
  const me = {
    projectId: '',
    async call(method: string, path: string, body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', cookie, 'x-relayo-client': 'panel', 'x-relayo-project': me.projectId },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      return response;
    },
    async signup(email: string) {
      const response = await me.call('POST', '/v1/auth/signup', { email, name: 'Ana', password: 'una-clave-larga-1' });
      me.projectId = ((await response.json()) as { projects: Array<{ id: string }> }).projects[0]!.id;
    },
  };
  return me;
}

describe('account data', () => {
  it('exports everything kept about the account, without secrets', async () => {
    const ana = person();
    await ana.signup('ana-export@empresa.com');
    await ana.call('POST', '/v1/project/keys', { name: 'CI' });
    await ana.call('POST', '/v1/project/templates', { alias: 'hola', subject: 'Hola', text: 'Hola' });
    await ana.call('POST', '/v1/messages', { from: 'a@empresa.com', to: ['hard-bounce@sim.relayo.dev'], subject: 'Factura', text: 'x' });

    const response = await ana.call('GET', '/v1/auth/me/export');
    expect(response.headers.get('content-disposition')).toMatch(/attachment; filename="relayo-usr_/);
    const data = (await response.json()) as {
      account: { email: string };
      projects: Array<{ id: string; keys: Array<Record<string, unknown>>; templates: unknown[]; messages: { test: Array<{ subject: string; events: unknown[] }> } }>;
    };
    expect(data.account.email).toBe('ana-export@empresa.com');
    const project = data.projects[0]!;
    expect(project.id).toBe(ana.projectId);
    expect(project.keys[0]).toMatchObject({ name: 'CI' });
    expect(project.keys[0]).not.toHaveProperty('keyHash');
    expect(project.templates).toHaveLength(1);
    expect(project.messages.test[0]).toMatchObject({ subject: 'Factura' });
    expect(JSON.stringify(data)).not.toMatch(/passwordHash|scrypt\$/);
  });

  it('deletes a project, only by its owner and with its name', async () => {
    const ana = person();
    await ana.signup('ana-project@empresa.com');
    const name = ((await (await ana.call('GET', '/v1/project')).json()) as { name: string }).name;
    expect((await ana.call('DELETE', '/v1/project', { confirm: 'otro' })).status).toBe(400);
    expect((await ana.call('DELETE', '/v1/project', { confirm: name })).status).toBe(204);
    expect((await ana.call('GET', '/v1/project')).status).toBe(404);
    expect(((await (await ana.call('GET', '/v1/projects')).json()) as { data: unknown[] }).data).toEqual([]);
  });

  it('deletes the account with the password, its projects with it, and signs out', async () => {
    const ana = person();
    await ana.signup('ana-delete@empresa.com');
    const created = (await (await ana.call('POST', '/v1/project/keys', { name: 'CI' })).json()) as { apiKey: string };
    expect((await ana.call('DELETE', '/v1/auth/me', { password: 'mal' })).status).toBe(400);
    expect((await ana.call('DELETE', '/v1/auth/me', { password: 'una-clave-larga-1' })).status).toBe(204);
    expect((await ana.call('GET', '/v1/auth/me')).status).toBe(401);
    // Its project went too: its keys no longer work.
    const withKey = await fetch(`${base}/v1/messages`, { headers: { authorization: `Bearer ${created.apiKey}` } });
    expect(withKey.status).toBe(401);
    // The email can be used again.
    const again = person();
    await again.signup('ana-delete@empresa.com');
    expect(again.projectId).toBeTruthy();
  });
});
