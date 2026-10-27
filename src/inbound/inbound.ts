import { randomBytes, randomUUID } from 'node:crypto';
import { ses } from '@alimzen/relayo-ses';
import { simpleParser, type AddressObject } from 'mailparser';
import type { InboundEmail, Project } from '../domain.js';
import type { SimStore } from '../store/store.js';
import { webhookTargets, type InboundPayload, type WebhookDispatcher } from '../webhooks/webhooks.js';

/** The request an inbound route gets: whatever the provider posts. */
export interface InboundRequest {
  headers: Record<string, string | string[] | undefined>;
  body?: unknown;
  rawBody?: Buffer;
}

export class InboundError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'InboundError';
  }
}

/** Headers kept with a received email: the ones people route or thread by. */
const KEPT_HEADERS = /^(message-id|in-reply-to|references|reply-to|date|list-id|auto-submitted|x-[\w-]+)$/i;
const MAX_TEXT = 512 * 1024;

/**
 * The MIME source in what a provider posts: the raw message (\`message/rfc822\`), SendGrid's Inbound Parse
 * with "raw" on (\`email\`), Mailgun's \`body-mime\`, Postmark's \`RawEmail\`, a JSON \`raw\` (plain or base64),
 * or an Amazon SES notification through SNS (\`content\`).
 */
export function rawEmailOf(body: unknown): Buffer | undefined {
  if (Buffer.isBuffer(body)) return body.length ? body : undefined;
  if (typeof body === 'string') return body.trim() ? Buffer.from(body) : undefined;
  if (!body || typeof body !== 'object') return undefined;
  const fields = body as Record<string, unknown>;
  for (const key of ['email', 'body-mime', 'RawEmail']) {
    if (typeof fields[key] === 'string' && fields[key]) return Buffer.from(fields[key]);
  }
  if (typeof fields.raw === 'string' && fields.raw) {
    const raw = fields.raw;
    // Base64 has no spaces or colons; a MIME message has both in its first header.
    return /^[A-Za-z0-9+/=\r\n]+$/.test(raw) ? Buffer.from(raw, 'base64') : Buffer.from(raw);
  }
  return undefined;
}

/** What Relayo keeps of a received email, and what its webhook carries. */
export async function parseInbound(raw: Buffer): Promise<Omit<InboundEmail, 'id' | 'projectId' | 'createdAt' | 'replyTo'> & { references: string[] }> {
  const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  const addresses = (value: AddressObject | AddressObject[] | undefined) =>
    (Array.isArray(value) ? value : value ? [value] : []).flatMap((a) => a.value.map((v) => v.address?.toLowerCase() ?? '')).filter(Boolean);
  const sender = parsed.from?.value[0];
  const headers: Record<string, string> = {};
  for (const line of parsed.headerLines) {
    const name = line.key;
    if (KEPT_HEADERS.test(name) && !(name in headers)) headers[name] = line.line.slice(line.line.indexOf(':') + 1).trim().slice(0, 2000);
  }
  const references = [
    ...(typeof parsed.inReplyTo === 'string' ? [parsed.inReplyTo] : []),
    ...(Array.isArray(parsed.references) ? parsed.references : parsed.references ? [parsed.references] : []),
  ];
  const cc = addresses(parsed.cc);
  return {
    from: sender?.address?.toLowerCase() ?? '',
    ...(sender?.name && { fromName: sender.name }),
    to: addresses(parsed.to),
    ...(cc.length && { cc }),
    subject: parsed.subject ?? '',
    ...(parsed.text && { text: parsed.text.slice(0, MAX_TEXT) }),
    ...(typeof parsed.html === 'string' && { html: parsed.html.slice(0, MAX_TEXT) }),
    ...(parsed.messageId && { messageIdHeader: parsed.messageId }),
    ...(typeof parsed.inReplyTo === 'string' && { inReplyTo: parsed.inReplyTo }),
    attachments: parsed.attachments.map((a, i) => ({ filename: a.filename ?? `adjunto-${i + 1}`, contentType: a.contentType, size: a.size })),
    headers,
    size: raw.length,
    references,
  };
}

/** The ids a reply names (In-Reply-To, References), as a provider or Relayo may have stored them. */
export function referenceIds(references: string[]): string[] {
  const ids = new Set<string>();
  for (const reference of references) {
    for (const match of reference.matchAll(/<?([^<>\s]+)>?/g)) {
      const id = match[1]!;
      ids.add(id);
      ids.add(`<${id}>`);
      // SES and others: the Message-ID is <provider id@their domain>.
      if (id.includes('@')) ids.add(id.slice(0, id.indexOf('@')));
    }
  }
  return [...ids];
}

/** Emails received for a project: stored, matched to the message they answer, and sent to the webhooks that want them. */
export class InboundService {
  constructor(
    private readonly store: SimStore,
    private readonly webhooks: WebhookDispatcher,
  ) {}

  /** A token for the project's inbound URL. */
  static newToken(): string {
    return `inb_${randomBytes(18).toString('base64url')}`;
  }

  async receive(token: string, req: InboundRequest): Promise<InboundEmail | undefined> {
    const project = await this.store.findProjectByInboundToken(token);
    if (!project) throw new InboundError('Not found', 404);

    let raw = rawEmailOf(req.body);
    // Amazon SES through SNS: signed JSON, a subscription to confirm first.
    const sns = snsMessage(req.body);
    if (sns) {
      const driver = ses({ name: 'inbound', region: 'us-east-1', webhook: { confirmSubscriptions: true } });
      const signed = { headers: req.headers, body: sns.envelope, ...(req.rawBody && { rawBody: req.rawBody }) };
      if (!(await driver.verifyWebhook!(signed))) throw new InboundError('Invalid SNS signature', 401);
      if (sns.envelope.Type === 'SubscriptionConfirmation') {
        // The driver confirms the subscription (only on Amazon's own URLs).
        await driver.parseWebhook!(signed);
        return undefined;
      }
      raw = sns.content;
    }
    if (!raw) throw new InboundError('No email in the request: post the raw message (message/rfc822) or a provider format', 400);
    return this.accept(project, raw);
  }

  async accept(project: Project, raw: Buffer): Promise<InboundEmail> {
    const { references, ...parsed } = await parseInbound(raw);
    const answered = references.length ? await this.store.findMessageByReference(project.id, referenceIds(references)) : undefined;
    const email: InboundEmail = {
      id: `inb_${randomUUID()}`,
      projectId: project.id,
      ...parsed,
      ...(answered && {
        replyTo: {
          messageId: answered.relayoMessageId ?? answered.id,
          relayoId: answered.id,
          ...(answered.metadata && { metadata: answered.metadata }),
        },
      }),
      createdAt: new Date(),
    };
    await this.store.saveInbound(email);
    await this.dispatch(project, email);
    return email;
  }

  async dispatch(project: Project, email: InboundEmail): Promise<void> {
    const payload = inboundPayload(email);
    for (const target of await webhookTargets(this.store, project, payload, 'live')) await this.webhooks.dispatch(payload, target);
  }
}

/** The webhook of a received email. */
export function inboundPayload(email: InboundEmail): InboundPayload {
  const { projectId, createdAt, id, ...rest } = email;
  return {
    ...rest,
    id,
    type: 'inbound',
    channel: 'email',
    provider: 'relayo',
    messageId: email.replyTo?.messageId ?? id,
    recipient: email.to[0] ?? '',
    timestamp: createdAt,
    ...(email.replyTo?.metadata && { metadata: email.replyTo.metadata }),
    projectId,
  };
}

/** An SES notification (or subscription) posted by SNS, with the email it carries. */
function snsMessage(body: unknown): { envelope: Record<string, unknown>; content?: Buffer } | undefined {
  const envelope = typeof body === 'string' && body.trim().startsWith('{') ? (JSON.parse(body) as unknown) : body;
  if (!envelope || typeof envelope !== 'object' || Buffer.isBuffer(envelope)) return undefined;
  const fields = envelope as Record<string, unknown>;
  if (fields.Type !== 'Notification' && fields.Type !== 'SubscriptionConfirmation') return undefined;
  if (fields.Type === 'SubscriptionConfirmation') return { envelope: fields };
  try {
    const message = JSON.parse(String(fields.Message)) as { content?: string; receipt?: { action?: { encoding?: string } } };
    if (!message.content) return { envelope: fields };
    const base64 = message.receipt?.action?.encoding?.toUpperCase() === 'BASE64';
    return { envelope: fields, content: Buffer.from(message.content, base64 ? 'base64' : 'utf8') };
  } catch {
    return { envelope: fields };
  }
}
