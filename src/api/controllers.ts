import {
  BadRequestException,
  Body,
  ConflictException,
  ForbiddenException,
  HttpException,
  Controller,
  Delete,
  Get,
  Header,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  Req,
  Res,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import type { Response } from 'express';
import { readAttachment, readContent } from '../capture/capture.js';
import type { WebhookEndpoint, Mode, Project, ProjectLimits, ProjectRole, User, ScheduledSend, SimEvent, Template, WebhookAttempt } from '../domain.js';
import { ScheduledSends } from './scheduled.js';
import { TemplatesService, variablesOf as templateVariables } from '../templates/templates.js';
import { attemptRecord, attemptWebhook, recordAttempt, WEBHOOK_EVENT_TYPES, webhookBody, type WebhookTarget } from '../webhooks/webhooks.js';
import { SCENARIOS } from '../scenarios/catalog.js';
import { SMS_SCENARIOS } from '../scenarios/sms.js';
import { newWebhookSecret, SimulationService } from '../simulation/simulation.service.js';
import { SIM_CONFIG, type SimConfig } from '../config.js';
import { SIM_STORE, type ProjectChanges, type SimStore, type WebhookEndpointChanges } from '../store/store.js';
import { AdminGuard, CurrentMode, CurrentProject, CurrentRole, CurrentUser, PlatformAdminGuard, ProjectAdmin, ProjectGuard, Sends, SessionGuard, SessionOnly } from './auth.js';
import { TeamError, TeamService } from '../accounts/team.js';
import { LiveService } from '../live/live.service.js';
import { INFRASTRUCTURE, type Infrastructure } from '../infrastructure.js';
import { AccountsService } from '../accounts/accounts.service.js';
import { IdempotencyInterceptor } from './idempotency.js';
import { openApi } from './openapi.js';
import { liveCall, renderTemplate, SendingService, variablesOf, type SendBody, type SendSmsBody } from './sending.js';
import { publicKey, publicMessage, publicProject } from './present.js';
import { ActivityLog, NoAudit } from './activity.js';

const EVENT_TYPES: ReadonlySet<string> = new Set<SimEvent['type']>([
  'accepted', 'delivered', 'deferred', 'bounced', 'complained', 'rejected', 'opened', 'clicked', 'unsubscribed', 'failed',
]);

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

@Controller('v1/sms')
@UseGuards(ProjectGuard)
export class SmsController {
  constructor(
    @Inject(SendingService) private readonly sending: SendingService,
    @Inject(ScheduledSends) private readonly scheduled: ScheduledSends,
  ) {}

  /** Like a provider's SMS API: always accepted (202); each number plays its scenario as events. */
  @Post()
  @Sends()
  @HttpCode(202)
  @UseInterceptors(IdempotencyInterceptor)
  async send(@CurrentProject() project: Project, @CurrentMode() mode: Mode, @Body() body: SendSmsBody) {
    if (body?.sendAt !== undefined) return this.scheduled.schedule(project, mode, 'sms', body);
    return this.sending.sms(project, mode, body);
  }
}

@Controller('v1/messages')
@UseGuards(ProjectGuard)
export class MessagesController {
  constructor(
    @Inject(SimulationService) private readonly sim: SimulationService,
    @Inject(SIM_STORE) private readonly store: SimStore,
    @Inject(SendingService) private readonly sending: SendingService,
    @Inject(ScheduledSends) private readonly scheduled: ScheduledSends,
  ) {}

  /** Test keys: the simulator plays the scenario. Live keys: real delivery through the project's connections. */
  @Post()
  @Sends()
  @HttpCode(202)
  @UseInterceptors(IdempotencyInterceptor)
  async send(@CurrentProject() project: Project, @CurrentMode() mode: Mode, @Body() body: SendBody) {
    if (body?.sendAt !== undefined) return this.scheduled.schedule(project, mode, 'email', body);
    return this.sending.email(project, mode, body);
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
  @ProjectAdmin()
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

  /**
   * Deletes the project with everything in it: messages, keys, connections, templates, members. Only its
   * owner, from the panel, confirming with the project's name.
   */
  @Delete()
  @SessionOnly()
  @HttpCode(204)
  async remove(@CurrentProject() project: Project, @CurrentRole() role: ProjectRole, @Body() body: { confirm?: unknown }) {
    if (role !== 'owner') throw new ForbiddenException('Solo el dueño del proyecto puede eliminarlo.');
    if (body?.confirm !== project.name) throw new BadRequestException('Escribe el nombre del proyecto para confirmar.');
    await this.store.deleteProject(project.id);
  }

  /** This month's usage against the plan, and how long messages are kept. */
  @Get('usage')
  async usage(@CurrentProject() project: Project) {
    return { ...(await this.sim.usage(project)), retentionDays: project.limits?.retentionDays ?? this.config.retentionDays ?? 7 };
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
  async createKey(
    @CurrentProject() project: Project,
    @Body() body: { name?: unknown; mode?: unknown; permission?: unknown; allowedDomains?: unknown },
  ) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 60) throw new BadRequestException('El nombre de la clave debe tener entre 1 y 60 caracteres.');
    if (body.mode !== undefined && body.mode !== 'test' && body.mode !== 'live') throw new BadRequestException('"mode" must be test or live');
    const permission = body.permission ?? 'full';
    if (permission !== 'full' && permission !== 'send' && permission !== 'read') throw new BadRequestException('"permission" must be full, send or read');
    const allowedDomains = keyDomains(body.allowedDomains);
    if (allowedDomains.length && permission !== 'send') throw new BadRequestException('Solo las claves de envío se limitan a dominios.');
    if (body.mode === 'live') await liveCall(() => this.live.assertCanGoLive(project));
    const { key, apiKey } = await this.sim.createApiKey(project.id, name, body.mode === 'live' ? 'live' : 'test', {
      permission,
      ...(allowedDomains.length && { allowedDomains }),
    });
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

/** Sender domains for a send key: lowercased, valid, at most 20. */
function keyDomains(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  const list = Array.isArray(value) ? value : String(value).split(/[\s,]+/);
  const domains = [...new Set(list.map((d) => String(d).trim().toLowerCase().replace(/^@/, '')).filter(Boolean))];
  const valid = /^(?=.{3,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;
  const bad = domains.find((d) => !valid.test(d));
  if (bad) throw new BadRequestException(`«${bad}» no es un dominio válido.`);
  if (domains.length > 20) throw new BadRequestException('Una clave puede limitarse a 20 dominios como mucho.');
  return domains;
}

/** `undefined`: leave as is; `null`: clear; otherwise a validated url. */
function urlChange(value: unknown, pattern: RegExp, error: string): string | null | undefined {
  if (value === null || value === '') return null;
  if (typeof value !== 'string') return undefined;
  if (!pattern.test(value)) throw new BadRequestException(error);
  return value;
}

/** Team errors as HTTP answers, with their (Spanish, user-facing) message. */
async function teamCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof TeamError) throw new HttpException({ statusCode: error.status, message: error.message }, error.status);
    throw error;
  }
}

/** The people of a project. Seeing it is for everyone in it; changing it, for admins (or yourself, to leave). */
@Controller('v1/project/team')
@UseGuards(ProjectGuard)
export class TeamController {
  constructor(@Inject(TeamService) private readonly team: TeamService) {}

  @Get()
  async view(@CurrentProject() project: Project) {
    return this.team.view(project);
  }

  @Post('invites')
  @SessionOnly()
  async invite(@CurrentProject() project: Project, @CurrentUser() user: User, @Body() body: { email?: unknown; role?: unknown }) {
    const { id, email, role, expiresAt, createdAt } = await teamCall(() => this.team.invite(project, user, body ?? {}));
    return { id, email, role, expiresAt, createdAt };
  }

  @Delete('invites/:id')
  @SessionOnly()
  @HttpCode(204)
  async revoke(@CurrentProject() project: Project, @Param('id') id: string) {
    await teamCall(() => this.team.revokeInvite(project, id));
  }

  @Patch('members/:userId')
  @SessionOnly()
  @HttpCode(204)
  async changeRole(@CurrentProject() project: Project, @Param('userId') userId: string, @Body() body: { role?: unknown }) {
    await teamCall(() => this.team.changeRole(project, userId, body?.role));
  }

  /** Removes someone (admins), or yourself: `me` leaves the project. */
  @Delete('members/:userId')
  @HttpCode(204)
  async remove(@CurrentProject() project: Project, @CurrentUser() user: User | undefined, @CurrentRole() role: ProjectRole, @Param('userId') userId: string) {
    if (!user) throw new BadRequestException('Sign in to the panel to manage the team');
    await teamCall(() => this.team.remove(project, user, role, userId === 'me' ? user.id : userId));
  }
}

/** Invitation links: what they are for (before signing in), and accepting them. */
@Controller('v1/invites')
export class InvitesController {
  constructor(@Inject(TeamService) private readonly team: TeamService) {}

  @Get(':token')
  async describe(@Param('token') token: string) {
    return teamCall(() => this.team.describe(token));
  }

  @Post('accept')
  @HttpCode(200)
  @UseGuards(SessionGuard)
  async accept(@CurrentUser() user: User, @Body() body: { token?: unknown }) {
    const { project, role, verified } = await teamCall(() => this.team.accept(user, body?.token));
    return { project: publicProject(project, role), emailVerified: verified || !!user.emailVerifiedAt };
  }
}

/** Sends waiting for their `sendAt`, and the ones already handled. */
@Controller('v1/scheduled')
@UseGuards(ProjectGuard)
export class ScheduledController {
  constructor(@Inject(SIM_STORE) private readonly store: SimStore) {}

  /** `status=pending` (soonest first), `sent`, `failed` or `canceled`; all of them, newest first, without it. */
  @Get()
  async list(@CurrentProject() project: Project, @CurrentMode() mode: Mode, @Query('status') status?: string, @Query('limit') limit?: string) {
    const statuses = ['pending', 'sending', 'sent', 'failed', 'canceled'];
    if (status !== undefined && !statuses.includes(status)) throw new BadRequestException(`"status" must be one of ${statuses.join(', ')}`);
    const data = await this.store.listScheduled(project.id, {
      mode,
      limit: Math.min(200, Math.max(1, Number(limit) || 100)),
      ...(status && { status: status as ScheduledSend['status'] }),
    });
    return { data: data.map(publicScheduled) };
  }

  @Get(':id')
  async get(@CurrentProject() project: Project, @Param('id') id: string) {
    const send = await this.store.getScheduled(project.id, id);
    if (!send) throw new NotFoundException('Envío programado no encontrado');
    return { ...publicScheduled(send), request: send.request };
  }

  /** Cancels a send that has not left yet. */
  @Delete(':id')
  @HttpCode(204)
  async cancel(@CurrentProject() project: Project, @Param('id') id: string) {
    if (await this.store.cancelScheduled(project.id, id)) return;
    const send = await this.store.getScheduled(project.id, id);
    if (!send) throw new NotFoundException('Envío programado no encontrado');
    throw new ConflictException(send.status === 'canceled' ? 'Ya estaba cancelado' : 'Ya se ha enviado (o se está enviando): no se puede cancelar');
  }
}

function publicScheduled(send: ScheduledSend) {
  const { projectId: _projectId, request: _request, ...rest } = send;
  return rest;
}

/** Saved emails and SMS, filled with variables at send time. */
@Controller('v1/project/templates')
@UseGuards(ProjectGuard)
export class TemplatesController {
  constructor(@Inject(TemplatesService) private readonly templates: TemplatesService, @Inject(SIM_STORE) private readonly store: SimStore) {}

  @Get()
  async list(@CurrentProject() project: Project) {
    return { data: (await this.store.listTemplates(project.id)).map(publicTemplate) };
  }

  @Get(':ref')
  async get(@CurrentProject() project: Project, @Param('ref') ref: string) {
    return publicTemplate(await renderTemplate(() => this.templates.get(project, ref)));
  }

  @Post()
  async create(@CurrentProject() project: Project, @Body() body: Record<string, unknown>) {
    return publicTemplate(await renderTemplate(() => this.templates.create(project, body ?? {})));
  }

  @Patch(':ref')
  async update(@CurrentProject() project: Project, @Param('ref') ref: string, @Body() body: Record<string, unknown>) {
    return publicTemplate(await renderTemplate(() => this.templates.update(project, ref, body ?? {})));
  }

  @Delete(':ref')
  @HttpCode(204)
  async remove(@CurrentProject() project: Project, @Param('ref') ref: string) {
    const template = await renderTemplate(() => this.templates.get(project, ref));
    await this.store.deleteTemplate(project.id, template.id);
  }

  /** The template filled with `variables` as far as they go, and the ones missing: for previews. */
  @Post(':ref/preview')
  @HttpCode(200)
  @NoAudit()
  async preview(@CurrentProject() project: Project, @Param('ref') ref: string, @Body() body: { variables?: unknown }) {
    return renderTemplate(() => this.templates.preview(project, ref, variablesOf(body ?? {})));
  }
}

function publicTemplate(template: Template) {
  const { projectId: _projectId, ...rest } = template;
  return { ...rest, variables: templateVariables(template.subject, template.html, template.text, template.body) };
}

/** The project's webhook delivery log: every try, its answer, and redeliveries. */
@Controller('v1/project/webhook')
@UseGuards(ProjectGuard)
export class WebhookDeliveriesController {
  constructor(
    @Inject(SIM_STORE) private readonly store: SimStore,
    @Inject(INFRASTRUCTURE) private readonly infra: Infrastructure,
  ) {}

  /**
   * Newest first; `status=failed` for failures only, `endpoint` for one endpoint's (`main` for the main URL),
   * `before` (ISO date) for the next page.
   */
  @Get('deliveries')
  async list(
    @CurrentProject() project: Project,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('status') status?: string,
    @Query('endpoint') endpoint?: string,
  ) {
    const max = Math.min(200, Math.max(1, Number(limit) || 50));
    const attempts = await this.store.listWebhookAttempts(project.id, {
      limit: max,
      ...(before && !Number.isNaN(Date.parse(before)) && { before: new Date(before) }),
      ...(status === 'failed' && { failed: true }),
      ...(endpoint && { endpointId: endpoint === 'main' ? null : endpoint }),
    });
    return { data: attempts.map(publicAttempt) };
  }

  /** Tries and failures in the last 24 hours, and the latest try. */
  @Get('stats')
  async stats(@CurrentProject() project: Project) {
    const since = new Date(Date.now() - 86_400_000);
    const [counts, latest] = await Promise.all([
      this.store.webhookStats(project.id, since),
      this.store.listWebhookAttempts(project.id, { limit: 1 }),
    ]);
    return { since, ...counts, latest: latest[0] ? publicAttempt(latest[0]) : null };
  }

  /** One try with the event it carried (gone once the message is past retention). */
  @Get('deliveries/:id')
  async get(@CurrentProject() project: Project, @Param('id') id: string) {
    const attempt = await this.store.getWebhookAttempt(project.id, id);
    if (!attempt) throw new NotFoundException('Entrega no encontrada');
    const event = await this.store.getEvent(project.id, attempt.eventId);
    return { ...publicAttempt(attempt), event: event ? JSON.parse(webhookBody(event)) : null };
  }

  /** Sends the event of a try again, now, to the current URL of the endpoint it went to. */
  @Post('deliveries/:id/redeliver')
  @HttpCode(200)
  async redeliver(@CurrentProject() project: Project, @Param('id') id: string) {
    const attempt = await this.store.getWebhookAttempt(project.id, id);
    if (!attempt) throw new NotFoundException('Entrega no encontrada');
    const event = await this.store.getEvent(project.id, attempt.eventId);
    if (!event) throw new BadRequestException('El evento ya no existe: se borró con su mensaje al pasar el periodo de retención.');
    return publicAttempt(await this.send(event, await this.target(project, attempt.endpointId), 'redeliver'));
  }

  /**
   * Sends again every event that could not be delivered since a date (`since`, ISO; up to `until`): the ones
   * whose last try failed with no retry left, to the endpoint they were meant for (`endpoint`: one of them,
   * `main` for the main URL). Up to 1000 events, in the background; answers how many.
   */
  @Post('redeliver')
  @HttpCode(202)
  async redeliverFailed(@CurrentProject() project: Project, @Body() body: { since?: unknown; until?: unknown; endpoint?: unknown }) {
    const since = typeof body?.since === 'string' ? new Date(body.since) : undefined;
    if (!since || Number.isNaN(since.getTime())) throw new BadRequestException('"since" must be an ISO date');
    const until = typeof body?.until === 'string' ? new Date(body.until) : undefined;
    if (until && Number.isNaN(until.getTime())) throw new BadRequestException('"until" must be an ISO date');
    const endpoint = typeof body?.endpoint === 'string' && body.endpoint ? body.endpoint : undefined;
    const attempts = await this.store.listWebhookAttempts(project.id, {
      limit: 20_000,
      since,
      ...(until && { before: until }),
      ...(endpoint && { endpointId: endpoint === 'main' ? null : endpoint }),
    });
    // Newest first: the first try seen of each event and endpoint is its latest.
    const latest = new Map<string, (typeof attempts)[number]>();
    for (const attempt of attempts) {
      if (attempt.trigger === 'test') continue;
      const key = `${attempt.eventId}|${attempt.endpointId ?? ''}`;
      if (!latest.has(key)) latest.set(key, attempt);
    }
    const failed = [...latest.values()].filter((a) => !a.ok && !a.willRetry).slice(0, 1000);
    const targets = new Map<string, WebhookTarget | undefined>();
    for (const a of failed) {
      const key = a.endpointId ?? '';
      if (!targets.has(key)) targets.set(key, await this.target(project, a.endpointId).catch(() => undefined));
    }
    const jobs = failed.filter((a) => targets.get(a.endpointId ?? ''));
    void this.redeliverAll(project, jobs, targets);
    return { events: jobs.length };
  }

  private async redeliverAll(project: Project, jobs: Array<{ eventId: string; endpointId?: string }>, targets: Map<string, WebhookTarget | undefined>): Promise<void> {
    const queue = [...jobs];
    const worker = async () => {
      for (let job = queue.shift(); job; job = queue.shift()) {
        const event = await this.store.getEvent(project.id, job.eventId);
        const target = targets.get(job.endpointId ?? '');
        if (event && target) await this.send(event, target, 'redeliver').catch(() => undefined);
      }
    };
    await Promise.all(Array.from({ length: 5 }, worker));
  }

  /**
   * Sends a made-up `delivered` event, marked with the `Relayo-Test: true` header and `metadata.relayoTest`,
   * to check the endpoint and its signature check.
   */
  @Post('test')
  @HttpCode(200)
  async test(@CurrentProject() project: Project, @Body() body?: { endpoint?: unknown }) {
    const target = await this.target(project, typeof body?.endpoint === 'string' && body.endpoint !== 'main' ? body.endpoint : undefined);
    const event: SimEvent = {
      id: `test_${randomUUID()}`,
      type: 'delivered',
      channel: 'email',
      provider: 'relayo',
      messageId: 'test',
      providerMessageId: 'test',
      recipient: 'test@sim.relayo.dev',
      timestamp: new Date(),
      metadata: { relayoTest: 'true' },
      raw: { test: true },
      projectId: project.id,
    };
    return publicAttempt(await this.send(event, target, 'test'));
  }

  // Extra endpoints: more URLs for the events, each with its own secret and filters.

  @Get('endpoints')
  async endpoints(@CurrentProject() project: Project) {
    return { data: (await this.store.listWebhookEndpoints(project.id)).map(publicEndpoint) };
  }

  /** Answers with the endpoint's signing secret; afterwards only the panel can show it. */
  @Post('endpoints')
  @ProjectAdmin()
  async createEndpoint(@CurrentProject() project: Project, @Body() body: Record<string, unknown>) {
    if ((await this.store.listWebhookEndpoints(project.id)).length >= MAX_ENDPOINTS) {
      throw new BadRequestException(`Un proyecto puede tener hasta ${MAX_ENDPOINTS} endpoints además de la URL principal.`);
    }
    const changes = endpointChanges(body ?? {});
    if (!changes.url) throw new BadRequestException('"url" is required');
    const endpoint: WebhookEndpoint = {
      id: `whe_${randomUUID()}`,
      projectId: project.id,
      url: changes.url,
      secret: newWebhookSecret(),
      enabled: changes.enabled ?? true,
      createdAt: new Date(),
      ...(changes.description && { description: changes.description }),
      ...(changes.events && { events: changes.events }),
      ...(changes.mode && { mode: changes.mode }),
    };
    await this.store.createWebhookEndpoint(endpoint);
    return { ...publicEndpoint(endpoint), secret: endpoint.secret };
  }

  /** `null` clears `description`, `events` (all of them) or `mode` (both). */
  @Patch('endpoints/:id')
  @ProjectAdmin()
  async updateEndpoint(@CurrentProject() project: Project, @Param('id') id: string, @Body() body: Record<string, unknown>) {
    if (!(await this.store.getWebhookEndpoint(project.id, id))) throw new NotFoundException('Endpoint no encontrado');
    await this.store.updateWebhookEndpoint(project.id, id, endpointChanges(body ?? {}));
    return publicEndpoint((await this.store.getWebhookEndpoint(project.id, id))!);
  }

  @Delete('endpoints/:id')
  @ProjectAdmin()
  @HttpCode(204)
  async deleteEndpoint(@CurrentProject() project: Project, @Param('id') id: string) {
    if (!(await this.store.deleteWebhookEndpoint(project.id, id))) throw new NotFoundException('Endpoint no encontrado');
  }

  @Get('endpoints/:id/secret')
  @SessionOnly()
  async endpointSecret(@CurrentProject() project: Project, @Param('id') id: string) {
    const endpoint = await this.store.getWebhookEndpoint(project.id, id);
    if (!endpoint) throw new NotFoundException('Endpoint no encontrado');
    return { secret: endpoint.secret };
  }

  @Post('endpoints/:id/secret/rotate')
  @SessionOnly()
  async rotateEndpointSecret(@CurrentProject() project: Project, @Param('id') id: string) {
    if (!(await this.store.getWebhookEndpoint(project.id, id))) throw new NotFoundException('Endpoint no encontrado');
    const secret = newWebhookSecret();
    await this.store.updateWebhookEndpoint(project.id, id, { secret });
    return { secret };
  }

  /** The main URL (no endpoint id), or an extra endpoint: where a test or a redelivery goes. */
  private async target(project: Project, endpointId: string | undefined): Promise<WebhookTarget> {
    if (!endpointId) {
      if (!project.webhookUrl) throw new BadRequestException('Configura primero la URL del webhook.');
      return { url: project.webhookUrl, secret: project.webhookSecret };
    }
    const endpoint = await this.store.getWebhookEndpoint(project.id, endpointId);
    if (!endpoint) throw new BadRequestException('Ese endpoint ya no existe.');
    return { url: endpoint.url, secret: endpoint.secret, endpointId: endpoint.id };
  }

  private async send(event: SimEvent, target: WebhookTarget, trigger: 'redeliver' | 'test'): Promise<WebhookAttempt> {
    const result = await attemptWebhook(event, target, fetch, trigger === 'test' ? { 'Relayo-Test': 'true' } : {});
    const attempt = attemptRecord(event, target, result, { attempt: 1, maxAttempts: 1, trigger, willRetry: false });
    await recordAttempt(this.infra.webhookLog, attempt);
    return attempt;
  }
}

const MAX_ENDPOINTS = 10;

/** Validates what a request may change in an endpoint. */
function endpointChanges(body: Record<string, unknown>): WebhookEndpointChanges {
  const changes: WebhookEndpointChanges = {};
  if (body.url !== undefined) {
    if (typeof body.url !== 'string' || !/^https?:\/\/\S+$/.test(body.url.trim())) throw new BadRequestException('"url" must be an http(s) url');
    changes.url = body.url.trim();
  }
  if (body.description !== undefined) {
    const text = typeof body.description === 'string' ? body.description.trim().slice(0, 200) : '';
    changes.description = text || null;
  }
  if (body.events !== undefined) {
    if (body.events === null) changes.events = null;
    else {
      const events = Array.isArray(body.events) ? body.events : [];
      const bad = events.find((e) => !(WEBHOOK_EVENT_TYPES as readonly unknown[]).includes(e));
      if (!Array.isArray(body.events) || bad !== undefined) {
        throw new BadRequestException(`"events" must be a list of: ${WEBHOOK_EVENT_TYPES.join(', ')}`);
      }
      changes.events = events.length ? [...new Set(events as Array<(typeof WEBHOOK_EVENT_TYPES)[number]>)] : null;
    }
  }
  if (body.mode !== undefined) {
    if (body.mode !== null && body.mode !== 'test' && body.mode !== 'live') throw new BadRequestException('"mode" must be test, live or null');
    changes.mode = body.mode;
  }
  if (body.enabled !== undefined) {
    if (typeof body.enabled !== 'boolean') throw new BadRequestException('"enabled" must be true or false');
    changes.enabled = body.enabled;
  }
  return changes;
}

function publicEndpoint(endpoint: WebhookEndpoint) {
  const { projectId: _p, secret: _s, ...rest } = endpoint;
  return { ...rest, description: rest.description ?? null, events: rest.events ?? null, mode: rest.mode ?? null };
}

function publicAttempt(attempt: WebhookAttempt) {
  const { projectId: _projectId, ...rest } = attempt;
  return rest;
}

/** Who changed what in the project, and every request made with its API keys. */
@Controller('v1/project')
@UseGuards(ProjectGuard)
export class ActivityController {
  constructor(@Inject(SIM_STORE) private readonly store: SimStore) {}

  /** Newest first; `before` (ISO date) for the next page. Kept for a year. */
  @Get('audit')
  @ProjectAdmin()
  async audit(@CurrentProject() project: Project, @Query('limit') limit?: string, @Query('before') before?: string) {
    const entries = await this.store.listAudit(project.id, { limit: pageSize(limit), ...since(before) });
    return { data: entries.map(({ projectId: _p, ...rest }) => rest) };
  }

  /** Newest first; `status=failed` for answers of 400 and up, `key` for one key's, `before` for the next page. */
  @Get('requests')
  async requests(
    @CurrentProject() project: Project,
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('status') status?: string,
    @Query('key') key?: string,
  ) {
    const requests = await this.store.listApiRequests(project.id, {
      limit: pageSize(limit),
      ...since(before),
      ...(status === 'failed' && { failed: true }),
      ...(key && { keyId: key }),
    });
    return { data: requests.map(({ projectId: _p, ...rest }) => rest) };
  }
}

function pageSize(limit?: string): number {
  return Math.min(200, Math.max(1, Number(limit) || 50));
}

function since(before?: string): { before?: Date } {
  return before && !Number.isNaN(Date.parse(before)) ? { before: new Date(before) } : {};
}

/** Platform admins: every project, its usage, and its plan (limits that replace the platform's). */
@Controller('v1/admin/plans')
@UseGuards(PlatformAdminGuard)
export class PlansController {
  constructor(
    @Inject(SIM_STORE) private readonly store: SimStore,
    @Inject(SimulationService) private readonly sim: SimulationService,
    @Inject(SIM_CONFIG) private readonly config: SimConfig,
    @Inject(ActivityLog) private readonly activity: ActivityLog,
  ) {}

  /** Projects (searching name, id or owner's email), with this month's usage and their effective limits. */
  @Get()
  async list(@Query('q') q?: string) {
    const found = await this.store.searchProjects({ ...(q?.trim() && { text: q.trim() }), limit: 50 });
    const data = await Promise.all(found.map((f) => this.row(f.project, f.ownerEmail)));
    return { defaults: { ...this.sim.limitsOf({} as Project), retentionDays: this.config.retentionDays ?? 7 }, data };
  }

  /** Sets a project's plan; a field set to null goes back to the platform's value. */
  @Patch(':projectId')
  async update(@Param('projectId') projectId: string, @Body() body: Record<string, unknown>, @CurrentUser() admin?: User) {
    const project = await this.store.getProject(projectId);
    if (!project) throw new NotFoundException('Proyecto no encontrado');
    const limits: ProjectLimits = { ...project.limits };
    for (const key of ['monthlyMessages', 'messagesPerMinute', 'liveMonthlyMessages', 'retentionDays'] as const) {
      if (!(key in (body ?? {}))) continue;
      const value = body[key];
      if (value === null || value === '') {
        delete limits[key];
        continue;
      }
      if (typeof value !== 'number' || !Number.isInteger(value) || value < 0 || value > 100_000_000) {
        throw new BadRequestException(`"${key}" must be a whole number from 0 (no limit) up, or null for the platform's value`);
      }
      limits[key] = value;
    }
    await this.store.updateProject(projectId, { limits: Object.keys(limits).length ? limits : null });
    await this.activity.audit(project, { kind: 'admin', ...(admin && { email: admin.email }) }, 'PATCH /v1/admin/plans/:projectId', { ...limits });
    const updated = (await this.store.getProject(projectId))!;
    const owner = updated.ownerId ? await this.store.getUser(updated.ownerId) : undefined;
    return this.row(updated, owner?.email);
  }

  private async row(project: Project, ownerEmail?: string) {
    const usage = await this.sim.usage(project);
    return {
      project: publicProject(project),
      ownerEmail: ownerEmail ?? null,
      plan: project.limits ?? {},
      effective: { ...usage.limits, retentionDays: project.limits?.retentionDays ?? this.config.retentionDays ?? 7 },
      usage: { messages: usage.messages, live: usage.live },
    };
  }
}

/** Platform admins (ADMIN_EMAILS, or the admin token): review of Relayo's own sending. */
@Controller('v1/admin/managed')
@UseGuards(PlatformAdminGuard)
export class ManagedReviewController {
  constructor(
    @Inject(LiveService) private readonly live: LiveService,
    @Inject(SIM_STORE) private readonly store: SimStore,
    @Inject(SimulationService) private readonly sim: SimulationService,
    @Inject(AccountsService) private readonly accounts: AccountsService,
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
    const project = await liveCall(() => this.live.decideManagedAccess(projectId, body?.decision));
    const owner = project.ownerId ? await this.store.getUser(project.ownerId) : undefined;
    // The answer stands even if the email cannot be sent: the panel shows it too.
    if (owner) await this.accounts.notifyManagedDecision(owner, project, project.managedAccess as 'approved' | 'denied').catch(() => undefined);
    return publicProject(project);
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

/** The API reference: OpenAPI 3.1, rendered at /docs. */
@Controller()
export class OpenApiController {
  constructor(@Inject(SIM_CONFIG) private readonly config: SimConfig) {}

  @Get('openapi.json')
  spec() {
    return openApi(this.config.publicUrl);
  }
}

@Controller()
export class HealthController {
  constructor(@Inject(INFRASTRUCTURE) private readonly infra: Infrastructure) {}

  /**
   * 200 when PostgreSQL and Redis (if used) answer, 503 otherwise: point uptime monitors here. `commit` is the
   * build's git commit (GIT_SHA), so a deploy can tell when the new version is live.
   */
  @Get('health')
  async health(@Res({ passthrough: true }) res: Response) {
    const checks = await this.infra.check();
    const ok = Object.values(checks).every((c) => c === 'ok');
    if (!ok) res.status(503);
    return { ok, checks, ...(process.env.GIT_SHA && { commit: process.env.GIT_SHA }) };
  }

  /** The process answers: for container health checks, which should not restart it over a database outage. */
  @Get('health/live')
  live() {
    return { ok: true };
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
