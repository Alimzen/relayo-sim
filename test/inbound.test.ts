import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import { AppModule } from '../src/app.module.js';
import { referenceIds } from '../src/inbound/inbound.js';
import { webhookReceiver } from './helpers.js';

const reply = (inReplyTo: string, subject = 'Re: Tu pedido') =>
  [
    'From: Ana Cliente <Ana@Cliente.com>',
    'To: pedidos@empresa.com',
    'Cc: copia@empresa.com',
    `Subject: ${subject}`,
    'Message-ID: <respuesta-1@cliente.com>',
    `In-Reply-To: ${inReplyTo}`,
    `References: ${inReplyTo}`,
    'X-Mailer: Correo 1.0',
    'MIME-Version: 1.0',
    'Content-Type: multipart/mixed; boundary="b1"',
    '',
    '--b1',
    'Content-Type: text/plain; charset=utf-8',
    '',
    'Gracias, ¿cuándo llega?',
    '--b1',
    'Content-Type: text/csv; name="pedido.csv"',
    'Content-Disposition: attachment; filename="pedido.csv"',
    '',
    'a,b',
    '--b1--',
    '',
  ].join('\r\n');

describe('received emails', () => {
  it('takes emails in each provider format, matches replies to what was sent, and sends them to the endpoints that ask', async () => {
    const app = await NestFactory.create(
      AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: false, secureCookies: false, adminToken: 'admin' }),
      { logger: false },
    );
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    const main = await webhookReceiver();
    const replies = await webhookReceiver();
    try {
      const created = await fetch(`${base}/v1/admin/projects`, {
        method: 'POST',
        headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Pedidos', webhookUrl: main.url }),
      });
      const project = (await created.json()) as { apiKey: string; webhookSecret: string };
      main.setSecret(project.webhookSecret);
      const call = (method: string, path: string, body?: unknown) =>
        fetch(`${base}${path}`, {
          method,
          headers: { authorization: `Bearer ${project.apiKey}`, 'content-type': 'application/json' },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
      const endpoint = (await (await call('POST', '/v1/project/webhook/endpoints', { url: replies.url, events: ['inbound'] })).json()) as { secret: string };
      replies.setSecret(endpoint.secret);

      expect(await (await call('GET', '/v1/project/inbound')).json()).toEqual({ enabled: false, url: null });
      const { url } = (await (await call('POST', '/v1/project/inbound')).json()) as { url: string };
      const path = new URL(url).pathname;
      expect(path).toMatch(/^\/v1\/inbound\/email\/inb_/);

      const sent = await call('POST', '/v1/messages', { from: 'pedidos@empresa.com', to: ['ana@sim.relayo.dev'], subject: 'Tu pedido', text: 'x', metadata: { pedido: '42' } });
      const { id } = (await sent.json()) as { id: string };
      const detail = (await (await call('GET', `/v1/messages/${id}`)).json()) as { headers: Record<string, string> };
      const sentMessageId = detail.headers['message-id']!;
      expect(sentMessageId).toMatch(/^<.+>$/);

      const post = (body: NonNullable<RequestInit['body']>, contentType?: string) =>
        fetch(`${base}${path}`, { method: 'POST', ...(contentType && { headers: { 'content-type': contentType } }), body });
      // The raw message.
      const raw = await post(reply(sentMessageId), 'message/rfc822');
      expect(raw.status).toBe(200);
      expect(await raw.json()).toMatchObject({ received: 1, id: expect.stringMatching(/^inb_/) });
      // SendGrid Inbound Parse with "raw": a multipart form with the whole email in \`email\`.
      const form = new FormData();
      form.set('email', reply('<otro@ninguno.com>', 'SendGrid'));
      form.set('to', 'pedidos@empresa.com');
      expect((await post(form)).status).toBe(200);
      // Postmark: JSON with RawEmail.
      expect((await post(JSON.stringify({ From: 'x', RawEmail: reply('<y@z>', 'Postmark') }), 'application/json')).status).toBe(200);
      // Mailgun: form-encoded body-mime.
      expect((await post(new URLSearchParams({ 'body-mime': reply('<y@z>', 'Mailgun') }), 'application/x-www-form-urlencoded')).status).toBe(200);
      // Nothing to read, or a wrong token.
      expect((await post(JSON.stringify({ hola: 1 }), 'application/json')).status).toBe(400);
      expect((await fetch(`${base}/v1/inbound/email/inb_nada`, { method: 'POST', body: reply('<a@b>'), headers: { 'content-type': 'message/rfc822' } })).status).toBe(404);

      await vi.waitFor(() => expect(replies.events).toHaveLength(4));
      const first = replies.events[0] as unknown as Record<string, unknown>;
      expect(first).toMatchObject({
        type: 'inbound',
        from: 'ana@cliente.com',
        fromName: 'Ana Cliente',
        to: ['pedidos@empresa.com'],
        cc: ['copia@empresa.com'],
        subject: 'Re: Tu pedido',
        text: expect.stringContaining('¿cuándo llega?'),
        attachments: [{ filename: 'pedido.csv', contentType: 'text/csv', size: 3 }],
        replyTo: { messageId: id, relayoId: id, metadata: { pedido: '42' } },
        messageId: id,
        metadata: { pedido: '42' },
      });
      expect((first.headers as Record<string, string>)['x-mailer']).toBe('Correo 1.0');
      expect(replies.events.map((e) => (e as unknown as { subject: string }).subject).sort()).toEqual(['Mailgun', 'Postmark', 'Re: Tu pedido', 'SendGrid']);
      expect(replies.invalid).toEqual([]);
      // The main URL only gets the events of messages.
      expect(main.events.some((e) => (e.type as string) === 'inbound')).toBe(false);

      const listed = (await (await call('GET', '/v1/project/inbound/emails')).json()) as { data: Array<{ id: string; subject: string }> };
      expect(listed.data).toHaveLength(4);
      expect((await call('GET', `/v1/project/inbound/emails/${listed.data[0]!.id}`)).status).toBe(200);
      // A delivery of a received email can be redelivered.
      const deliveries = (await (await call('GET', '/v1/project/webhook/deliveries')).json()) as { data: Array<{ id: string; eventType: string }> };
      const inbound = deliveries.data.find((d) => d.eventType === 'inbound')!;
      expect(await (await call('POST', `/v1/project/webhook/deliveries/${inbound.id}/redeliver`)).json()).toMatchObject({ ok: true, eventType: 'inbound' });

      expect((await call('DELETE', '/v1/project/inbound')).status).toBe(204);
      expect((await post(reply('<a@b>'), 'message/rfc822')).status).toBe(404);
    } finally {
      await Promise.all([main.close(), replies.close()]);
      await app.close();
    }
  });

  it('reads the ids a reply names, the way providers store them', () => {
    expect(referenceIds(['<0100018abc@eu-west-1.amazonses.com>', '<a@b> <c@d>'])).toEqual([
      '0100018abc@eu-west-1.amazonses.com',
      '<0100018abc@eu-west-1.amazonses.com>',
      '0100018abc',
      'a@b',
      '<a@b>',
      'a',
      'c@d',
      '<c@d>',
      'c',
    ]);
  });
});
