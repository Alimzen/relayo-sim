import { BadRequestException, Body, Controller, Get, Header, Inject, NotFoundException, Param, Post, UseGuards } from '@nestjs/common';
import type { Incident, IncidentStatus, StatusComponent } from '../domain.js';
import { COMPONENT_NAMES, INCIDENT_STATUSES, StatusService } from '../status/status.js';
import { SIM_STORE, type SimStore } from '../store/store.js';
import { PlatformAdminGuard } from './auth.js';

/** The public status page's data: no sign-in, cached for half a minute. */
@Controller('v1/status')
export class StatusController {
  constructor(@Inject(StatusService) private readonly status: StatusService) {}

  @Get()
  @Header('Cache-Control', 'public, max-age=30')
  @Header('Access-Control-Allow-Origin', '*')
  get() {
    return this.status.status();
  }
}

/** Platform admins report incidents on the status page and keep them updated. */
@Controller('v1/admin/incidents')
@UseGuards(PlatformAdminGuard)
export class IncidentsController {
  constructor(
    @Inject(StatusService) private readonly status: StatusService,
    @Inject(SIM_STORE) private readonly store: SimStore,
  ) {}

  /** The open ones, and the ones resolved in the last 90 days. */
  @Get()
  async list() {
    return { data: await this.store.listIncidents({ resolvedSince: new Date(Date.now() - 90 * 86_400_000), limit: 100 }) };
  }

  @Post()
  async open(@Body() body: Record<string, unknown>) {
    const title = typeof body?.title === 'string' ? body.title.trim() : '';
    if (!title || title.length > 120) throw new BadRequestException('"title" must have 1 to 120 characters');
    const impact = body.impact;
    if (impact !== 'minor' && impact !== 'major' && impact !== 'critical') throw new BadRequestException('"impact" must be minor, major or critical');
    const components = Array.isArray(body.components) ? body.components : [];
    if (!components.length || components.some((c) => !(c in COMPONENT_NAMES))) {
      throw new BadRequestException(`"components" must list some of: ${Object.keys(COMPONENT_NAMES).join(', ')}`);
    }
    return this.status.open({ title, impact, components: [...new Set(components as StatusComponent[])], ...update(body) });
  }

  @Post(':id/updates')
  async update(@Param('id') id: string, @Body() body: Record<string, unknown>) {
    const incident: Incident | undefined = await this.status.update(id, update(body));
    if (!incident) throw new NotFoundException('Incidencia no encontrada');
    return incident;
  }
}

function update(body: Record<string, unknown>): { status: IncidentStatus; message: string } {
  const status = body?.status ?? 'investigating';
  if (!INCIDENT_STATUSES.includes(status as IncidentStatus)) throw new BadRequestException(`"status" must be one of: ${INCIDENT_STATUSES.join(', ')}`);
  const message = typeof body?.message === 'string' ? body.message.trim() : '';
  if (!message || message.length > 2000) throw new BadRequestException('"message" must have 1 to 2000 characters');
  return { status: status as IncidentStatus, message };
}
