import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { smtpProvider, webhookReceiver } from './helpers.js';

describe('open and click tracking', () => {
  it('adds a pixel and tracked links to live emails, and turns them into events once', async () => {
    const provider = await smtpProvider();
    const hooks = await webhookReceiver();
    const app = await NestFactory.create(
      AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: true, secureCookies: false, secretsKey: 'tracking-test-key' }),
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
      const signup = await panel('POST', '/v1/auth/signup', { email: 'ana-tracking@empresa.com', name: 'Ana', password: 'una-clave-larga-1' });
      projectId = ((await signup.json()) as { projects: Array<{ id: string }> }).projects[0]!.id;
      const live = ((await (await panel('POST', '/v1/project/keys', { name: 'Producción', mode: 'live' })).json()) as { apiKey: string }).apiKey;
      await panel('POST', '/v1/project/connections', { name: 'Local', provider: 'smtp', values: { host: '127.0.0.1', port: String(provider.port), security: 'none' } });
      await panel('PATCH', '/v1/project', { webhookUrl: hooks.url });
      hooks.setSecret(((await (await panel('GET', '/v1/project/webhook-secret')).json()) as { webhookSecret: string }).webhookSecret);
      expect(await (await panel('PATCH', '/v1/project', { trackOpens: true, trackClicks: true })).json()).toMatchObject({ trackOpens: true, trackClicks: true });

      const html =
        '<html><body><p>Mira <a href="https://tienda.example/oferta?a=1&amp;b=2">la oferta</a>, ' +
        "<a href='mailto:hola@empresa.com'>escríbenos</a> o <a href=\"{{unsubscribe_url}}\">date de baja</a>.</p></body></html>";
      const sent = await fetch(`${base}/v1/messages`, {
        method: 'POST',
        headers: { authorization: `Bearer ${live}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: 'boletin@empresa.com', to: ['ana@cliente.com'], subject: 'Ofertas', html, metadata: { campaign: 'otoño' } }),
      });
      const { id } = (await sent.json()) as { id: string };
      const raw = provider.received[0]!.raw;
      const click = /href="[^"]*(\/t\/c\/[^"]+)"/.exec(raw)?.[1];
      const pixel = /<img src="[^"]*(\/t\/o\/[^"]+)"/.exec(raw)?.[1];
      expect(click).toBeDefined();
      expect(pixel).toMatch(/\.gif$/);
      // Not tracked: mailto, and Relayo's own unsubscribe link.
      expect(raw).toContain("href='mailto:hola@empresa.com'");
      expect(raw).toMatch(/href="[^"]*\/u\/[^"]+"/);
      expect(raw).not.toContain('tienda.example/oferta');
      // The pixel goes inside the body.
      expect(raw.indexOf('/t/o/')).toBeLessThan(raw.indexOf('</body>'));

      const opened = await fetch(`${base}${pixel}`, { headers: { 'user-agent': 'Mail/1.0' } });
      expect(opened.headers.get('content-type')).toBe('image/gif');
      await fetch(`${base}${pixel}`);
      const redirect = await fetch(`${base}${click}`, { redirect: 'manual' });
      expect(redirect.status).toBe(302);
      expect(redirect.headers.get('location')).toBe('https://tienda.example/oferta?a=1&b=2');
      await fetch(`${base}${click}`, { redirect: 'manual' });

      await vi.waitFor(() => expect(hooks.events.filter((e) => e.type === 'opened' || e.type === 'clicked')).toHaveLength(2));
      expect(hooks.events.find((e) => e.type === 'opened')).toMatchObject({ messageId: id, recipient: 'ana@cliente.com', metadata: { campaign: 'otoño' } });
      expect(hooks.events.find((e) => e.type === 'clicked')).toMatchObject({ url: 'https://tienda.example/oferta?a=1&b=2' });

      // A changed token: the pixel still answers, the redirect does not.
      expect((await fetch(`${base}/t/o/nada.gif`)).status).toBe(200);
      expect((await fetch(`${base}${click!.slice(0, -3)}abc`, { redirect: 'manual' })).status).toBe(404);
    } finally {
      await app.close();
      await provider.close();
      await hooks.close();
    }
  });
});
