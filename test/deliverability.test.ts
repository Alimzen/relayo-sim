import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it, vi } from 'vitest';
import type { MailToSend } from '../src/accounts/mailer.js';
import { DeliverabilityAlerts, alertsFor, toRow } from '../src/analytics/deliverability.js';
import { AppModule } from '../src/app.module.js';
import type { SimEvent, SimMessage } from '../src/domain.js';
import { MemoryStore } from '../src/store/memory-store.js';

interface Row {
  key: string;
  sent: number;
  delivered: number;
  bounced: number;
  rates: { bounce: number | null };
  alerts: Array<{ kind: string; level: string }>;
}

describe('deliverability', () => {
  it('splits sending by recipient domain, template and tag, and flags the rates over the thresholds', async () => {
    const app = await NestFactory.create(
      AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: false, secureCookies: false, adminToken: 'admin' }),
      { logger: false },
    );
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    try {
      const created = await fetch(`${base}/v1/admin/projects`, {
        method: 'POST',
        headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Boletín' }),
      });
      const { apiKey } = (await created.json()) as { apiKey: string };
      const call = (method: string, path: string, body?: unknown) =>
        fetch(`${base}${path}`, {
          method,
          headers: { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
      await call('POST', '/v1/project/templates', { alias: 'bienvenida', subject: 'Hola', text: 'x' });

      // 60 to gmail.com (6 hard bounces, 10%), 10 to outlook.com through the template.
      const gmail = Array.from({ length: 60 }, (_, i) => ({
        to: `persona${i}@gmail.com`,
        tags: ['boletin'],
        ...(i < 6 && { headers: { 'X-Sim-Scenario': 'hard-bounce' } }),
      }));
      const outlook = Array.from({ length: 10 }, (_, i) => ({ to: `persona${i}@outlook.com`, template: 'bienvenida', tags: ['alta'] }));
      const batch = await call('POST', '/v1/messages/batch', { from: 'hola@empresa.com', subject: 'Novedades', text: 'x', messages: [...gmail, ...outlook] });
      expect(((await batch.json()) as { data: Array<{ status: string }> }).data.every((i) => i.status === 'queued')).toBe(true);

      const read = async (by: string) => (await (await call('GET', `/v1/project/deliverability?by=${by}&days=1`)).json()) as {
        overall: Row;
        alerts: Array<{ kind: string; level: string }>;
        data: Row[];
      };
      const byDomain = await vi.waitFor(async () => {
        const result = await read('domain');
        expect(result.overall.delivered + result.overall.bounced).toBe(70);
        return result;
      });
      expect(byDomain.data.map((r) => [r.key, r.sent, r.bounced])).toEqual([
        ['gmail.com', 60, 6],
        ['outlook.com', 10, 0],
      ]);
      expect(byDomain.data[0]!.rates.bounce).toBeCloseTo(0.1);
      expect(byDomain.data[0]!.alerts).toEqual([expect.objectContaining({ kind: 'bounces', level: 'critical' })]);
      // Too few to tell.
      expect(byDomain.data[1]!.alerts).toEqual([]);
      expect(byDomain.alerts).toEqual([expect.objectContaining({ kind: 'bounces', level: 'critical' })]);

      expect((await read('template')).data.map((r) => [r.key, r.sent])).toEqual([['bienvenida', 10]]);
      expect((await read('tag')).data.map((r) => [r.key, r.sent])).toEqual([
        ['boletin', 60],
        ['alta', 10],
      ]);
      expect((await call('GET', '/v1/project/deliverability?by=pais')).status).toBe(400);
    } finally {
      await app.close();
    }
  });

  it('computes rates over the right base', () => {
    const row = toRow('x', { accepted: 200, delivered: 190, bounced: 10, complained: 1, opened: 95, clicked: 19 });
    expect(row.rates).toEqual({ delivery: 0.95, bounce: 0.05, complaint: 1 / 190, open: 0.5, click: 0.1 });
    expect(alertsFor(row).map((a) => [a.kind, a.level])).toEqual([
      ['bounces', 'critical'],
      ['complaints', 'critical'],
    ]);
    expect(alertsFor(toRow('y', { accepted: 10, bounced: 10 }))).toEqual([]);
  });

  it('emails the owner and admins about live problems, once a day per kind', async () => {
    const store = new MemoryStore();
    await store.createUser({ id: 'usr_1', email: 'duena@empresa.com', name: 'Ana', passwordHash: 'x', createdAt: new Date() });
    await store.createUser({ id: 'usr_2', email: 'admin@empresa.com', name: 'Luis', passwordHash: 'x', createdAt: new Date() });
    await store.createUser({ id: 'usr_3', email: 'miembro@empresa.com', name: 'Eva', passwordHash: 'x', createdAt: new Date() });
    const project = { id: 'prj_1', name: 'Tienda', ownerId: 'usr_1', webhookSecret: 's', createdAt: new Date() };
    await store.createProject(project);
    await store.addMember({ projectId: 'prj_1', userId: 'usr_2', role: 'admin', createdAt: new Date() });
    await store.addMember({ projectId: 'prj_1', userId: 'usr_3', role: 'member', createdAt: new Date() });
    for (let i = 0; i < 100; i++) {
      const message: SimMessage = {
        id: `sim_${i}`,
        projectId: 'prj_1',
        mode: 'live',
        via: 'api',
        from: 'a@empresa.com',
        recipients: [{ address: `p${i}@gmail.com`, scenario: { name: 'live', source: 'default' } }],
        subject: 's',
        createdAt: new Date(),
      };
      await store.saveMessage(message);
      const event = (type: SimEvent['type']) =>
        ({ id: `${message.id}:${type}`, type, channel: 'email', provider: 'relayo', messageId: message.id, providerMessageId: message.id, recipient: `p${i}@gmail.com`, timestamp: new Date(), raw: {}, projectId: 'prj_1' }) as SimEvent;
      await store.addEvent(event('accepted'));
      await store.addEvent(event(i < 3 ? 'bounced' : 'delivered'));
    }
    const sent: MailToSend[] = [];
    let now = Date.now();
    const alerts = new DeliverabilityAlerts(store, async (mail) => void sent.push(mail), 'https://relayo.example', () => now);

    expect((await alerts.check(project)).map((a) => [a.kind, a.level])).toEqual([['bounces', 'warning']]);
    expect(sent.map((m) => m.to).sort()).toEqual(['admin@empresa.com', 'duena@empresa.com']);
    expect(sent[0]!.text).toContain('3 %');
    expect(sent[0]!.text).toContain('https://relayo.example/deliverability');
    // Checked again within 10 minutes: nothing; after, the same alert is not sent again that day.
    expect(await alerts.check(project)).toEqual([]);
    now += 11 * 60_000;
    expect(await alerts.check(project)).toEqual([]);
    expect(sent).toHaveLength(2);
  });
});
