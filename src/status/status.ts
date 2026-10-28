import { randomUUID } from 'node:crypto';
import { connect } from 'node:net';
import { Logger } from '@nestjs/common';
import type { Incident, IncidentStatus, StatusComponent, StatusSample } from '../domain.js';
import type { SimStore } from '../store/store.js';

export const COMPONENT_NAMES: Record<StatusComponent, string> = {
  api: 'API y panel',
  database: 'Base de datos',
  queues: 'Colas y webhooks',
  smtp: 'SMTP',
};

export const INCIDENT_STATUSES: IncidentStatus[] = ['investigating', 'identified', 'monitoring', 'resolved'];

type Level = 'operational' | 'degraded' | 'outage';

/** How many minutes of samples wait in memory while the database is down, to be written when it is back. */
const PENDING_LIMIT = 24 * 60;

/**
 * The public status page: a check of every component each minute, kept 90 days, and the incidents the
 * platform's admins report. A sample that cannot be written (the database is what failed) waits in memory,
 * so an outage of the database shows up once it is back instead of leaving a hole that looks like uptime.
 */
export class StatusService {
  private readonly logger = new Logger('Status');
  private readonly pending: StatusSample[] = [];
  private timer: ReturnType<typeof setInterval> | undefined;

  constructor(
    private readonly store: SimStore,
    /** The components this installation runs, and whether each answers now. */
    private readonly probe: () => Promise<Partial<Record<StatusComponent, boolean>>>,
    private readonly now = () => Date.now(),
  ) {}

  start(intervalMs = 60_000): void {
    // The first sample after a minute: at start the SMTP server may not be listening yet.
    this.timer = setInterval(() => void this.sample(), intervalMs);
    this.timer.unref();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
  }

  async sample(): Promise<void> {
    // At the minute, so two instances (or a restart) write the same row instead of two.
    const at = new Date(Math.floor(this.now() / 60_000) * 60_000);
    this.pending.push({ at, checks: await this.probe().catch(() => ({ api: true })) });
    if (this.pending.length > PENDING_LIMIT) this.pending.splice(0, this.pending.length - PENDING_LIMIT);
    try {
      await this.store.addStatusSamples(this.pending);
      this.pending.length = 0;
    } catch (error) {
      this.logger.warn(`Status sample kept for later: ${(error as Error).message}`);
    }
  }

  /** What /status shows: the components now and over 90 days, and the incidents. */
  async status() {
    const now = this.now();
    const checks = await this.probe().catch((): Partial<Record<StatusComponent, boolean>> => ({ api: true }));
    const since = new Date(now - 89 * 86_400_000);
    since.setUTCHours(0, 0, 0, 0);
    const [days, incidents] = await Promise.all([
      this.store.statusDays(since).catch(() => []),
      this.store.listIncidents({ resolvedSince: new Date(now - 14 * 86_400_000), limit: 50 }).catch(() => []),
    ]);
    // Samples still waiting count too: they are the database's own outage.
    const counts = new Map(days.map((d) => [`${d.day}|${d.component}`, { ok: d.ok, total: d.total }]));
    for (const sample of this.pending) {
      for (const [component, up] of Object.entries(sample.checks) as Array<[StatusComponent, boolean]>) {
        const key = `${sample.at.toISOString().slice(0, 10)}|${component}`;
        const row = counts.get(key) ?? { ok: 0, total: 0 };
        counts.set(key, { ok: row.ok + (up ? 1 : 0), total: row.total + 1 });
      }
    }
    const open = incidents.filter((i) => i.status !== 'resolved');
    const dates = Array.from({ length: 90 }, (_, i) => new Date(since.getTime() + i * 86_400_000).toISOString().slice(0, 10));
    const components = (Object.keys(checks) as StatusComponent[]).map((id) => {
      const history = dates.map((day) => {
        const row = counts.get(`${day}|${id}`);
        return { day, uptime: row?.total ? row.ok / row.total : null };
      });
      const measured = history.filter((d) => d.uptime !== null);
      const incident = open.filter((i) => i.components.includes(id));
      const level: Level = !checks[id]
        ? 'outage'
        : incident.some((i) => i.impact !== 'minor')
          ? 'outage'
          : incident.length
            ? 'degraded'
            : 'operational';
      return {
        id,
        name: COMPONENT_NAMES[id],
        status: level,
        uptime: measured.length ? measured.reduce((sum, d) => sum + d.uptime!, 0) / measured.length : null,
        days: history,
      };
    });
    const worst: Level = components.some((c) => c.status === 'outage')
      ? 'outage'
      : components.some((c) => c.status === 'degraded') || open.length
        ? 'degraded'
        : 'operational';
    return {
      status: worst,
      updatedAt: new Date(now),
      components,
      incidents: { open, recent: incidents.filter((i) => i.status === 'resolved') },
    };
  }

  async open(input: { title: string; impact: Incident['impact']; components: StatusComponent[]; status: IncidentStatus; message: string }): Promise<Incident> {
    const at = new Date(this.now());
    const incident: Incident = {
      id: `inc_${randomUUID()}`,
      title: input.title,
      impact: input.impact,
      status: input.status,
      components: input.components,
      updates: [{ at, status: input.status, message: input.message }],
      createdAt: at,
      ...(input.status === 'resolved' && { resolvedAt: at }),
    };
    await this.store.saveIncident(incident);
    return incident;
  }

  /** A new update: its status becomes the incident's; resolved closes it. */
  async update(id: string, input: { status: IncidentStatus; message: string }): Promise<Incident | undefined> {
    const incident = await this.store.getIncident(id);
    if (!incident) return undefined;
    const at = new Date(this.now());
    const next: Incident = {
      ...incident,
      status: input.status,
      updates: [...incident.updates, { at, status: input.status, message: input.message }],
      ...(input.status === 'resolved' && { resolvedAt: at }),
    };
    if (input.status !== 'resolved') delete next.resolvedAt;
    await this.store.saveIncident(next);
    return next;
  }
}

/** Whether a TCP port accepts connections: the SMTP server's own check. */
export function canConnect(port: number, host = '127.0.0.1', timeoutMs = 2000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = connect({ port, host });
    const done = (ok: boolean) => {
      socket.destroy();
      resolve(ok);
    };
    socket.setTimeout(timeoutMs, () => done(false));
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}
