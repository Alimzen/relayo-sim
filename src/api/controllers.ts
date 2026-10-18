import {
  BadRequestException,
  Body,
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
  UseGuards,
} from '@nestjs/common';
import type { Project, SimEvent } from '../domain.js';
import { SCENARIOS } from '../scenarios/catalog.js';
import { SimulationService } from '../simulation/simulation.service.js';
import { SIM_STORE, type ProjectChanges, type SimStore } from '../store/store.js';
import { AdminGuard, CurrentProject, ProjectGuard, SessionOnly } from './auth.js';
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
  headers?: Record<string, string>;
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

@Controller('v1')
export class ScenariosController {
  @Get('scenarios')
  list() {
    return { data: SCENARIOS.map(({ name, description, example }) => ({ name, description, example })) };
  }
}

@Controller('v1/messages')
@UseGuards(ProjectGuard)
export class MessagesController {
  constructor(
    @Inject(SimulationService) private readonly sim: SimulationService,
    @Inject(SIM_STORE) private readonly store: SimStore,
  ) {}

  @Post()
  @HttpCode(202)
  async send(@CurrentProject() project: Project, @Body() body: SendBody) {
    const from = addressOf(body?.from);
    const to = [...(Array.isArray(body?.to) ? body.to : [body?.to]), ...(body?.cc ?? []), ...(body?.bcc ?? [])].map(addressOf);
    if (!from || !EMAIL.test(from)) throw new BadRequestException('"from" must be an email address');
    if (!to.length || to.some((a) => !a || !EMAIL.test(a))) throw new BadRequestException('"to" must contain email addresses');
    if (typeof body.subject !== 'string') throw new BadRequestException('"subject" is required');

    const scenarioHeader = Object.entries(body.headers ?? {}).find(([k]) => k.toLowerCase() === 'x-sim-scenario')?.[1];
    const message = await this.sim.acceptFromApi(project, {
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
    @Query('limit') limit?: string,
    @Query('before') before?: string,
    @Query('q') q?: string,
    @Query('status') status?: string,
  ) {
    const max = Math.min(100, Math.max(1, Number(limit) || 25));
    const beforeDate = before ? new Date(before) : undefined;
    if (status && !EVENT_TYPES.has(status)) throw new BadRequestException(`Unknown status "${status}"`);
    const messages = await this.store.listMessages(project.id, {
      limit: max,
      ...(beforeDate && !Number.isNaN(beforeDate.getTime()) && { before: beforeDate }),
      ...(q?.trim() && { search: q.trim().slice(0, 200) }),
      ...(status && { status: status as SimEvent['type'] }),
    });
    return { data: messages.map(publicMessage) };
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

  /** Totals and a per-day series over the last `days` days (1–90, default 7). */
  @Get('stats')
  async stats(@CurrentProject() project: Project, @Query('days') days?: string) {
    const span = Math.min(90, Math.max(1, Number(days) || 7));
    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - (span - 1));
    return this.store.stats(project.id, since);
  }

  @Get('keys')
  @SessionOnly()
  async keys(@CurrentProject() project: Project) {
    return { data: (await this.store.listApiKeys(project.id)).map(publicKey) };
  }

  /** A new API key. The key itself is only in this response. */
  @Post('keys')
  @SessionOnly()
  async createKey(@CurrentProject() project: Project, @Body() body: { name?: unknown }) {
    const name = typeof body?.name === 'string' ? body.name.trim() : '';
    if (!name || name.length > 60) throw new BadRequestException('El nombre de la clave debe tener entre 1 y 60 caracteres.');
    const { key, apiKey } = await this.sim.createApiKey(project.id, name);
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
  @Get('health')
  health() {
    return { ok: true };
  }
}
