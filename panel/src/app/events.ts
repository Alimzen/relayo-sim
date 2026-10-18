import type { SimEvent, SimMessage } from './api.service';

export interface EventLook {
  label: string;
  tone: 'ok' | 'info' | 'wait' | 'warn' | 'bad' | 'block' | 'muted';
}

const LABELS: Record<string, string> = {
  accepted: 'Aceptado',
  delivered: 'Entregado',
  deferred: 'Aplazado',
  bounced: 'Rebotado',
  complained: 'Queja',
  rejected: 'Rechazado',
  opened: 'Abierto',
  clicked: 'Clic',
  unsubscribed: 'Baja',
  failed: 'Fallido',
};

/** Label and color of an event, for badges and the timeline. */
export function lookOf(event: Pick<SimEvent, 'type' | 'bounceType'>): EventLook {
  const label = LABELS[event.type] ?? event.type;
  switch (event.type) {
    case 'delivered':
      return { label, tone: 'ok' };
    case 'opened':
    case 'clicked':
      return { label, tone: 'info' };
    case 'accepted':
      return { label, tone: 'muted' };
    case 'deferred':
      return { label, tone: 'wait' };
    case 'bounced':
      if (event.bounceType === 'block') return { label: 'Bloqueado', tone: 'block' };
      if (event.bounceType === 'soft') return { label: 'Rebote suave', tone: 'warn' };
      return { label: 'Rebote duro', tone: 'bad' };
    case 'complained':
    case 'rejected':
    case 'failed':
      return { label, tone: 'bad' };
    case 'unsubscribed':
      return { label, tone: 'warn' };
    default:
      return { label, tone: 'muted' };
  }
}

/** One-line explanation of an event, when it has details worth showing. */
export function detailOf(event: SimEvent): string | undefined {
  if (event.type === 'bounced') {
    const code = [event.smtpCode, event.enhancedCode].filter(Boolean).join(' ');
    return [event.reason, code].filter(Boolean).join(' · ');
  }
  if (event.type === 'rejected') return event.reason;
  if (event.type === 'clicked') return event.url;
  return undefined;
}

/** Which email report an event has: a DSN for bounces and deferrals, an ARF report for complaints. */
export function reportOf(event: Pick<SimEvent, 'type'>): 'DSN' | 'ARF' | undefined {
  if (event.type === 'bounced' || event.type === 'deferred') return 'DSN';
  if (event.type === 'complained') return 'ARF';
  return undefined;
}

export function scenarioLabel(recipient: SimMessage['recipients'][number]): string {
  const { name, param } = recipient.scenario;
  return param ? `${name}+${param}` : name;
}
