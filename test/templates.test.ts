import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { Project } from '../src/domain.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { fill, TemplatesService, variablesOf } from '../src/templates/templates.js';

const project: Project = { id: 'prj_1', name: 'P', webhookSecret: 'w', createdAt: new Date() };

describe('template engine', () => {
  it('fills variables, nested ones too, escaping them in HTML unless written with three braces', () => {
    const vars = { name: 'Ana <script>', order: { id: 1042, total: '35,09 €' }, banner: '<b>Hoy</b>' };
    expect(fill('Hola {{name}}, pedido {{ order.id }}', vars)).toBe('Hola Ana <script>, pedido 1042');
    expect(fill('<p>{{name}}</p>{{{banner}}}', vars, true)).toBe('<p>Ana &lt;script&gt;</p><b>Hoy</b>');
    const missing = new Set<string>();
    expect(fill('{{name}} {{order.date}} {{nope}}', vars, false, missing)).toBe('Ana <script>  ');
    expect([...missing]).toEqual(['order.date', 'nope']);
    expect(variablesOf('Hola {{name}}', '<p>{{name}} {{{banner}}} {{ order.id }}</p>')).toEqual(['name', 'banner', 'order.id']);
  });

  it('does not reach into prototypes', () => {
    const missing = new Set<string>();
    expect(fill('{{constructor}}{{toString}}', {}, false, missing)).toBe('');
    expect([...missing]).toEqual(['constructor', 'toString']);
  });
});

describe('templates', () => {
  it('saves, renders and refuses sends with missing variables', async () => {
    const service = new TemplatesService(new MemoryStore());
    const created = await service.create(project, {
      alias: 'Bienvenida',
      channel: 'email',
      subject: 'Hola {{name}}',
      html: '<p>Tu código es {{code}}</p>',
    });
    expect(created).toMatchObject({ alias: 'bienvenida', name: 'Bienvenida', channel: 'email' });
    await expect(service.create(project, { alias: 'bienvenida', subject: 's', text: 't' })).rejects.toMatchObject({ status: 409 });
    await expect(service.create(project, { alias: 'Con espacios', subject: 's', text: 't' })).rejects.toMatchObject({ status: 400 });
    await expect(service.create(project, { alias: 'vacia', subject: 's' })).rejects.toMatchObject({ status: 400 });

    expect(await service.renderEmail(project, 'bienvenida', { name: 'Ana', code: 482913 })).toEqual({
      subject: 'Hola Ana',
      html: '<p>Tu código es 482913</p>',
    });
    await expect(service.renderEmail(project, 'bienvenida', { name: 'Ana' })).rejects.toThrow('Faltan variables para la plantilla «bienvenida»: code');
    await expect(service.renderSms(project, 'bienvenida')).rejects.toMatchObject({ status: 400 });
    await expect(service.renderEmail(project, 'nope')).rejects.toMatchObject({ status: 404 });
    expect(await service.preview(project, created.id, { name: 'Ana' })).toEqual({ rendered: { subject: 'Hola Ana', html: '<p>Tu código es </p>' }, missing: ['code'] });

    const updated = await service.update(project, 'bienvenida', { text: 'Código: {{code}}', html: '' });
    expect(updated).toMatchObject({ subject: 'Hola {{name}}', text: 'Código: {{code}}' });
    expect(updated.html).toBeUndefined();
  });

  it('keeps the visual design of an email, until it is dropped', async () => {
    const service = new TemplatesService(new MemoryStore());
    const design = { version: 1, theme: { accent: '#2f5bea' }, blocks: [{ id: 'b1', type: 'heading', text: 'Hola {{nombre}}' }] };
    const created = await service.create(project, { alias: 'visual', subject: 'Hola', html: '<h1>Hola {{nombre}}</h1>', design });
    expect(created.design).toEqual(design);
    // Other changes keep it; null drops it.
    expect((await service.update(project, 'visual', { subject: 'Otro' })).design).toEqual(design);
    expect((await service.update(project, 'visual', { design: null })).design).toBeUndefined();
    await expect(service.create(project, { alias: 'sms', channel: 'sms', body: 'x', design })).rejects.toMatchObject({ status: 400 });
    await expect(service.create(project, { alias: 'mal', subject: 's', text: 't', design: [1] })).rejects.toMatchObject({ status: 400 });
    await expect(service.create(project, { alias: 'grande', subject: 's', text: 't', design: { x: 'a'.repeat(200_001) } })).rejects.toMatchObject({ status: 400 });
  });
});

describe('templates in the API', () => {
  it('sends emails and SMS from templates, with fields in the request winning', async () => {
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
      const call = (method: string, path: string, body?: unknown) =>
        fetch(`${base}${path}`, {
          method,
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });

      const template = await call('POST', '/v1/project/templates', {
        alias: 'pedido',
        name: 'Pedido enviado',
        subject: 'Tu pedido {{order}} ha salido',
        html: '<p>Hola {{name}}, tu pedido {{order}} va en camino.</p>',
        text: 'Hola {{name}}, tu pedido {{order}} va en camino.',
      });
      expect(template.status).toBe(201);
      expect(await template.json()).toMatchObject({ alias: 'pedido', variables: ['order', 'name'] });
      await call('POST', '/v1/project/templates', { alias: 'otp', channel: 'sms', body: 'Tu código es {{code}}' });
      expect(((await (await call('GET', '/v1/project/templates')).json()) as { data: Array<{ alias: string }> }).data.map((t) => t.alias)).toEqual(['otp', 'pedido']);

      const sent = await call('POST', '/v1/messages', { from: 'a@empresa.com', to: ['ana@sim.relayo.dev'], template: 'pedido', variables: { name: 'Ana', order: 1042 } });
      expect(sent.status).toBe(202);
      const { id } = (await sent.json()) as { id: string };
      const content = (await (await call('GET', `/v1/messages/${id}/content`)).json()) as { subject: string; html: string; text: string };
      expect(content).toMatchObject({ subject: 'Tu pedido 1042 ha salido', text: 'Hola Ana, tu pedido 1042 va en camino.' });

      const custom = await call('POST', '/v1/messages', {
        from: 'a@empresa.com',
        to: ['ana@sim.relayo.dev'],
        subject: 'Asunto propio',
        template: 'pedido',
        variables: { name: 'Ana', order: 7 },
      });
      const customContent = (await (await call('GET', `/v1/messages/${((await custom.json()) as { id: string }).id}/content`)).json()) as { subject: string };
      expect(customContent.subject).toBe('Asunto propio');

      const missing = await call('POST', '/v1/messages', { from: 'a@empresa.com', to: ['ana@sim.relayo.dev'], template: 'pedido', variables: { name: 'Ana' } });
      expect(missing.status).toBe(422);
      expect(((await missing.json()) as { message: string }).message).toContain('order');

      const sms = await call('POST', '/v1/sms', { to: ['+12015550100'], template: 'otp', variables: { code: '482913' } });
      expect(sms.status).toBe(202);
      const smsMessage = (await (await call('GET', `/v1/messages/${((await sms.json()) as { id: string }).id}`)).json()) as { body: string };
      expect(smsMessage.body).toBe('Tu código es 482913');

      const preview = (await (await call('POST', '/v1/project/templates/pedido/preview', { variables: { name: 'Ana' } })).json()) as { missing: string[] };
      expect(preview.missing).toEqual(['order']);
      expect((await call('DELETE', '/v1/project/templates/otp')).status).toBe(204);
      expect((await call('GET', '/v1/project/templates/otp')).status).toBe(404);
    } finally {
      await app.close();
    }
  });
});
