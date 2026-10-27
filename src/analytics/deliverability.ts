import type { Mode, Project, ProjectStats, SimEvent } from '../domain.js';
import type { MailToSend } from '../accounts/mailer.js';
import type { SimStore } from '../store/store.js';

/** What deliverability can be split by: the recipient's domain, the template, or a tag. */
export type DeliverabilityGroup = 'domain' | 'template' | 'tag';

/** Per type of event, how many recipients had it. */
export type EventCounts = Partial<Record<SimEvent['type'], number>>;

export interface DeliverabilityRow {
  key: string;
  /** Recipients accepted for delivery. */
  sent: number;
  delivered: number;
  bounced: number;
  complained: number;
  opened: number;
  clicked: number;
  unsubscribed: number;
  /** Bounces over sent; complaints, opens and clicks over delivered. Null without a base to divide by. */
  rates: { delivery: number | null; bounce: number | null; complaint: number | null; open: number | null; click: number | null };
}

export interface DeliverabilityAlert {
  kind: 'bounces' | 'complaints';
  level: 'warning' | 'critical';
  rate: number;
  /** The rate it went over. */
  threshold: number;
}

/**
 * Thresholds mailbox providers act on: Gmail and Yahoo ask bulk senders to stay under 0.3% complaints
 * (0.1% to be safe); more than a few percent of bounces points at a stale list.
 */
export const THRESHOLDS = {
  bounces: { warning: 0.02, critical: 0.05 },
  complaints: { warning: 0.001, critical: 0.003 },
} as const;

/** Too few recipients make any rate noise: no alerts below this. */
export const MIN_VOLUME = 50;

const rate = (part: number, whole: number) => (whole > 0 ? part / whole : null);

export function toRow(key: string, counts: EventCounts): DeliverabilityRow {
  const n = (type: SimEvent['type']) => counts[type] ?? 0;
  const sent = n('accepted');
  const delivered = n('delivered');
  return {
    key,
    sent,
    delivered,
    bounced: n('bounced'),
    complained: n('complained'),
    opened: n('opened'),
    clicked: n('clicked'),
    unsubscribed: n('unsubscribed'),
    rates: {
      delivery: rate(delivered, sent),
      bounce: rate(n('bounced'), sent),
      complaint: rate(n('complained'), delivered),
      open: rate(n('opened'), delivered),
      click: rate(n('clicked'), delivered),
    },
  };
}

/** What is over a threshold, worst level only, when there is volume enough to tell. */
export function alertsFor(row: DeliverabilityRow): DeliverabilityAlert[] {
  if (row.sent < MIN_VOLUME) return [];
  const alerts: DeliverabilityAlert[] = [];
  const check = (kind: DeliverabilityAlert['kind'], value: number | null) => {
    if (value === null) return;
    const { warning, critical } = THRESHOLDS[kind];
    if (value >= critical) alerts.push({ kind, level: 'critical', rate: value, threshold: critical });
    else if (value >= warning) alerts.push({ kind, level: 'warning', rate: value, threshold: warning });
  };
  check('bounces', row.rates.bounce);
  check('complaints', row.rates.complaint);
  return alerts;
}

/** The whole project as one row, from its stats. */
export function overallRow(stats: ProjectStats): DeliverabilityRow {
  return toRow('total', stats.events);
}

export async function deliverability(store: SimStore, project: Project, query: { since: Date; mode: Mode; by: DeliverabilityGroup }) {
  const [groups, stats] = await Promise.all([
    store.deliverability(project.id, { ...query, limit: 100 }),
    store.stats(project.id, query.since, query.mode),
  ]);
  const data = groups.map((g) => toRow(g.key, g.counts)).sort((a, b) => b.sent - a.sent || a.key.localeCompare(b.key));
  const overall = overallRow(stats);
  return {
    since: query.since,
    by: query.by,
    overall,
    alerts: alertsFor(overall),
    data: data.map((row) => ({ ...row, alerts: alertsFor(row) })),
  };
}

const percent = (value: number) => `${(value * 100).toLocaleString('es', { maximumFractionDigits: 2 })} %`;

/**
 * Emails the project's owner and admins when live sending goes over a threshold (last 24 hours): checked
 * at most every 10 minutes per project, and each kind of alert at most once a day.
 */
export class DeliverabilityAlerts {
  private readonly checked = new Map<string, number>();
  private readonly sent = new Map<string, number>();

  constructor(
    private readonly store: SimStore,
    private readonly mail: (mail: MailToSend) => Promise<void>,
    private readonly publicUrl: string,
    private readonly now = () => Date.now(),
  ) {}

  async check(project: Project): Promise<DeliverabilityAlert[]> {
    const now = this.now();
    if ((this.checked.get(project.id) ?? 0) > now - 10 * 60_000) return [];
    this.checked.set(project.id, now);
    const stats = await this.store.stats(project.id, new Date(now - 86_400_000), 'live');
    const fresh = alertsFor(overallRow(stats)).filter((a) => {
      const key = `${project.id}|${a.kind}|${a.level}`;
      if ((this.sent.get(key) ?? 0) > now - 86_400_000) return false;
      this.sent.set(key, now);
      return true;
    });
    if (!fresh.length) return [];
    const recipients = await this.recipients(project);
    const lines = fresh.map(
      (a) => `${a.kind === 'bounces' ? 'Rebotes' : 'Quejas'}: ${percent(a.rate)} en las últimas 24 horas (el umbral es ${percent(a.threshold)}).`,
    );
    const link = `${this.publicUrl}/deliverability`;
    for (const to of recipients) {
      await this.mail({
        to,
        subject: `Relayo: problemas de entregabilidad en «${project.name}»`,
        text: `Los envíos reales de «${project.name}» necesitan atención:\n\n${lines.join('\n')}\n\nDetalle por dominio, plantilla y etiqueta: ${link}`,
        html: `<p>Los envíos reales de <strong>${escape(project.name)}</strong> necesitan atención:</p><ul>${lines
          .map((l) => `<li>${escape(l)}</li>`)
          .join('')}</ul><p><a href="${link}">Ver el detalle por dominio, plantilla y etiqueta</a></p>`,
      }).catch(() => undefined);
    }
    return fresh;
  }

  private async recipients(project: Project): Promise<string[]> {
    const ids = new Set<string>(project.ownerId ? [project.ownerId] : []);
    for (const member of await this.store.listMembers(project.id)) if (member.role === 'admin') ids.add(member.userId);
    const users = await Promise.all([...ids].map((id) => this.store.getUser(id)));
    return users.flatMap((u) => (u ? [u.email] : []));
  }
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}
