import {
  BadRequestException,
  Body,
  Controller,
  Get,
  HttpCode,
  Inject,
  NotFoundException,
  Param,
  Patch,
  Post,
  Query,
  UseGuards,
} from '@nestjs/common';
import type { Project, SimMessage } from '../domain.js';
import { SCENARIOS } from '../scenarios/catalog.js';
import { SimulationService } from '../simulation/simulation.service.js';
import { SIM_STORE, type SimStore } from '../store/store.js';
import { AdminGuard, ApiKeyGuard, CurrentProject } from './auth.js';

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
const addressOf = (value: Address) => (typeof value === 'string' ? value : value?.address);

function publicProject(project: Project) {
  return { id: project.id, name: project.name, webhookUrl: project.webhookUrl ?? null, createdAt: project.createdAt };
}

function publicMessage(message: SimMessage) {
  const { projectId: _projectId, ...rest } = message;
  return rest;
}

@Controller('v1')
export class ScenariosController {
  @Get('scenarios')
  list() {
    return { data: SCENARIOS.map(({ name, description, example }) => ({ name, description, example })) };
  }
}

@Controller('v1/messages')
@UseGuards(ApiKeyGuard)
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

  @Get()
  async list(@CurrentProject() project: Project, @Query('limit') limit?: string, @Query('before') before?: string) {
    const max = Math.min(100, Math.max(1, Number(limit) || 25));
    const beforeDate = before ? new Date(before) : undefined;
    const messages = await this.store.listMessages(project.id, {
      limit: max,
      ...(beforeDate && !Number.isNaN(beforeDate.getTime()) && { before: beforeDate }),
    });
    return { data: messages.map(publicMessage) };
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
@UseGuards(ApiKeyGuard)
export class ProjectController {
  constructor(@Inject(SIM_STORE) private readonly store: SimStore) {}

  @Get()
  get(@CurrentProject() project: Project) {
    return publicProject(project);
  }

  @Patch()
  async update(@CurrentProject() project: Project, @Body() body: { name?: string; webhookUrl?: string | null }) {
    const changes: { name?: string; webhookUrl?: string } = {};
    if (typeof body?.name === 'string' && body.name.trim()) changes.name = body.name.trim();
    if (typeof body?.webhookUrl === 'string') {
      if (!/^https?:\/\//.test(body.webhookUrl)) throw new BadRequestException('"webhookUrl" must be an http(s) url');
      changes.webhookUrl = body.webhookUrl;
    }
    await this.store.updateProject(project.id, changes);
    return publicProject({ ...project, ...changes });
  }
}

@Controller('v1/projects')
@UseGuards(AdminGuard)
export class AdminController {
  constructor(@Inject(SimulationService) private readonly sim: SimulationService) {}

  /** Creates a project. The API key and webhook secret are only shown in this response. */
  @Post()
  async create(@Body() body: { name?: string; webhookUrl?: string }) {
    if (typeof body?.name !== 'string' || !body.name.trim()) throw new BadRequestException('"name" is required');
    const { project, apiKey } = await this.sim.createProject(body.name.trim(), body.webhookUrl);
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
