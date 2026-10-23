import {
  BadRequestException,
  Body,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
} from '@nestjs/common';
import type { Response } from 'express';
import { composeMessage, quotedHeaders, readAttachment, readContent, readHeaders, type ApiAttachment, type MailAddress } from '../capture/capture.js';
import type { Mode, Project, SimEvent } from '../domain.js';
import { SCENARIOS } from '../scenarios/catalog.js';
import { isSmsScenario, PHONE, SMS_SCENARIOS } from '../scenarios/sms.js';
import { QuotaExceededError, SimulationService } from '../simulation/simulation.service.js';
import { SIM_CONFIG, type SimConfig } from '../config.js';
import { SIM_STORE, type ProjectChanges, type SimStore } from '../store/store.js';
import { AdminGuard, CurrentMode, CurrentProject, PlatformAdminGuard, ProjectGuard, SessionOnly } from './auth.js';
import { LiveError, LiveService } from '../live/live.service.js';
import { publicKey, publicMessage, publicProject } from './present.js';

type Address = string | { address: string; name?: string };

/** Body of `POST /v1/messages`. Mirrors Relayo's EmailMessage. */
export interface SendBody {
  from: Address;
  to: Address | Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: Address;
  headers?: Record<string, string>;
  /** Content in base64. */
  attachments?: ApiAttachment[];
  metadata?: Record<string, string>;
  tags?: string[];
  /** Relayo's message id, so events come back with it. */
  relayoMessageId?: string;
}

const EMAIL = /^[^\s@]+@[^\s@]+$/;
const EVENT_TYPES: ReadonlySet<string> = new Set<SimEvent['type']>([
  'accepted', 'delivered', 'deferred', 'bounced', 'complained', 'rejected', 'opened', 'clicked', 'unsubscribed', 'failed',
]);
const addressOf = (value: Address) => (typeof value === 'string' ? value : value?.address);
/** A Relayo recipient from an API address. */
const recipientOf = (value: Address) =>
  typeof value === 'string' ? { address: value } : { address: value.address, ...(value.name && { name: value.name }) };

/** Simulator-only headers are not passed on to real providers. */
const withoutSimHeaders = (headers: Record<string, string>) =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'x-sim-scenario'));

/** Runs a live operation, answering its errors with their status and message. */
async function liveCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LiveError) throw new HttpException({ statusCode: error.status, message: error.message }, error.status);
    throw error;
  }
}

/** The address with its display name, for the captured message's headers. */
const display = (value: Address): MailAddress =>
  typeof value === 'string' || !value.name ? addressOf(value) : { name: value.name, address: value.address };

function checkAttachments(value: unknown): ApiAttachment[] | undefined {
  if (value === undefined) return undefined;
  const ok =
    Array.isArray(value) &&
    value.every(
      (a: Partial<ApiAttachment>) =>
        a && typeof a.filename === 'string' && a.filename && typeof a.content === 'string' &&
        (a.contentType === undefined || typeof a.contentType === 'string') && (a.cid === undefined || typeof a.cid === 'string'),
    );
  if (!ok) throw new BadRequestException('"attachments" must be a list of { filename, content (base64), contentType?, cid? }');
  return value as ApiAttachment[];
}

@Controller('v1')
export class ScenariosController {
  /** Email scenarios (selected by address) and SMS scenarios (selected by number), each with its `channel`. */
  @Get('scenarios')
  list() {
    return {
      data: [
        ...SCENARIOS.map(({ name, description, example }) => ({ name, description, example, channel: 'email' })),
        ...SMS_SCENARIOS.map(({ name, description, number }) => ({ name, description, example: number, channel: 'sms' })),
      ],
    };
  }
}

/** Body of `POST /v1/sms`. Mirrors Relayo's SmsMessage. */
export interface SendSmsBody {
  from?: string;
  to: Address | Address[];
  body: string;
  metadata?: Record<string, string>;
  tags?: string[];
  /** Relayo's message id, so events come back with it. */
  relayoMessageId?: string;
  /** Scenario for every recipient, instead of the magic numbers. */
  scenario?: string;
}

/** Sender ids: a phone number, or up to 11 letters and digits (alphanumeric sender id). */
const SENDER = /^(\+[1-9]\d{7,14}|[A-Za-z0-9 ]{1,11})$/;

@Controller('v1/sms')
@UseGuards(ProjectGuard)
export class SmsController {
  constructor(
    @Inject(SimulationService) private readonly sim: SimulationService,
    @Inject(LiveService) private readonly live: LiveService,
  ) {}

  /** Like a provider's SMS API: always accepted (202); each number plays its scenario as events. */
  @Post()
  @HttpCode(202)
  async send(@CurrentProject() project: Project, @CurrentMode() mode: Mode, @Body() body: SendSmsBody) {
    const to = (Array.isArray(body?.to) ? body.to : [body?.to]).map((a) => addressOf(a as Address)?.trim());
    if (!to.length || to.some((n) => !n || !PHONE.test(n))) {
      throw new BadRequestException('"to" must contain phone numbers in E.164 format, e.g. +12015550100');
    }
    if (typeof body.body !== 'string' || !body.body.trim()) throw new BadRequestException('"body" is required');
    if (body.body.length > 1600) throw new BadRequestException('"body" can have at most 1600 characters');
    const from = body.from?.trim() || 'RelayoSim';
    if (!SENDER.test(from)) throw new BadRequestException('"from" must be a phone number (E.164) or an alphanumeric sender id of up to 11 characters');
    if (body.scenario !== undefined && (typeof body.scenario !== 'string' || !isSmsScenario(body.scenario.trim().toLowerCase()))) {
      throw new BadRequestException(`Unknown SMS scenario "${String(body.scenario)}"`);
    }

    try {
      await this.sim.reserve(project, mode);
    } catch (error) {
      if (error instanceof QuotaExceededError) throw new HttpException({ statusCode: 429, message: error.message }, 429);
      throw error;
    }

    if (mode === 'live') {
      const live = await liveCall(() =>
        this.live.sendSms(project, {
          ...(body.from?.trim() && { from: body.from.trim() }),
          to: to as string[],
          body: body.body,
          ...(body.relayoMessageId && { relayoMessageId: body.relayoMessageId }),
          ...(body.metadata && { metadata: body.metadata }),
          ...(body.tags && { tags: body.tags }),
        }),
      );
      return { id: live.id, status: 'queued', recipients: live.recipients };
    }

    const message = await this.sim.acceptSms(project, {
      from,
      to: to as string[],
      body: body.body,
      ...(body.relayoMessageId && { relayoMessageId: body.relayoMessageId }),
      ...(body.metadata && { metadata: body.metadata }),
      ...(body.tags && { tags: body.tags }),
      ...(body.scenario && { scenario: body.scenario }),
    });
    return { id: message.id, status: 'queued', recipients: message.recipients };
  }
}

@Controller('v1/messages')
@UseGuards(ProjectGuard)
export class MessagesController {
  constructor(
    @Inject(SimulationService) private readonly sim: SimulationService,
    @Inject(SIM_STORE) private readonly store: SimStore,
    @Inject(LiveService) private readonly live: LiveService,
  ) {}

  /** Test keys: the simulator plays the scenario. Live keys: real delivery through the project's connections. */
  @Post()
  @HttpCode(202)
  async send(@CurrentProject() project: Project, @CurrentMode() mode: Mode, @Body() body: SendBody) {
    const from = addressOf(body?.from);
    const to = [...(Array.isArray(body?.to) ? body.to : [body?.to]), ...(body?.cc ?? []), ...(body?.bcc ?? [])].map(addressOf);
    if (!from || !EMAIL.test(from)) throw new BadRequestException('"from" must be an email address');
    if (!to.length || to.some((a) => !a || !EMAIL.test(a))) throw new BadRequestException('"to" must contain email addresses');
    if (typeof body.subject !== 'string') throw new BadRequestException('"subject" is required');

    const scenarioHeader = Object.entries(body.headers ?? {}).find(([k]) => k.toLowerCase() === 'x-sim-scenario')?.[1];
    const attachments = checkAttachments(body.attachments);
    if (body.headers !== undefined && (typeof body.headers !== 'object' || Object.values(body.headers).some((v) => typeof v !== 'string'))) {
      throw new BadRequestException('"headers" must map names to strings');
    }

    try {
      await this.sim.reserve(project, mode);
    } catch (error) {
      if (error instanceof QuotaExceededError) throw new HttpException({ statusCode: 429, message: error.message }, 429);
      throw error;
    }

    // Capture the email the provider would have sent, as SMTP mail is captured.
    const toList = Array.isArray(body.to) ? body.to : [body.to];
    const raw = await composeMessage({
      from: display(body.from),
      to: toList.map((a) => display(a)),
      ...(body.cc?.length && { cc: body.cc.map((a) => display(a)) }),
      ...(body.replyTo && { replyTo: display(body.replyTo) }),
      subject: body.subject,
      ...(typeof body.text === 'string' && { text: body.text }),
      ...(typeof body.html === 'string' && { html: body.html }),
      headers: {
        ...body.headers,
        ...(body.relayoMessageId && { 'X-Relayo-Message-ID': body.relayoMessageId }),
        ...(body.metadata && { 'X-Relayo-Metadata': Buffer.from(JSON.stringify(body.metadata)).toString('base64url') }),
      },
      ...(attachments && { attachments }),
    });

    if (mode === 'live') {
      const message = await liveCall(() =>
        this.live.sendEmail(project, {
          via: 'api',
          raw,
          headers: quotedHeaders(readHeaders(raw.toString('utf8'))),
          ...(body.relayoMessageId && { relayoMessageId: body.relayoMessageId }),
          message: {
            from: recipientOf(body.from),
            to: toList.map(recipientOf),
            ...(body.cc?.length && { cc: body.cc.map(recipientOf) }),
            ...(body.bcc?.length && { bcc: body.bcc.map(recipientOf) }),
            ...(body.replyTo && { replyTo: recipientOf(body.replyTo) }),
            subject: body.subject,
            ...(typeof body.text === 'string' && { text: body.text }),
            ...(typeof body.html === 'string' && { html: body.html }),
            ...(body.headers && Object.keys(body.headers).length && { headers: withoutSimHeaders(body.headers) }),
            ...(attachments?.length && {
              attachments: attachments.map((a) => ({
                filename: a.filename,
                content: Buffer.from(a.content, 'base64'),
                ...(a.contentType && { contentType: a.contentType }),
                ...(a.cid && { cid: a.cid }),
              })),
            }),
            ...(body.metadata && { metadata: body.metadata }),
            ...(body.tags && { tags: body.tags }),
          },
        }),
      );
      return { id: message.id, status: 'queued', recipients: message.recipients };
    }

    const message = await this.sim.acceptFromApi(project, {
      raw,
      headers: quotedHeaders(readHeaders(raw.toString('utf8'))),
      from,
      to: to as string[],
      subject: body.subject,
      ...(body.relayoMessageId && { relayoMessageId: body.relayoMessageId }),
      ...(body.metadata && { metadata: body.metadata }),
      ...(body.tags && { tags: body.tags }),
      ...(scenarioHeader && { scenarioHeader }),
    });
    return { id: message.id, status: 'queued', recipients: message.recipients };
  }

  /** Newest first. `q` searches subject, sender and recipients; `status` keeps messages with that event type. */
  @Get()
  async list(
    @CurrentProject() project: Project,
    @CurrentMode() mode: Mode,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
    @Query('channel') channel?: string,
  ) {
    const max = Math.min(100, Math.max(1, Number(limit) || 25));
    const beforeDate = before ? new Date(before) : undefined;
    if (status && !EVENT_TYPES.has(status)) throw new BadRequestException(`Unknown status "${status}"`);
    if (channel && channel !== 'email' && channel !== 'sms') throw new BadRequestException('"channel" must be email or sms');
    const messages = await this.store.listMessages(project.id, {
      limit: max,
      ...(beforeDate && !Number.isNaN(beforeDate.getTime()) && { before: beforeDate }),
      ...(q?.trim() && { search: q.trim().slice(0, 200) }),
      ...(status && { status: status as SimEvent['type'] }),
      ...(channel && { channel: channel as 'email' | 'sms' }),
      mode,
    });
    return { data: messages.map(publicMessage) };
  }

  /** The captured email, read for display: bodies, headers and attachments. */
  @Get(':id/content')
  async content(@CurrentProject() project: Project, @Param('id') id: string) {
    return readContent(await this.raw(project, id));
  }

  /** The captured email as it arrived (`.eml`). */
  @Get(':id/raw')
  async original(@CurrentProject() project: Project, @Param('id') id: string, @Res() res: Response) {
    const raw = await this.raw(project, id);
    res.setHeader('Content-Type', 'message/rfc822');
    res.setHeader('Content-Disposition', `attachment; filename="${id}.eml"`);
    res.send(raw);
  }

  @Get(':id/attachments/:index')
  async attachment(@CurrentProject() project: Project, @Param('id') id: string, @Param('index') index: string, @Res() res: Response) {
    const found = /^\d+$/.test(index) ? await readAttachment(await this.raw(project, id), Number(index)) : undefined;
    if (!found) throw new NotFoundException('Attachment not found');
    // Always a download: captured content is untrusted and must not render on the simulator's origin.
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename*=UTF-8''${encodeURIComponent(found.filename)}`);
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.send(found.content);
  }

  private async raw(project: Project, id: string): Promise<Buffer> {
    const raw = await this.store.getContent(project.id, id);
    if (!raw) throw new NotFoundException('This message has no captured content');
    return raw;
  }

  /** The bounce (DSN) or complaint (ARF) report an event produced, as a raw email. */
  @Get(':id/events/:eventId/report')
  @Header('Content-Type', 'message/rfc822')
  async report(@CurrentProject() project: Project, @Param('id') id: string, @Param('eventId') eventId: string) {
    if (!eventId.startsWith(`${id}:`)) throw new NotFoundException('Event not found');
    const report = await this.sim.report(project, eventId);
    if (!report) throw new NotFoundException('This event has no report');
    return report;
  }

  @Get(':id')
  async get(@CurrentProject() project: Project, @Param('id') id: string) {
    const message = await this.store.getMessage(project.id, id);
    if (!message) throw new NotFoundException(`Message ${id} not found`);
    const { events, ...rest } = message;
    return { ...publicMessage(rest), events: events.map(({ projectId: _p, ...e }) => e) };
  }
}

@Controller('v1/project')
@UseGuards(ProjectGuard)
export class ProjectController {
  constructor(
    @Inject(SimulationService) private readonly sim: SimulationService,
    @Inject(SIM_STORE) private readonly store: SimStore,
    @Inject(SIM_CONFIG) private readonly config: SimConfig,
    @Inject(LiveService) private readonly live: LiveService,
  ) {}

  @Get()
  get(@CurrentProject() project: Project) {
    return publicProject(project);
  }

  /** `null` or `""` clears `webhookUrl` / `reportsSmtpUrl`; missing keys are left as they are. */
  @Patch()
  async update(
    @CurrentProject() project: Project,
    @Body() body: { name?: string; webhookUrl?: string | null; reportsSmtpUrl?: string | null },
  ) {
    const changes: ProjectChanges = {};
    if (typeof body?.name === 'string') {
      const name = body.name.trim();
      if (!name || name.length > 80) throw new BadRequestException('"name" must have 1 to 80 characters');
      changes.name = name;
    }
    const webhookUrl = urlChange(body?.webhookUrl, /^https?:\/\//, '"webhookUrl" must be an http(s) url');
    const reportsSmtpUrl = urlChange(body?.reportsSmtpUrl, /^smtps?:\/\//, '"reportsSmtpUrl" must be an smtp:// or smtps:// url');
    if (webhookUrl !== undefined) changes.webhookUrl = webhookUrl;
    if (reportsSmtpUrl !== undefined) changes.reportsSmtpUrl = reportsSmtpUrl;
    await this.store.updateProject(project.id, changes);
    return publicProject((await this.store.getProject(project.id))!);
  }

  /** This month's usage against the plan, and how long messages are kept. */
  @Get('usage')
  async usage(@CurrentProject() project: Project) {
    return { ...(await this.sim.usage(project)), retentionDays: this.config.retentionDays ?? 7 };
  }

  /** Totals and a per-day series over the last `days` days (1–90, default 7). */
  @Get('stats')
  async stats(@CurrentProject() project: Project, @CurrentMode() mode: Mode, @Query('days') days?: string) {
    const span = Math.min(90, Math.max(1, Number(days) || 7));
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (span - 1));
    return this.store.stats(project.id, since, mode);
  }

  @Get('keys')
  @SessionOnly()
  async keys(@CurrentProject() project: Project) {
    return { data: (await this.store.listApiKeys(project.id)).map(publicKey) };
  }

  /** A new API key. The key itself is only in this response. */
  @Post('keys')
  @SessionOnly()
  async createKey(@CurrentProject() project: Project, @Body() body: { name?: unknown; mode?: unknown }) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 60) throw new BadRequestException('El nombre de la clave debe tener entre 1 y 60 caracteres.');
    if (body.mode !== undefined && body.mode !== 'test' && body.mode !== 'live') throw new BadRequestException('"mode" must be test or live');
    if (body.mode === 'live') await liveCall(() => this.live.assertCanGoLive(project));
    const { key, apiKey } = await this.sim.createApiKey(project.id, name, body.mode === 'live' ? 'live' : 'test');
    return { ...publicKey(key), apiKey };
  }

  @Delete('keys/:id')
  @HttpCode(204)
  @SessionOnly()
  async revokeKey(@CurrentProject() project: Project, @Param('id') id: string) {
    if (!(await this.store.revokeApiKey(project.id, id))) throw new NotFoundException('Key not found or already revoked');
  }

  @Get('webhook-secret')
  @SessionOnly()
  webhookSecret(@CurrentProject() project: Project) {
    return { webhookSecret: project.webhookSecret };
  }

  @Post('webhook-secret/rotate')
  @SessionOnly()
  async rotateWebhookSecret(@CurrentProject() project: Project) {
    return { webhookSecret: await this.sim.rotateWebhookSecret(project.id) };
  }
}

/** `undefined`: leave as is; `null`: clear; otherwise a validated url. */
function urlChange(value: unknown, pattern: RegExp, error: string): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  if (!pattern.test(value)) throw new BadRequestException(error);
  return value;
}

/** Platform admins (ADMIN_EMAILS, or the admin token): review of Relayo's own sending. */
@Controller('v1/admin/managed')
@UseGuards(PlatformAdminGuard)
export class ManagedReviewController {
  constructor(
    @Inject(LiveService) private readonly live: LiveService,
    @Inject(SIM_STORE) private readonly store: SimStore,
    @Inject(SimulationService) private readonly sim: SimulationService,
  ) {}

  /** Every project that asked, with its owner and this month's usage, pending ones first. */
  @Get()
  async list() {
    const projects = await this.store.listManagedAccess();
    const rows = await Promise.all(
      projects.map(async (project) => {
        const owner = project.ownerId ? await this.store.getUser(project.ownerId) : undefined;
        const domains = await this.store.listDomains(project.id);
        return {
          project: publicProject(project),
          owner: owner ? { email: owner.email, name: owner.name, createdAt: owner.createdAt } : null,
          domains: domains.map((d) => ({ domain: d.domain, verified: !!d.verifiedAt })),
          usage: (await this.sim.usage(project)).live,
        };
      }),
    );
    const rank = (access: string | null) => (access === 'requested' ? 0 : 1);
    return { data: rows.sort((a, b) => rank(a.project.managedAccess) - rank(b.project.managedAccess)) };
  }

  @Post(':projectId')
  @HttpCode(200)
  async decide(@Param('projectId') projectId: string, @Body() body: { decision?: unknown }) {
    return publicProject(await liveCall(() => this.live.decideManagedAccess(projectId, body?.decision)));
  }
}

/** For operators: creates projects outside any account (scripts, CI, migrations). */
@Controller('v1/admin/projects')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(@Inject(SimulationService) private readonly sim: SimulationService) {}

  /** Creates a project. The API key and webhook secret are only shown in this response. */
  @Post()
  async create(@Body() body: { name?: string; webhookUrl?: string }) {
    if (typeof body?.name !== 'string' || !body.name.trim()) throw new BadRequestException('"name" is required');
    const { project, apiKey } = await this.sim.createProject(body.name.trim(), {
      ...(typeof body.webhookUrl === 'string' && { webhookUrl: body.webhookUrl }),
    });
    return { ...publicProject(project), apiKey, webhookSecret: project.webhookSecret };
  }
}

@Controller()
export class HealthController {
  /** `commit` is the build's git commit (GIT_SHA), so a deploy can tell when the new version is live. */
  @Get('health')
  health() {
    return { ok: true, ...(process.env.GIT_SHA && { commit: process.env.GIT_SHA }) };
  }
}

/** Live delivery: the project's provider connections. Managing them needs a signed-in person. */
@Controller('v1/project')
@UseGuards(ProjectGuard)
export class ConnectionsController {
  constructor(
    @Inject(LiveService) private readonly live: LiveService,
    @Inject(SIM_STORE) private readonly store: SimStore,
  ) {}

  @Get('providers')
  providers() {
    return { data: this.live.providers() };
  }

  /** Domains for Relayo's managed sending, with the DNS records each one needs. */
  @Get('domains')
  async domains(@CurrentProject() project: Project) {
    return {
      available: Boolean(this.live.managed),
      access: project.managedAccess ?? null,
      data: (await this.store.listDomains(project.id)).map((d) => this.live.publicDomain(d)),
    };
  }

  /** Asks for Relayo's own sending; an admin reviews the request unless MANAGED_APPROVAL=auto. */
  @Post('managed-access')
  @SessionOnly()
  @HttpCode(200)
  async requestManagedAccess(@CurrentProject() project: Project) {
    return { access: await liveCall(() => this.live.requestManagedAccess(project)) };
  }

  @Post('domains')
  @SessionOnly()
  async addDomain(@CurrentProject() project: Project, @Body() body: { domain?: unknown }) {
    return this.live.publicDomain(await liveCall(() => this.live.addDomain(project, body?.domain)));
  }

  @Post('domains/:id/verify')
  @SessionOnly()
  @HttpCode(200)
  async verifyDomain(@CurrentProject() project: Project, @Param('id') id: string) {
    return this.live.publicDomain(await liveCall(() => this.live.verifyDomain(project, id)));
  }

  @Delete('domains/:id')
  @SessionOnly()
  @HttpCode(204)
  async deleteDomain(@CurrentProject() project: Project, @Param('id') id: string) {
    if (!(await this.store.deleteDomain(project.id, id))) throw new NotFoundException('Dominio no encontrado');
  }

  @Get('connections')
  async list(@CurrentProject() project: Project) {
    return { data: (await this.store.listConnections(project.id)).map((c) => this.live.publicConnection(c)) };
  }

  @Post('connections')
  @SessionOnly()
  async create(@CurrentProject() project: Project, @Body() body: { name?: unknown; provider?: unknown; values?: unknown }) {
    return this.live.publicConnection(await liveCall(() => this.live.createConnection(project, body ?? {})));
  }

  /** Sets the order: the first connection sends, the rest are failover. */
  @Post('connections/order')
  @SessionOnly()
  @HttpCode(204)
  async reorder(@CurrentProject() project: Project, @Body() body: { ids?: unknown }) {
    if (!Array.isArray(body?.ids) || body.ids.some((id) => typeof id !== 'string')) throw new BadRequestException('"ids" must list connection ids');
    await liveCall(() => this.live.reorder(project, body.ids as string[]));
  }

  @Patch('connections/:id')
  @SessionOnly()
  async update(@CurrentProject() project: Project, @Param('id') id: string, @Body() body: { name?: unknown; values?: unknown }) {
    return this.live.publicConnection(await liveCall(() => this.live.updateConnection(project, id, body ?? {})));
  }

  @Delete('connections/:id')
  @SessionOnly()
  @HttpCode(204)
  async remove(@CurrentProject() project: Project, @Param('id') id: string) {
    if (!(await this.store.deleteConnection(project.id, id))) throw new NotFoundException('Conexión no encontrada');
  }

  /** Sends a real test email through one connection. */
  @Post('connections/:id/test')
  @SessionOnly()
  async test(@CurrentProject() project: Project, @Param('id') id: string, @Body() body: { to?: unknown; from?: unknown }) {
    const message = await liveCall(() => this.live.testConnection(project, id, body ?? {}));
    return { id: message.id, delivery: message.delivery };
  }

  @Get('suppressions')
  async suppressions(@CurrentProject() project: Project, @Query('limit') limit?: string) {
    const max = Math.min(1000, Math.max(1, Number(limit) || 200));
    return { data: await this.store.listSuppressions(project.id, max) };
  }

  @Post('suppressions')
  @HttpCode(204)
  async suppress(@CurrentProject() project: Project, @Body() body: { address?: unknown }) {
    const address = typeof body?.address === 'string' ? body.address.trim() : '';
    if (!address) throw new BadRequestException('"address" is required');
    await this.store.suppress(project.id, address, 'manual');
  }

  @Delete('suppressions/:address')
  @HttpCode(204)
  async unsuppress(@CurrentProject() project: Project, @Param('address') address: string) {
    if (!(await this.store.unsuppress(project.id, address))) throw new NotFoundException('That address is not suppressed');
  }
}

/**
 * Where providers post their delivery events for a connection. The secret token in the path identifies
 * the connection; the provider's own signature is checked too when it signs them.
 */
@Controller('v1/inbound')
export class InboundController {
  constructor(@Inject(LiveService) private readonly live: LiveService) {}

  /** Events of Relayo's own relay (Amazon SNS), for every project. */
  @Post('managed/:token')
  @HttpCode(200)
  async managed(@Param('token') token: string, @Req() req: InboundRequest) {
    const rawBody = req.rawBody ?? (typeof req.body === 'string' ? req.body : undefined);
    const body = typeof req.body === 'string' && req.body.trim().startsWith('{') ? JSON.parse(req.body) : req.body;
    const received = await liveCall(() => this.live.handleManagedInbound(token, { headers: req.headers, body, ...(rawBody !== undefined && { rawBody }) }));
    return { received };
  }

  @Post(':token')
  @HttpCode(200)
  async receive(@Param('token') token: string, @Req() req: InboundRequest) {
    const rawBody = req.rawBody ?? (typeof req.body === 'string' ? req.body : undefined);
    const body = typeof req.body === 'string' && req.body.trim().startsWith('{') ? JSON.parse(req.body) : req.body;
    const received = await liveCall(() =>
      this.live.handleInbound(token, {
        headers: req.headers,
        body,
        ...(rawBody !== undefined && { rawBody }),
        // Twilio signs the URL it called, and carries the message id in its query.
        ...(req.originalUrl && { url: req.originalUrl }),
      }),
    );
    return { received };
  }
}

interface InboundRequest {
  headers: Record<string, string | string[] | undefined>;
  originalUrl?: string;
  body?: unknown;
  rawBody?: Buffer;
}
