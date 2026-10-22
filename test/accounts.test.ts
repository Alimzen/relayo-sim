import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { hashPassword, verifyPassword } from '../src/accounts/password.js';

let app: INestApplication;
let base: string;

beforeAll(async () => {
  app = await NestFactory.create(
    AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: true, secureCookies: false }),
    { logger: false },
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
});

/** A browser: keeps the session cookie and sends the panel's headers. */
function browser() {
  let cookie = '';
  let project = '';
  const request = async (method: string, path: string, body?: unknown, extra: Record<string, string> = {}) => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: {
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...(cookie && { cookie }),
        ...(project && { 'x-relayo-project': project }),
        'x-relayo-client': 'panel',
        ...extra,
      },
      ...(body !== undefined && { body: JSON.stringify(body) }),
    });
    const setCookie = response.headers.get('set-cookie');
    if (setCookie) cookie = setCookie.split(';')[0]!;
    return response;
  };
  return {
    request,
    json: async <T>(method: string, path: string, body?: unknown) => (await (await request(method, path, body)).json()) as T,
    use(projectId: string) {
      project = projectId;
    },
    get cookie() {
      return cookie;
    },
    get rawCookie() {
      return cookie;
    },
  };
}

let counter = 0;
const email = () => `user${++counter}-${Date.now()}@empresa.com`;
const PASSWORD = 'una-clave-larga-1';

async function signUp() {
  const b = browser();
  const address = email();
  const response = await b.request('POST', '/v1/auth/signup', { email: address, name: 'Ana', password: PASSWORD });
  const body = (await response.json()) as { user: { id: string }; projects: Array<{ id: string; name: string }> };
  b.use(body.projects[0]!.id);
  return { b, address, response, body };
}

describe('passwords', () => {
  it('hashes with scrypt and verifies', async () => {
    const hash = await hashPassword('correct horse battery');
    expect(hash).toMatch(/^scrypt\$16384\$8\$1\$/);
    expect(await verifyPassword('correct horse battery', hash)).toBe(true);
    expect(await verifyPassword('wrong', hash)).toBe(false);
    expect(await hashPassword('same')).not.toBe(await hashPassword('same'));
  });
});

describe('accounts', () => {
  it('signs up with a first project and an HttpOnly session cookie', async () => {
    const { response, body, b } = await signUp();
    expect(response.status).toBe(201);
    expect(response.headers.get('set-cookie')).toMatch(/relayo_session=.+; Path=\/; HttpOnly; SameSite=Lax; Max-Age=2592000/);
    expect(body.projects).toEqual([expect.objectContaining({ name: 'Mi primer proyecto' })]);
    expect(body.user).not.toHaveProperty('passwordHash');

    const me = await b.json<{ user: { name: string }; projects: unknown[] }>('GET', '/v1/auth/me');
    expect(me.user.name).toBe('Ana');
    expect(me.projects).toHaveLength(1);
  });

  it('validates sign-up input and refuses duplicate emails', async () => {
    const b = browser();
    const bad = async (body: object) => (await b.request('POST', '/v1/auth/signup', body)).status;
    expect(await bad({ email: 'nope', name: 'A', password: PASSWORD })).toBe(400);
    expect(await bad({ email: email(), name: '', password: PASSWORD })).toBe(400);
    expect(await bad({ email: email(), name: 'A', password: 'corta' })).toBe(400);
    const { address } = await signUp();
    expect(await bad({ email: address.toUpperCase(), name: 'A', password: PASSWORD })).toBe(409);
  });

  it('logs in and out', async () => {
    const { address } = await signUp();
    const b = browser();
    expect((await b.request('POST', '/v1/auth/login', { email: address, password: 'mal' })).status).toBe(401);
    const ok = await b.request('POST', '/v1/auth/login', { email: address, password: PASSWORD });
    expect(ok.status).toBe(200);
    expect((await b.request('GET', '/v1/auth/me')).status).toBe(200);

    expect((await b.request('POST', '/v1/auth/logout')).status).toBe(204);
    expect((await b.request('GET', '/v1/auth/me')).status).toBe(401);
  });

  it('works the API through the session, scoped to the user\'s own projects', async () => {
    const ana = await signUp();
    const bea = await signUp();

    const sent = await ana.b.request('POST', '/v1/messages', { from: 'a@empresa.com', to: ['hard-bounce@sim.relayo.dev'], subject: 's' });
    expect(sent.status).toBe(202);
    const list = await ana.b.json<{ data: unknown[] }>('GET', '/v1/messages');
    expect(list.data).toHaveLength(1);

    bea.b.use(ana.body.projects[0]!.id);
    expect((await bea.b.request('GET', '/v1/messages')).status).toBe(404);
  });

  it('requires the panel header for state-changing session requests', async () => {
    const { b } = await signUp();
    const forged = await fetch(`${base}/v1/messages`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: b.cookie },
      body: JSON.stringify({ from: 'a@b.c', to: ['x@y.z'], subject: 's' }),
    });
    expect(forged.status).toBe(403);
    const login = await fetch(`${base}/v1/auth/login`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    expect(login.status).toBe(403);
  });

  it('manages API keys: create, use, revoke; API keys cannot manage keys', async () => {
    const { b } = await signUp();
    const created = await b.json<{ id: string; apiKey: string; prefix: string; name: string }>('POST', '/v1/project/keys', { name: 'CI' });
    expect(created.apiKey).toMatch(/^rly_test_/);
    expect(created.apiKey.startsWith(created.prefix)).toBe(true);

    const withKey = (path: string, init: RequestInit = {}) =>
      fetch(`${base}${path}`, { ...init, headers: { authorization: `Bearer ${created.apiKey}`, ...init.headers } });
    expect((await withKey('/v1/project')).status).toBe(200);
    expect((await withKey('/v1/project/keys')).status).toBe(403);
    expect((await withKey('/v1/project/webhook-secret')).status).toBe(403);

    const keys = await b.json<{ data: Array<{ name: string; lastUsedAt: string | null }> }>('GET', '/v1/project/keys');
    expect(keys.data.map((k) => k.name)).toEqual(['CI', 'Default']);
    expect(keys.data[0]!.lastUsedAt).not.toBeNull();
    expect(keys.data[0]).not.toHaveProperty('keyHash');

    expect((await b.request('DELETE', `/v1/project/keys/${created.id}`)).status).toBe(204);
    expect((await b.request('DELETE', `/v1/project/keys/${created.id}`)).status).toBe(404);
    expect((await withKey('/v1/project')).status).toBe(401);
  });

  it('shows and rotates the webhook secret', async () => {
    const { b } = await signUp();
    const { webhookSecret } = await b.json<{ webhookSecret: string }>('GET', '/v1/project/webhook-secret');
    const rotated = await b.json<{ webhookSecret: string }>('POST', '/v1/project/webhook-secret/rotate');
    expect(rotated.webhookSecret).toMatch(/^whsec_/);
    expect(rotated.webhookSecret).not.toBe(webhookSecret);
    expect((await b.json<{ webhookSecret: string }>('GET', '/v1/project/webhook-secret')).webhookSecret).toBe(rotated.webhookSecret);
  });

  it('creates more projects and reports stats per project', async () => {
    const { b } = await signUp();
    const second = await b.json<{ id: string; apiKey: string }>('POST', '/v1/projects', { name: 'Staging' });
    expect(second.apiKey).toMatch(/^rly_test_/);
    const projects = await b.json<{ data: Array<{ name: string }> }>('GET', '/v1/projects');
    expect(projects.data.map((p) => p.name)).toEqual(['Mi primer proyecto', 'Staging']);

    b.use(second.id);
    await b.request('POST', '/v1/messages', { from: 'a@empresa.com', to: ['complaint@sim.relayo.dev'], subject: 's' });
    await new Promise((r) => setTimeout(r, 200));
    const stats = await b.json<{ messages: number; events: Record<string, number>; daily: unknown[] }>('GET', '/v1/project/stats?days=14');
    expect(stats.messages).toBe(1);
    expect(stats.events).toMatchObject({ delivered: 1, complained: 1 });
    expect(stats.daily).toHaveLength(14);
  });

  it('updates the profile and changes the password, signing out other sessions', async () => {
    const { b, address } = await signUp();
    const other = browser();
    await other.request('POST', '/v1/auth/login', { email: address, password: PASSWORD });

    expect((await b.json<{ user: { name: string } }>('PATCH', '/v1/auth/me', { name: 'Ana Pérez' })).user.name).toBe('Ana Pérez');
    expect((await b.request('POST', '/v1/auth/password', { current: 'mal', next: 'otra-clave-larga-2' })).status).toBe(400);
    expect((await b.request('POST', '/v1/auth/password', { current: PASSWORD, next: 'otra-clave-larga-2' })).status).toBe(204);

    expect((await b.request('GET', '/v1/auth/me')).status).toBe(200);
    expect((await other.request('GET', '/v1/auth/me')).status).toBe(401);
    expect((await browser().request('POST', '/v1/auth/login', { email: address, password: 'otra-clave-larga-2' })).status).toBe(200);
  });

  it('slows down password guessing', async () => {
    const { address } = await signUp();
    const b = browser();
    const statuses: number[] = [];
    for (let i = 0; i < 11; i++) statuses.push((await b.request('POST', '/v1/auth/login', { email: address, password: `mal-${i}` })).status);
    expect(statuses.slice(0, 10).every((s) => s === 401)).toBe(true);
    expect(statuses[10]).toBe(429);
  });
});

describe('claiming projects created before accounts', () => {
  it('adds an ownerless project to the account with one of its API keys, once', async () => {
    const admin = await NestFactory.create(
      AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: true, secureCookies: false, adminToken: 'adm' }),
      { logger: false },
    );
    await admin.listen(0, '127.0.0.1');
    const url = await admin.getUrl();
    try {
      const legacy = (await (
        await fetch(`${url}/v1/admin/projects`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: 'Bearer adm' },
          body: JSON.stringify({ name: 'Proyecto antiguo' }),
        })
      ).json()) as { id: string; apiKey: string };

      const json = { 'content-type': 'application/json', 'x-relayo-client': 'panel' };
      const signupAs = async (address: string) => {
        const r = await fetch(`${url}/v1/auth/signup`, { method: 'POST', headers: json, body: JSON.stringify({ email: address, name: 'A', password: PASSWORD }) });
        return r.headers.get('set-cookie')!.split(';')[0]!;
      };
      const ana = await signupAs('ana-claim@empresa.com');
      const bea = await signupAs('bea-claim@empresa.com');
      const claim = (cookie: string, apiKey: string) =>
        fetch(`${url}/v1/projects/claim`, { method: 'POST', headers: { ...json, cookie }, body: JSON.stringify({ apiKey }) });

      expect((await claim(ana, 'sim_live_wrong')).status).toBe(400);
      expect((await claim(ana, legacy.apiKey)).status).toBe(201);
      expect((await claim(bea, legacy.apiKey)).status).toBe(400);
      const projects = (await (await fetch(`${url}/v1/projects`, { headers: { cookie: ana } })).json()) as { data: Array<{ name: string }> };
      expect(projects.data.map((p) => p.name)).toContain('Proyecto antiguo');
    } finally {
      await admin.close();
    }
  });
});

describe('closed sign-up', () => {
  it('refuses new accounts when SIGNUP=closed', async () => {
    const closed = await NestFactory.create(
      AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: false, secureCookies: true }),
      { logger: false },
    );
    await closed.listen(0, '127.0.0.1');
    const url = await closed.getUrl();
    try {
      expect(await (await fetch(`${url}/v1/auth/config`)).json()).toMatchObject({ signup: false });
      const response = await fetch(`${url}/v1/auth/signup`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-relayo-client': 'panel' },
        body: JSON.stringify({ email: 'a@b.co', name: 'A', password: PASSWORD }),
      });
      expect(response.status).toBe(403);
    } finally {
      await closed.close();
    }
  });
});

describe('password reset over HTTP', () => {
  it('always answers 204 to "forgot", and refuses bad tokens', async () => {
    const b = browser();
    expect((await b.request('POST', '/v1/auth/forgot', { email: 'nadie@empresa.com' })).status).toBe(204);
    expect((await b.request('POST', '/v1/auth/forgot', { email: 'no-es-un-email' })).status).toBe(400);
    const bad = await b.request('POST', '/v1/auth/reset', { token: 'nope', password: 'una-clave-larga-2' });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { message: string }).message).toContain('caducado');
  });
});
