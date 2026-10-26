import 'reflect-metadata';
import { RequestMethod } from '@nestjs/common';
import { METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants';
import { NestFactory } from '@nestjs/core';
import { describe, expect, it } from 'vitest';
import { openApi, UNDOCUMENTED } from '../src/api/openapi.js';
import { AppModule } from '../src/app.module.js';

const config = { httpPort: 0, host: '127.0.0.1', timeScale: 0, maxHangMs: 300, signup: true, secureCookies: false };

/** Every route the app serves, as `METHOD /path/:param`, read from the controllers' decorators. */
function routes(): string[] {
  const controllers = (AppModule.forRoot(config).controllers ?? []) as Array<new (...args: never[]) => object>;
  const found: string[] = [];
  for (const controller of controllers) {
    const base = String(Reflect.getMetadata(PATH_METADATA, controller) ?? '');
    for (const name of Object.getOwnPropertyNames(controller.prototype)) {
      const handler = (controller.prototype as Record<string, unknown>)[name];
      if (name === 'constructor' || typeof handler !== 'function' || Reflect.getMetadata(PATH_METADATA, handler) === undefined) continue;
      const method = RequestMethod[Reflect.getMetadata(METHOD_METADATA, handler) as RequestMethod];
      const path = `/${base}/${String(Reflect.getMetadata(PATH_METADATA, handler))}`.replace(/\/+/g, '/').replace(/\/$/, '');
      found.push(`${method} ${path || '/'}`);
    }
  }
  return found;
}

/** The spec's operations, with `{param}` written as `:param` like the routes. */
function documented(): string[] {
  const spec = openApi();
  return Object.entries(spec.paths).flatMap(([path, operations]) =>
    Object.keys(operations).map((method) => `${method.toUpperCase()} ${path.replace(/\{(\w+)\}/g, ':$1')}`),
  );
}

describe('API reference', () => {
  it('documents every route, except the ones left out on purpose', () => {
    const served = routes();
    const inSpec = new Set(documented());
    const skipped = new Set(UNDOCUMENTED);
    const missing = served.filter((r) => !inSpec.has(r) && !skipped.has(r));
    expect(missing, 'routes neither in openapi.ts nor in UNDOCUMENTED').toEqual([]);
  });

  it('documents only routes that exist, and leaves out only routes that exist', () => {
    const served = new Set(routes());
    expect(documented().filter((r) => !served.has(r)), 'operations in openapi.ts with no route').toEqual([]);
    expect(UNDOCUMENTED.filter((r) => !served.has(r)), 'stale entries in UNDOCUMENTED').toEqual([]);
  });

  it('resolves every $ref, and gives every operation an id and a summary', () => {
    const spec = openApi('https://relayo.alimzen.com');
    const refs = JSON.stringify(spec).match(/#\/components\/schemas\/\w+/g) ?? [];
    const schemas = new Set(Object.keys(spec.components.schemas));
    expect([...new Set(refs)].filter((r) => !schemas.has(r.split('/').at(-1)!))).toEqual([]);
    const operations = Object.values(spec.paths).flatMap((ops) => Object.values(ops) as Array<{ operationId?: string; summary?: string }>);
    expect(operations.filter((o) => !o.operationId || !o.summary)).toEqual([]);
    const ids = operations.map((o) => o.operationId);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('serves the spec at /openapi.json, with the public address as server', async () => {
    const app = await NestFactory.create(AppModule.forRoot({ ...config, publicUrl: 'https://relayo.example' }), { logger: false });
    await app.listen(0, '127.0.0.1');
    try {
      const response = await fetch(`${await app.getUrl()}/openapi.json`);
      const spec = (await response.json()) as { openapi: string; servers: Array<{ url: string }>; paths: Record<string, unknown> };
      expect(spec.openapi).toBe('3.1.0');
      expect(spec.servers).toEqual([{ url: 'https://relayo.example' }]);
      expect(spec.paths['/v1/messages']).toBeDefined();
    } finally {
      await app.close();
    }
  });
});
