import 'reflect-metadata';
import { NestFactory } from '@nestjs/core';
import type { Response } from 'express';
import { describe, expect, it } from 'vitest';
import { HealthController } from '../src/api/controllers.js';
import { AppModule } from '../src/app.module.js';
import type { Infrastructure } from '../src/infrastructure.js';

describe('health', () => {
  it('answers 200 with nothing to check when everything is in memory', async () => {
    const app = await NestFactory.create(
      AppModule.forRoot({ httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: true, secureCookies: false }),
      { logger: false },
    );
    await app.listen(0, '127.0.0.1');
    try {
      const response = await fetch(`${await app.getUrl()}/health`);
      expect(response.status).toBe(200);
      expect(await response.json()).toMatchObject({ ok: true, checks: {} });
    } finally {
      await app.close();
    }
  });

  it('answers 503, saying which dependency failed, when one does not answer', async () => {
    const infra = { check: async () => ({ database: 'connect ECONNREFUSED 10.0.0.5:5432', redis: 'ok' }) } as unknown as Infrastructure;
    let status = 200;
    const res = { status: (code: number) => ((status = code), res) } as unknown as Response;
    const body = await new HealthController(infra).health(res);
    expect(status).toBe(503);
    expect(body).toMatchObject({ ok: false, checks: { database: 'connect ECONNREFUSED 10.0.0.5:5432', redis: 'ok' } });
  });
});
