import { createHash } from 'node:crypto';
import type { BounceEvent } from '@alimzen/core';
import type { SimEvent, SimMessage } from '../domain.js';
import type { TimelineStep } from '../scenarios/catalog.js';

export const REPORTING_MTA = 'sim.relayo.dev';
const CRLF = '\r\n';

/** Headers of the original message quoted in reports, in this order. */
const QUOTED_HEADERS = ['From', 'To', 'Subject', 'Date', 'Message-ID', 'X-Relayo-Message-ID', 'X-Relayo-Metadata'];

/** Which events come back as an email report, and which kind. */
export function reportKind(event: Pick<SimEvent, 'type'>): 'dsn' | 'arf' | undefined {
  if (event.type === 'bounced' || event.type === 'deferred') return 'dsn';
  if (event.type === 'complained') return 'arf';
  return undefined;
}

/** Headers to quote for a message: the ones it was sent with, or Relayo-style ones for API sends. */
export function quotedHeaders(message: SimMessage, recipient: string): Record<string, string> {
  const domain = message.from.slice(message.from.lastIndexOf('@') + 1) || REPORTING_MTA;
  const synthesized: Record<string, string> = {
    From: message.from,
    To: recipient,
    Subject: message.subject,
    Date: message.createdAt.toUTCString(),
    'Message-ID': `<${message.relayoMessageId ?? message.id}@${domain}>`,
  };
  if (message.relayoMessageId) synthesized['X-Relayo-Message-ID'] = message.relayoMessageId;
  if (message.metadata) {
    synthesized['X-Relayo-Metadata'] = Buffer.from(JSON.stringify(message.metadata), 'utf8').toString('base64url');
  }
  const given = Object.fromEntries(Object.entries(message.headers ?? {}).map(([k, v]) => [canonical(k), v]));
  return { ...synthesized, ...given };
}

/** A delivery status notification (RFC 3464) for a bounce (`failed`) or a deferral (`delayed`). */
export function buildDsn(message: SimMessage, event: SimEvent): string {
  const failed = event.type === 'bounced';
  const step = (event.raw as { step?: TimelineStep } | undefined)?.step;
  const bounce = failed ? (event as unknown as BounceEvent) : undefined;
  const code = bounce?.smtpCode ?? step?.smtp?.code ?? 451;
  const status = bounce?.enhancedCode ?? step?.smtp?.enhancedCode ?? '4.0.0';
  const diagnostic = bounce?.diagnostic ?? step?.smtp?.diagnostic ?? `${code} ${status} Delivery delayed`;
  const recipient = event.recipient;
  const boundary = `dsn-${hash(event.id).slice(0, 24)}`;
  const arrival = message.createdAt.toUTCString();
  const attempt = event.timestamp.toUTCString();

  const human = failed
    ? [
        `This is the mail system at host ${REPORTING_MTA}.`,
        '',
        "I'm sorry to have to inform you that your message could not be delivered to one or more recipients.",
        '',
        `<${recipient}>: ${diagnostic}`,
      ]
    : [
        `This is the mail system at host ${REPORTING_MTA}.`,
        '',
        'Your message could not be delivered yet. The mail system will keep trying.',
        '',
        `<${recipient}>: ${diagnostic}`,
      ];

  const perRecipient = [
    `Final-Recipient: rfc822; ${recipient}`,
    `Original-Recipient: rfc822; ${recipient}`,
    `Action: ${failed ? 'failed' : 'delayed'}`,
    `Status: ${status}`,
    `Remote-MTA: dns; mx.${REPORTING_MTA}`,
    `Diagnostic-Code: smtp; ${diagnostic}`,
    `Last-Attempt-Date: ${attempt}`,
  ];
  if (!failed) perRecipient.push(`Will-Retry-Until: ${new Date(event.timestamp.getTime() + 5 * 86_400_000).toUTCString()}`);

  return message822(
    {
      From: `Mail Delivery System <MAILER-DAEMON@${REPORTING_MTA}>`,
      To: `<${reportRecipient(message)}>`,
      Subject: failed ? 'Undelivered Mail Returned to Sender' : 'Delayed Mail (still being retried)',
      Date: attempt,
      'Message-ID': `<${hash(`dsn:${event.id}`).slice(0, 32)}@${REPORTING_MTA}>`,
      'Auto-Submitted': 'auto-replied',
      'MIME-Version': '1.0',
      'Content-Type': `multipart/report; report-type=delivery-status; boundary="${boundary}"`,
    },
    boundary,
    [
      { type: 'text/plain; charset=utf-8', description: 'Notification', body: human.join(CRLF) },
      {
        type: 'message/delivery-status',
        description: 'Delivery report',
        body: [`Reporting-MTA: dns; ${REPORTING_MTA}`, `Arrival-Date: ${arrival}`, '', ...perRecipient].join(CRLF),
      },
      { type: 'text/rfc822-headers', description: 'Undelivered Message Headers', body: headerLines(quotedHeaders(message, recipient)) },
    ],
  );
}

/** A feedback-loop complaint report (ARF, RFC 5965). */
export function buildArf(message: SimMessage, event: SimEvent): string {
  const boundary = `arf-${hash(event.id).slice(0, 24)}`;
  const domain = message.from.slice(message.from.lastIndexOf('@') + 1);
  return message822(
    {
      From: `Feedback Loop <fbl@${REPORTING_MTA}>`,
      To: `<${reportRecipient(message)}>`,
      Subject: `Complaint about message from ${domain}`,
      Date: event.timestamp.toUTCString(),
      'Message-ID': `<${hash(`arf:${event.id}`).slice(0, 32)}@${REPORTING_MTA}>`,
      'MIME-Version': '1.0',
      'Content-Type': `multipart/report; report-type=feedback-report; boundary="${boundary}"`,
    },
    boundary,
    [
      {
        type: 'text/plain; charset=utf-8',
        body: `This is an email abuse report for a message sent to ${event.recipient}.`,
      },
      {
        type: 'message/feedback-report',
        body: [
          'Feedback-Type: abuse',
          'User-Agent: RelayoSim/0.1',
          'Version: 1',
          `Original-Mail-From: <${reportRecipient(message)}>`,
          `Original-Rcpt-To: <${event.recipient}>`,
          `Arrival-Date: ${message.createdAt.toUTCString()}`,
          `Reported-Domain: ${domain}`,
        ].join(CRLF),
      },
      { type: 'text/rfc822-headers', body: headerLines(quotedHeaders(message, event.recipient)) },
    ],
  );
}

export function buildReport(message: SimMessage, event: SimEvent): string | undefined {
  const kind = reportKind(event);
  if (kind === 'dsn') return buildDsn(message, event);
  if (kind === 'arf') return buildArf(message, event);
  return undefined;
}

/** Reports go to the envelope sender, as they would from a real receiving server. */
export function reportRecipient(message: SimMessage): string {
  return message.envelopeFrom || message.from;
}

function message822(
  headers: Record<string, string>,
  boundary: string,
  parts: Array<{ type: string; description?: string; body: string }>,
): string {
  const lines = [headerLines(headers), '', 'This is a MIME-encapsulated message.', ''];
  for (const part of parts) {
    lines.push(`--${boundary}`);
    if (part.description) lines.push(`Content-Description: ${part.description}`);
    lines.push(`Content-Type: ${part.type}`, '', part.body, '');
  }
  lines.push(`--${boundary}--`, '');
  return lines.join(CRLF);
}

function headerLines(headers: Record<string, string>): string {
  const order = [...QUOTED_HEADERS, ...Object.keys(headers).filter((k) => !QUOTED_HEADERS.includes(k))];
  return order
    .filter((name) => headers[name] !== undefined)
    .map((name) => `${name}: ${headers[name]!.replace(/[\r\n]+/g, ' ')}`)
    .join(CRLF);
}

/** `x-relayo-message-id` → `X-Relayo-Message-ID`. */
function canonical(name: string): string {
  const special: Record<string, string> = { 'message-id': 'Message-ID', 'x-relayo-message-id': 'X-Relayo-Message-ID' };
  return special[name.toLowerCase()] ?? name.toLowerCase().replace(/(^|-)([a-z])/g, (_, dash: string, c: string) => dash + c.toUpperCase());
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}
