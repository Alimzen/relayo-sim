import type { BounceType, EventType, Recipient, SimEvent } from './types';

export type Tone = 'good' | 'info' | 'neutral' | 'warning' | 'serious' | 'critical' | 'block';

export interface StatusLook {
  label: string;
  tone: Tone;
}

export const EVENT_LABELS: Record<EventType, string> = {
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

/** Label and tone of an event. Every tone is shown with its label, never as color alone. */
export function lookOf(event: { type: EventType; bounceType?: BounceType | undefined }): StatusLook {
  switch (event.type) {
    case 'delivered':
      return { label: EVENT_LABELS.delivered, tone: 'good' };
    case 'opened':
    case 'clicked':
      return { label: EVENT_LABELS[event.type], tone: 'info' };
    case 'accepted':
      return { label: EVENT_LABELS.accepted, tone: 'neutral' };
    case 'deferred':
      return { label: EVENT_LABELS.deferred, tone: 'warning' };
    case 'bounced':
      if (event.bounceType === 'block') return { label: 'Bloqueado', tone: 'block' };
      if (event.bounceType === 'soft') return { label: 'Rebote suave', tone: 'serious' };
      return { label: 'Rebote duro', tone: 'critical' };
    case 'unsubscribed':
      return { label: EVENT_LABELS.unsubscribed, tone: 'warning' };
    default:
      return { label: EVENT_LABELS[event.type], tone: 'critical' };
  }
}

/** Status filter options for message lists. */
export const STATUS_FILTERS: Array<{ value: EventType | ''; label: string }> = [
  { value: '', label: 'Todos los estados' },
  { value: 'delivered', label: 'Entregados' },
  { value: 'bounced', label: 'Rebotados' },
  { value: 'deferred', label: 'Aplazados' },
  { value: 'complained', label: 'Con queja' },
  { value: 'rejected', label: 'Rechazados' },
  { value: 'opened', label: 'Abiertos' },
  { value: 'clicked', label: 'Con clic' },
  { value: 'unsubscribed', label: 'Con baja' },
];

const REASONS: Record<string, string> = {
  user_unknown: 'El usuario no existe',
  domain_invalid: 'El dominio no recibe correo',
  mailbox_full: 'Buzón lleno',
  mailbox_disabled: 'Buzón desactivado',
  message_too_large: 'Mensaje demasiado grande',
  content_rejected: 'Contenido rechazado',
  policy_block: 'Bloqueado por política',
  auth_failure: 'Fallo de SPF/DKIM/DMARC',
  reputation_block: 'IP o dominio en lista negra',
  rate_limited: 'Límite de envío',
  temporary_failure: 'Fallo temporal',
  suppressed: 'En lista de supresión',
  unknown: 'Motivo desconocido',
};

/** SMS reasons in the words of phones, not mailboxes. */
const SMS_REASONS: Record<string, string> = {
  user_unknown: 'El número no existe',
  unknown: 'No puede recibir SMS',
  temporary_failure: 'Teléfono inalcanzable',
  content_rejected: 'Filtrado por el operador',
  suppressed: 'Respondió STOP antes',
};

export const reasonText = (reason: string | undefined, channel?: string) =>
  reason ? ((channel === 'sms' ? SMS_REASONS[reason] : undefined) ?? REASONS[reason] ?? reason) : undefined;

/** One-line explanation of an event, when it has details worth showing. */
export function detailOf(event: SimEvent): string | undefined {
  if (event.type === 'bounced') {
    const code = [event.smtpCode, event.enhancedCode].filter(Boolean).join(' ');
    return [reasonText(event.reason, event.channel), code].filter(Boolean).join(' · ');
  }
  if (event.type === 'unsubscribed' && (event as { channel?: string }).channel === 'sms') {
    return 'Respondió STOP';
  }
  if (event.type === 'rejected') return reasonText(event.reason, event.channel);
  if (event.type === 'clicked') return event.url;
  return undefined;
}

/** Which email report an event has: a DSN for bounces and deferrals, an ARF report for complaints. SMS have none. */
export function reportOf(event: Pick<SimEvent, 'type'> & { channel?: string }): 'DSN' | 'ARF' | undefined {
  if (event.channel === 'sms') return undefined;
  if (event.type === 'bounced' || event.type === 'deferred') return 'DSN';
  if (event.type === 'complained') return 'ARF';
  return undefined;
}

export function scenarioLabel(recipient: Recipient | undefined): string {
  if (!recipient) return '—';
  const { name, param } = recipient.scenario;
  return param ? `${name}+${param}` : name;
}
