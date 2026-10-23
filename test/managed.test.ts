import 'reflect-metadata';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { ProviderUnavailableError, RateLimitError, ValidationError, type EmailMessage } from '@alimzen/relayo';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { Connection, Project } from '../src/domain.js';
import { ManagedSending } from '../src/live/managed.js';
import { SecretBox } from '../src/live/secrets.js';
import { MemoryStore } from '../src/store/memory-store.js';

/** Relayo's relay, standing in: records what it gets. */
let relay: { received: string[]; port: number; close: () => Promise<void> };

beforeAll(async () => {
  const received: string[] = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push(Buffer.concat(chunks).toString('utf8'));
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  relay = { received, port: (server.server.address() as AddressInfo).port, close: () => new Promise((r) => server.close(() => r())) };
});

afterAll(() => relay.close());

const project: Project = { id: 'prj_1', name: 'P', webhookSecret: 'whsec_x', createdAt: new Date() };
const connection = { id: 'con_managed', projectId: 'prj_1', provider: 'managed' } as Connection;
const message = (from: string): EmailMessage => ({ from: { address: from }, to: { address: 'ana@cliente.com' }, subject: 'Hola', text: 'Hola' });

function setup(dns: Record<string, string[]> = {}, dailyLimit = 100) {
  const store = new MemoryStore();
  const managed = new ManagedSending(
    store,
    new SecretBox('test-key'),
    { smtpUrl: `smtp://127.0.0.1:${relay.port}/?ignoreTLS=true`, spfInclude: 'amazonses.com', dailyLimit },
    async (host) => (dns[host] ?? []).map((r) => [r]),
  );
  return { store, managed };
}

describe('managed sending', () => {
  it('generates the DKIM key and the DNS records to publish', async () => {
    const { managed } = setup();
    const domain = await managed.addDomain(project, 'Empresa.com.');
    expect(domain.domain).toBe('empresa.com');
    const records = managed.records(domain);
    expect(records.map((r) => [r.purpose, r.host, r.required])).toEqual([
      ['dkim', 'relayo._domainkey.empresa.com', true],
      ['spf', 'empresa.com', true],
      ['dmarc', '_dmarc.empresa.com', false],
    ]);
    expect(records[0]!.value).toBe(`v=DKIM1; k=rsa; p=${domain.dkimPublicKey}`);
    expect(records[1]!.value).toBe('v=spf1 include:amazonses.com ~all');
    await expect(managed.addDomain(project, 'empresa.com')).rejects.toBeInstanceOf(ValidationError);
    await expect(managed.addDomain(project, 'no es un dominio')).rejects.toBeInstanceOf(ValidationError);
  });

  it('verifies the domain once DKIM and SPF are published', async () => {
    const dns: Record<string, string[]> = {};
    const { managed } = setup(dns);
    const domain = await managed.addDomain(project, 'empresa.com');

    expect((await managed.verify(project, domain.id)).verifiedAt).toBeUndefined();
    dns['relayo._domainkey.empresa.com'] = [managed.records(domain)[0]!.value];
    const onlyDkim = await managed.verify(project, domain.id);
    expect(onlyDkim.checks).toEqual({ dkim: true, spf: false, dmarc: false });
    expect(onlyDkim.verifiedAt).toBeUndefined();

    dns['empresa.com'] = ['v=spf1 include:_spf.google.com include:amazonses.com ~all'];
    dns['_dmarc.empresa.com'] = ['v=DMARC1; p=quarantine'];
    const verified = await managed.verify(project, domain.id);
    expect(verified.checks).toEqual({ dkim: true, spf: true, dmarc: true });
    expect(verified.verifiedAt).toBeInstanceOf(Date);
  });

  it('signs with the DKIM key of the verified sender domain, and refuses other senders', async () => {
    const dns: Record<string, string[]> = {};
    const { managed } = setup(dns);
    const domain = await managed.addDomain(project, 'empresa.com');
    dns['relayo._domainkey.empresa.com'] = [managed.records(domain)[0]!.value];
    dns['empresa.com'] = ['v=spf1 include:amazonses.com ~all'];
    await managed.verify(project, domain.id);

    const driver = managed.driver(connection);
    await driver.send(message('facturas@empresa.com'), { messageId: 'sim_1' });
    // The header is folded over several lines: unfold it before reading its tags.
    const raw = relay.received.at(-1)!.replace(/\r?\n[ \t]+/g, ' ');
    const signature = /^DKIM-Signature: (.*)$/m.exec(raw)![1]!;
    expect(signature).toMatch(/\bd=empresa\.com;/);
    expect(signature).toMatch(/\bs=relayo;/);

    await expect(driver.send(message('otro@desconocido.com'), { messageId: 'sim_2' })).rejects.toBeInstanceOf(ValidationError);
  });

  it('stops at the daily limit with an error failover can move past', async () => {
    const dns: Record<string, string[]> = {};
    const { managed } = setup(dns, 1);
    const domain = await managed.addDomain(project, 'empresa.com');
    dns['relayo._domainkey.empresa.com'] = [managed.records(domain)[0]!.value];
    dns['empresa.com'] = ['v=spf1 include:amazonses.com ~all'];
    await managed.verify(project, domain.id);
    const driver = managed.driver(connection);

    await driver.send(message('a@empresa.com'), { messageId: 'sim_1' });
    const error = await driver.send(message('a@empresa.com'), { messageId: 'sim_2' }).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RateLimitError);
    expect((error as RateLimitError).retryable).toBe(true);
  });

  it('pauses a project whose hard bounces hurt the shared reputation', async () => {
    const dns: Record<string, string[]> = {};
    const { store, managed } = setup(dns, 1000);
    await store.createProject(project);
    const domain = await managed.addDomain(project, 'empresa.com');
    dns['relayo._domainkey.empresa.com'] = [managed.records(domain)[0]!.value];
    dns['empresa.com'] = ['v=spf1 include:amazonses.com ~all'];
    await managed.verify(project, domain.id);
    for (let i = 0; i < 60; i++) {
      const id = `sim_${i}`;
      await store.saveMessage({ id, projectId: 'prj_1', mode: 'live', via: 'api', from: 'a@empresa.com', recipients: [], subject: '', createdAt: new Date() });
      if (i < 6) {
        await store.addEvent({ id: `${id}:b`, type: 'bounced', bounceType: 'hard', reason: 'user_unknown', channel: 'email', provider: 'relayo', messageId: id, providerMessageId: id, recipient: 'x@y.co', timestamp: new Date(), raw: {}, projectId: 'prj_1' } as never);
      }
    }
    await expect(managed.driver(connection).send(message('a@empresa.com'), { messageId: 'sim_x' })).rejects.toBeInstanceOf(ProviderUnavailableError);
  });
});

describe('managed sending in the API', () => {
  it('is offered only when the platform configures it, after an admin approves the project, once per project', async () => {
    const app = await NestFactory.create(
      AppModule.forRoot({
        httpPort: 0,
        host: '127.0.0.1',
        timeScale: 0,
        maxHangMs: 300,
        signup: true,
        secureCookies: false,
        secretsKey: 'k',
        adminToken: 'admin-secret',
        managed: { smtpUrl: `smtp://127.0.0.1:${relay.port}`, dailyLimit: 10 },
      }),
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
      const signup = await call('POST', '/v1/auth/signup', { email: `m${Date.now()}@empresa.com`, name: 'Ana', password: 'una-clave-larga-1' });
      projectId = ((await signup.json()) as { projects: Array<{ id: string }> }).projects[0]!.id;

      const providers = (await (await call('GET', '/v1/project/providers')).json()) as { data: Array<{ name: string }> };
      expect(providers.data[0]!.name).toBe('managed');
      // An admin reviews the project first.
      expect((await call('POST', '/v1/project/connections', { provider: 'managed' })).status).toBe(403);
      expect(await (await call('POST', '/v1/project/managed-access')).json()).toEqual({ access: 'requested' });
      expect((await call('GET', '/v1/admin/managed')).status).toBe(403);
      const admin = (method: string, path: string, body?: unknown) =>
        fetch(`${base}${path}`, {
          method,
          headers: { authorization: 'Bearer admin-secret', 'content-type': 'application/json' },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
      const requests = (await (await admin('GET', '/v1/admin/managed')).json()) as { data: Array<{ project: { id: string; managedAccess: string } }> };
      expect(requests.data.map((r) => r.project)).toEqual([expect.objectContaining({ id: projectId, managedAccess: 'requested' })]);
      expect((await admin('POST', `/v1/admin/managed/${projectId}`, { decision: 'approved' })).status).toBe(200);

      expect((await call('POST', '/v1/project/connections', { provider: 'managed' })).status).toBe(201);
      expect((await call('POST', '/v1/project/connections', { provider: 'managed' })).status).toBe(409);

      const added = (await (await call('POST', '/v1/project/domains', { domain: 'empresa.com' })).json()) as { verified: boolean; records: Array<{ host: string }> };
      expect(added.verified).toBe(false);
      expect(added.records[0]!.host).toBe('relayo._domainkey.empresa.com');
      const listed = await (await call('GET', '/v1/project/domains')).text();
      expect(listed).not.toContain('PRIVATE KEY');
      expect((await fetch(`${base}/v1/inbound/managed/nope`, { method: 'POST', body: '{}' })).status).toBe(404);
    } finally {
      await app.close();
    }
  });
});
