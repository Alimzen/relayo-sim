import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { AddressInfo } from 'node:net';
import { SMTPServer } from 'smtp-server';
import { describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { webhookReceiver } from './helpers.js';

/** The customer's provider: records what it receives, with headers unfolded and quoted-printable joined. */
async function fakeProvider() {
  const received: Array<{ to: string[]; raw: string }> = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8').replace(/\r\n[ \t]+/g, ' ').replace(/=\r\n/g, '');
        received.push({ to: session.envelope.rcptTo.map((r) => r.address), raw });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return { received, port: (server.server.address() as AddressInfo).port, close: () => new Promise<void>((r) => server.close(() => r())) };
}

describe('unsubscribe links', () => {
  it('adds one-click List-Unsubscribe to live emails, fills {{unsubscribe_url}}, and unsubscribes from the hosted page', async () => {
    const provider = await fakeProvider();
    const hooks = await webhookReceiver();
    const app = await NestFactory.create(
      AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: true, secureCookies: false, secretsKey: 'unsub-test-key' }),
      { logger: false },
    );
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    try {
      let cookie = '';
      let projectId = '';
      const panel = async (method: string, path: string, body?: unknown, mode = 'test') => {
        const response = await fetch(`${base}${path}`, {
          method,
          headers: { 'content-type': 'application/json', cookie, 'x-relayo-client': 'panel', 'x-relayo-project': projectId, 'x-relayo-mode': mode },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
        cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
        return response;
      };
      const signup = await panel('POST', '/v1/auth/signup', { email: 'ana-unsub@empresa.com', name: 'Ana', password: 'una-clave-larga-1' });
      projectId = ((await signup.json()) as { projects: Array<{ id: string }> }).projects[0]!.id;
      const live = ((await (await panel('POST', '/v1/project/keys', { name: 'Producción', mode: 'live' })).json()) as { apiKey: string }).apiKey;
      await panel('POST', '/v1/project/connections', { name: 'Local', provider: 'smtp', values: { host: '127.0.0.1', port: String(provider.port), security: 'none' } });
      await panel('PATCH', '/v1/project', { webhookUrl: hooks.url });
      hooks.setSecret(((await (await panel('GET', '/v1/project/webhook-secret')).json()) as { webhookSecret: string }).webhookSecret);
      const updated = await panel('PATCH', '/v1/project', { unsubscribeLinks: true });
      expect(await updated.json()).toMatchObject({ unsubscribeLinks: true });

      const send = (body: Record<string, unknown>) =>
        fetch(`${base}/v1/messages`, {
          method: 'POST',
          headers: { authorization: `Bearer ${live}`, 'content-type': 'application/json' },
          body: JSON.stringify({ from: 'boletin@empresa.com', subject: 'Novedades', ...body }),
        });

      const sent = await send({ to: ['ana@cliente.com'], html: '<p>Hola. <a href="{{unsubscribe_url}}">Darte de baja</a></p>', text: 'Baja: {{unsubscribe_url}}' });
      expect(sent.status).toBe(202);
      const { id } = (await sent.json()) as { id: string };
      const raw = provider.received[0]!.raw;
      const token = /^List-Unsubscribe: <[^>]*\/u\/([^>]+)>/m.exec(raw)?.[1];
      expect(token).toBeDefined();
      expect(raw).toMatch(/^List-Unsubscribe-Post: List-Unsubscribe=One-Click/m);
      expect(raw).not.toContain('{{unsubscribe_url}}');
      expect(raw.split(`/u/${token}`).length - 1).toBeGreaterThanOrEqual(3);

      // In a template, the tag is left for the send to fill.
      await panel('POST', '/v1/project/templates', { alias: 'boletin', subject: 'Hola {{nombre}}', html: '<a href="{{unsubscribe_url}}">Baja</a>' });
      expect((await send({ to: ['luis@cliente.com'], template: 'boletin', variables: { nombre: 'Luis' } })).status).toBe(202);
      expect(provider.received[1]!.raw).toMatch(/^List-Unsubscribe: </m);
      expect(provider.received[1]!.raw).not.toContain('{{unsubscribe_url}}');

      // Several recipients: no link names one of them.
      await send({ to: ['eva@cliente.com', 'marta@cliente.com'], text: 'Baja: [{{unsubscribe_url}}]' });
      expect(provider.received[2]!.raw).not.toMatch(/^List-Unsubscribe:/m);
      expect(provider.received[2]!.raw).toContain('Baja: []');

      const page = await fetch(`${base}/u/${token}`);
      expect(page.status).toBe(200);
      const html = await page.text();
      expect(html).toContain('Darme de baja');
      expect(html).toContain('a••@cliente.com');
      expect(html).not.toContain('ana@cliente.com');

      const oneClick = () =>
        fetch(`${base}/u/${token}`, { method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'List-Unsubscribe=One-Click' });
      expect((await oneClick()).status).toBe(200);
      expect((await oneClick()).status).toBe(200);
      await vi.waitFor(() => expect(hooks.events.filter((e) => e.type === 'unsubscribed')).toHaveLength(1));
      expect(hooks.events.find((e) => e.type === 'unsubscribed')).toMatchObject({ recipient: 'ana@cliente.com', messageId: id });

      const suppressions = (await (await panel('GET', '/v1/project/suppressions', undefined, 'live')).json()) as { data: Array<{ address: string; reason: string }> };
      expect(suppressions.data).toEqual([expect.objectContaining({ address: 'ana@cliente.com', reason: 'unsubscribe' })]);
      expect(await (await fetch(`${base}/u/${token}`)).text()).toContain('ya no recibirá');

      // A changed token is refused.
      expect((await fetch(`${base}/u/${token!.slice(0, -2)}xx`)).status).toBe(404);
      expect((await fetch(`${base}/u/nada`, { method: 'POST' })).status).toBe(404);

      // The project can turn the header off; the tag still works.
      await panel('PATCH', '/v1/project', { unsubscribeLinks: false });
      await send({ to: ['pablo@cliente.com'], text: 'Baja: {{unsubscribe_url}}' });
      expect(provider.received.at(-1)!.raw).not.toMatch(/^List-Unsubscribe:/m);
      expect(provider.received.at(-1)!.raw).toContain('/u/');
    } finally {
      await app.close();
      await provider.close();
      await hooks.close();
    }
  });
});
