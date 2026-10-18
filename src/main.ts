import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import { AppModule } from './app.module.js';
import { configFromEnv } from './config.js';

const config = configFromEnv();
const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config));
app.enableShutdownHooks();
// Behind a proxy (load balancer, Fly, Render...), take the client IP from X-Forwarded-For for login limits.
if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

// The built panel (panel/dist/panel/browser) is served at /, with the API under /v1.
const panelDir = process.env.PANEL_DIR ?? join(process.cwd(), 'panel', 'dist', 'panel', 'browser');
const logger = new Logger('RelayoSim');
if (existsSync(join(panelDir, 'index.html'))) {
  app.useStaticAssets(panelDir, { index: false, maxAge: '1h' });
  // Client-side routes (/messages/123...) get the app shell.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (req.method !== 'GET' || req.path.startsWith('/v1') || req.path === '/health') return next();
    res.sendFile(join(panelDir, 'index.html'));
  });
}

await app.listen(config.httpPort, config.host);

logger.log(`HTTP API on ${await app.getUrl()}`);
logger.log(`Panel: ${existsSync(join(panelDir, 'index.html')) ? panelDir : 'not built (cd panel && pnpm build)'}`);
logger.log(`Storage: ${config.databaseUrl ? 'PostgreSQL' : 'memory'} · Queues: ${config.redisUrl ? 'BullMQ' : 'in-process'} · time scale ${config.timeScale}`);
if (!config.adminToken) logger.warn('ADMIN_TOKEN is not set: projects cannot be created over the API');
