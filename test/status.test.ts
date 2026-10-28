import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';
import type { StatusComponent } from '../src/domain.js';
import { StatusService } from '../src/status/status.js';
import { MemoryStore } from '../src/store/memory-store.js';

describe('status page', () => {
  it('measures uptime per day from the minute checks, and keeps them while the database is down', async () => {
    const store = new MemoryStore();
    let now = Date.parse('2026-10-18T10:00:00Z');
    let checks: Partial<Record<StatusComponent, boolean>> = { api: true, database: true };
    const service = new StatusService(store, async () => checks, () => now);

    for (let i = 0; i < 3; i++, now += 60_000) await service.sample();
    checks = { api: true, database: false };
    // The database is what failed: the store cannot write either.
    const write = store.addStatusSamples.bind(store);
    store.addStatusSamples = async () => {
      throw new Error('connection refused');
    };
    await service.sample();
    now += 60_000;
    expect((await service.status()).components.find((c) => c.id === 'database')).toMatchObject({ status: 'outage' });
    store.addStatusSamples = write;
    checks = { api: true, database: true };
    await service.sample();

    const status = await service.status();
    const database = status.components.find((c) => c.id === 'database')!;
    expect(database.days.at(-1)).toEqual({ day: '2026-10-18', uptime: 4 / 5 });
    expect(database.days).toHaveLength(90);
    expect(database.days[0]!.uptime).toBeNull();
    expect(database.uptime).toBe(0.8);
    expect(status.status).toBe('operational');
  });

  it('shows incidents, and their impact on the components', async () => {
    const store = new MemoryStore();
    let now = Date.parse('2026-10-18T10:00:00Z');
    const service = new StatusService(store, async () => ({ api: true, smtp: true }), () => now);

    const incident = await service.open({ title: 'SMTP lento', impact: 'minor', components: ['smtp'], status: 'investigating', message: 'Lo estamos mirando.' });
    let status = await service.status();
    expect(status.status).toBe('degraded');
    expect(status.components.find((c) => c.id === 'smtp')?.status).toBe('degraded');
    expect(status.incidents.open).toHaveLength(1);

    now += 3_600_000;
    await service.update(incident.id, { status: 'resolved', message: 'Arreglado.' });
    status = await service.status();
    expect(status.status).toBe('operational');
    expect(status.incidents.recent[0]).toMatchObject({ status: 'resolved', updates: [{ status: 'investigating' }, { status: 'resolved' }] });
    // Two weeks later it leaves the page.
    now += 15 * 86_400_000;
    expect((await service.status()).incidents.recent).toEqual([]);
    expect(await service.update('inc_nada', { status: 'resolved', message: 'x' })).toBeUndefined();
  });

  it('serves the status publicly, and lets platform admins report incidents', async () => {
    const app = await NestFactory.create(
      AppModule.forRoot({ httpPort: 0, smtpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: false, secureCookies: false, adminToken: 'admin' }),
      { logger: false },
    );
    await app.listen(0, '127.0.0.1');
    const base = await app.getUrl();
    try {
      const admin = (method: string, path: string, body?: unknown) =>
        fetch(`${base}${path}`, {
          method,
          headers: { authorization: 'Bearer admin', 'content-type': 'application/json' },
          ...(body !== undefined && { body: JSON.stringify(body) }),
        });
      await app.get(StatusService).sample();
      const status = await fetch(`${base}/v1/status`);
      expect(status.headers.get('cache-control')).toContain('max-age=30');
      const body = (await status.json()) as { status: string; components: Array<{ id: string; status: string }> };
      // In memory there is no database or Redis to report; the SMTP server answers.
      expect(body.components.map((c) => [c.id, c.status])).toEqual([
        ['api', 'operational'],
        ['smtp', 'operational'],
      ]);

      expect((await admin('POST', '/v1/admin/incidents', { title: 'x', impact: 'huge', components: ['api'], message: 'm' })).status).toBe(400);
      expect((await admin('POST', '/v1/admin/incidents', { title: 'x', impact: 'major', components: ['dns'], message: 'm' })).status).toBe(400);
      const opened = await admin('POST', '/v1/admin/incidents', { title: 'API caída', impact: 'major', components: ['api'], message: 'Investigando.' });
      expect(opened.status).toBe(201);
      const { id } = (await opened.json()) as { id: string };
      expect(((await (await fetch(`${base}/v1/status`)).json()) as { status: string }).status).toBe('outage');
      expect((await admin('POST', `/v1/admin/incidents/${id}/updates`, { status: 'resolved', message: 'Ya funciona.' })).status).toBe(201);
      expect(((await (await admin('GET', '/v1/admin/incidents')).json()) as { data: unknown[] }).data).toHaveLength(1);
      expect((await fetch(`${base}/v1/admin/incidents`)).status).toBe(401);
    } finally {
      await app.close();
    }
  });
});
