import {
  BadRequestException,
  Controller,
  Delete,
  Get,
  HttpCode,
  HttpException,
  Inject,
  NotFoundException,
  Param,
  Post,
  Query,
  Req,
  UseGuards,
  UseInterceptors,
} from '@nestjs/common';
import { AnyFilesInterceptor } from '@nestjs/platform-express';
import type { Readable } from 'node:stream';
import { SIM_CONFIG, type SimConfig } from '../config.js';
import type { InboundEmail, Project } from '../domain.js';
import { InboundError, InboundService } from '../inbound/inbound.js';
import { SIM_STORE, type SimStore } from '../store/store.js';
import { CurrentProject, ProjectAdmin, ProjectGuard } from './auth.js';

const MAX_EMAIL = 30 * 1024 * 1024;

type IncomingRequest = Readable & { headers: Record<string, string | string[] | undefined>; body?: unknown; rawBody?: Buffer };

/**
 * Where providers post the emails a project receives: the raw message, or their own formats (SendGrid
 * Inbound Parse, Mailgun routes, Postmark, Amazon SES through SNS).
 */
@Controller('v1/inbound/email')
export class InboundEmailController {
  constructor(@Inject(InboundService) private readonly inbound: InboundService) {}

  @Post(':token')
  @HttpCode(200)
  @UseInterceptors(AnyFilesInterceptor({ limits: { fieldSize: MAX_EMAIL, fileSize: MAX_EMAIL } }))
  async receive(@Param('token') token: string, @Req() req: IncomingRequest) {
    const parsed = req.body !== undefined && !(isEmptyObject(req.body) && req.readable);
    const body = parsed ? req.body : await readAll(req);
    try {
      const email = await this.inbound.receive(token, { headers: req.headers, body, ...(req.rawBody && { rawBody: req.rawBody }) });
      return { received: email ? 1 : 0, ...(email && { id: email.id }) };
    } catch (error) {
      if (error instanceof InboundError) throw new HttpException({ statusCode: error.status, message: error.message }, error.status);
      throw error;
    }
  }
}

/** Receiving emails in a project: its inbound URL, and what arrived. */
@Controller('v1/project/inbound')
@UseGuards(ProjectGuard)
export class ProjectInboundController {
  constructor(
    @Inject(SIM_STORE) private readonly store: SimStore,
    @Inject(SIM_CONFIG) private readonly config: SimConfig,
  ) {}

  @Get()
  @ProjectAdmin()
  get(@CurrentProject() project: Project) {
    return { enabled: !!project.inboundToken, url: project.inboundToken ? this.url(project.inboundToken) : null };
  }

  /** Turns receiving on with a new secret URL (the old one, if any, stops working). */
  @Post()
  @ProjectAdmin()
  async enable(@CurrentProject() project: Project) {
    const token = InboundService.newToken();
    await this.store.updateProject(project.id, { inboundToken: token });
    return { enabled: true, url: this.url(token) };
  }

  @Delete()
  @ProjectAdmin()
  @HttpCode(204)
  async disable(@CurrentProject() project: Project) {
    await this.store.updateProject(project.id, { inboundToken: null });
  }

  /** Newest first; `before` (ISO date) for the next page. Kept as long as messages. */
  @Get('emails')
  async list(@CurrentProject() project: Project, @Query('limit') limit?: string, @Query('before') before?: string) {
    const max = Math.min(100, Math.max(1, Number(limit) || 25));
    if (before !== undefined && Number.isNaN(Date.parse(before))) throw new BadRequestException('"before" must be an ISO date');
    const emails = await this.store.listInbound(project.id, { limit: max, ...(before && { before: new Date(before) }) });
    return { data: emails.map(publicInbound) };
  }

  @Get('emails/:id')
  async getEmail(@CurrentProject() project: Project, @Param('id') id: string) {
    const email = await this.store.getInbound(project.id, id);
    if (!email) throw new NotFoundException('Correo no encontrado');
    return publicInbound(email);
  }

  private url(token: string): string {
    return `${this.config.publicUrl ?? `http://localhost:${this.config.httpPort}`}/v1/inbound/email/${token}`;
  }
}

export function publicInbound(email: InboundEmail) {
  const { projectId: _p, ...rest } = email;
  return rest;
}

function isEmptyObject(value: unknown): boolean {
  return !!value && typeof value === 'object' && !Buffer.isBuffer(value) && Object.keys(value).length === 0;
}

/** A body no parser took (message/rfc822 without the raw parser): read it here, up to the limit. */
async function readAll(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of stream) {
    size += (chunk as Buffer).length;
    if (size > MAX_EMAIL) throw new HttpException({ statusCode: 413, message: 'The email is too large' }, 413);
    chunks.push(chunk as Buffer);
  }
  return Buffer.concat(chunks);
}
