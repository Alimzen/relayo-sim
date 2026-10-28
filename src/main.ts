import 'reflect-metadata';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import { ConsoleLogger, Logger } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { NextFunction, Request, Response } from 'express';
import helmet from 'helmet';
import morgan from 'morgan';
import { AppModule } from './app.module.js';
import { configFromEnv, type SimConfig } from './config.js';

const logger = new Logger('RelayoSim');

async function bootstrap(): Promise<void> {
  const config = configFromEnv();
  const app = await NestFactory.create<NestExpressApplication>(AppModule.forRoot(config), {
    // Colors only in a terminal: in Docker/Dokploy logs they show up as escape codes.
    logger: new ConsoleLogger({ colors: Boolean(process.stdout.isTTY) }),
    // Provider webhooks (live mode) are signed over the exact bytes received.
    rawBody: true,
  });
  // Closes the SMTP server, queues and database on SIGTERM/SIGINT (Lifecycle in app.module).
  app.enableShutdownHooks();

  // Behind a proxy (Traefik, Caddy, a load balancer), take the client IP from X-Forwarded-For: login limits and logs use it.
  if (process.env.TRUST_PROXY) app.set('trust proxy', Number(process.env.TRUST_PROXY) || process.env.TRUST_PROXY);

  // --- Security -----------------------------------------------------------------------------------

  app.use(
    helmet({
      // No CSP header: the panel's build loads its CSS with an inline onload handler, and the email preview's
      // srcdoc frame inherits the page's CSP (it would block the email's images). The preview has its own
      // CSP and sandbox instead.
      contentSecurityPolicy: false,
      // The email preview loads remote images that don't send CORP headers.
      crossOriginEmbedderPolicy: false,
    }),
  );

  // TRACE/TRACK echo requests back (cross-site tracing); CONNECT is for proxies.
  app.use((req: Request, res: Response, next: NextFunction) => {
    if (['TRACE', 'TRACK', 'CONNECT'].includes(req.method)) return res.status(405).send('Method Not Allowed');
    next();
  });

  // No CORS on purpose: the panel is served from this same origin, and the API is called server to server
  // with API keys. Allowing other origins with credentials would weaken the X-Relayo-Client CSRF check.

  // --- Request log --------------------------------------------------------------------------------

  // One line per request, without the health check noise and without secrets in the URL (reset tokens).
  morgan.token('safe-url', (req: Request) => redactUrl(req.originalUrl ?? req.url));
  app.use(
    morgan(':remote-addr :method :safe-url :status :res[content-length] - :response-time ms', {
      skip: (req: Request) => req.path === '/health',
    }),
  );

  // --- Body ---------------------------------------------------------------------------------------

  // API sends carry attachments in base64: room for a 25 MB message.
  app.useBodyParser('json', { limit: '35mb' });
  // Amazon SNS posts its JSON as text/plain (received emails included: room for them).
  app.useBodyParser('text', { type: 'text/plain', limit: '35mb' });
  // Received emails posted as they are.
  app.useBodyParser('raw', { type: 'message/rfc822', limit: '35mb' });
  // Mailgun routes post their fields (the whole email in body-mime) form-encoded.
  app.useBodyParser('urlencoded', { extended: false, limit: '35mb' });

  // --- Landing and panel --------------------------------------------------------------------------

  // The API reference (public/docs.html), part of the platform.
  const publicDir = join(process.cwd(), 'public');
  app.use('/docs', (req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || (req.path !== '/' && req.path !== '')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(publicDir, 'docs.html'));
  });

  // The public status page (public/status.html), from /v1/status.
  app.use('/status', (req: Request, res: Response, next: NextFunction) => {
    if ((req.method !== 'GET' && req.method !== 'HEAD') || (req.path !== '/' && req.path !== '')) return next();
    res.setHeader('Cache-Control', 'no-cache');
    res.sendFile(join(publicDir, 'status.html'));
  });

  // An installation's own website (SITE_DIR, ./site by default; not in this repository): its index.html at /,
  // each other page.html at /page, and its assets under /site/. Without one, / is the panel.
  const siteDir = process.env.SITE_DIR ?? process.env.LANDING_DIR ?? join(process.cwd(), 'site');
  if (existsSync(join(siteDir, 'index.html'))) {
    app.useStaticAssets(siteDir, { prefix: '/site/', index: false, maxAge: '1d' });
    app.use((req: Request, res: Response, next: NextFunction) => {
      if (req.method !== 'GET' && req.method !== 'HEAD') return next();
      const name = req.path === '/' ? 'index' : /^\/[a-z0-9-]+$/i.test(req.path) ? req.path.slice(1) : undefined;
      const page = name && join(siteDir, `${name}.html`);
      if (!page || !existsSync(page)) return next();
      res.setHeader('Cache-Control', 'no-cache');
      res.sendFile(page);
    });
  }

  // The built panel (panel/dist/panel/browser) is served for every other page, with the API under /v1.
  const panelDir = process.env.PANEL_DIR ?? join(process.cwd(), 'panel', 'dist', 'panel', 'browser');
  const panelBuilt = existsSync(join(panelDir, 'index.html'));
  if (panelBuilt) {
    app.useStaticAssets(panelDir, { index: false, maxAge: '1h' });
    // Client-side routes (/messages/123...) get the app shell; the server's own routes go on to Nest.
    const serverRoutes = ['/v1', '/health', '/openapi.json', '/u/', '/t/'];
    app.use((req: Request, res: Response, next: NextFunction) => {
      if ((req.method !== 'GET' && req.method !== 'HEAD') || serverRoutes.some((p) => req.path.startsWith(p))) return next();
      res.sendFile(join(panelDir, 'index.html'));
    });
  }

  await app.listen(config.httpPort, config.host);
  logStartup(config, await app.getUrl(), panelBuilt ? panelDir : undefined);
}

/** What is running and how it is configured, without secrets: the first thing to read in the deploy logs. */
function logStartup(config: SimConfig, url: string, panelDir: string | undefined): void {
  const limits = config.limits;
  logger.log(`HTTP API on ${url}${process.env.GIT_SHA ? ` · commit ${process.env.GIT_SHA.slice(0, 7)}` : ''}`);
  logger.log(`Panel: ${panelDir ?? 'not built (cd panel && pnpm build)'}`);
  logger.log(`Storage: ${config.databaseUrl ? 'PostgreSQL' : 'memory'} · Queues: ${config.redisUrl ? 'BullMQ' : 'in-process'} · time scale ${config.timeScale}`);
  logger.log(
    `Public URL ${config.publicUrl ?? '-'} · retention ${config.retentionDays ? `${config.retentionDays} days` : 'forever'}` +
      ` · limits ${limits?.monthlyMessages || '∞'}/month (live ${limits?.liveMonthlyMessages || '∞'}), ${limits?.messagesPerMinute || '∞'}/min · sign-up ${config.signup ? 'open' : 'closed'}`,
  );
  if (!config.mail) logger.warn('MAIL_URL is not set: password reset links go to this log instead of by email');
  if (!config.adminToken) logger.warn('ADMIN_TOKEN is not set: projects cannot be created with the admin API');
  if (config.smtpPort !== undefined && !config.tls) logger.warn('SMTP without STARTTLS: API keys travel in clear text (set TLS_KEY_FILE/TLS_CERT_FILE)');
}

/** Hides the values of secret query parameters in logged URLs. */
export function redactUrl(url: string): string {
  return url.replace(/([?&](?:token|apiKey|api_key|key|password)=)[^&#]*/gi, '$1***');
}

bootstrap().catch((error: unknown) => {
  logger.error(`Could not start Relayo Sim: ${error instanceof Error ? error.message : String(error)}`, error instanceof Error ? error.stack : undefined);
  process.exit(1);
});
