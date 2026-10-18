import { simpleParser, type AddressObject } from 'mailparser';
import nodemailer from 'nodemailer';

/** An attachment as the HTTP API receives it: content in base64. */
export interface ApiAttachment {
  filename: string;
  content: string;
  contentType?: string;
  /** Content-ID, for inline images referenced as `cid:` from the HTML. */
  cid?: string;
}

export type MailAddress = string | { name: string; address: string };

export interface ComposeInput {
  from: MailAddress;
  to: MailAddress[];
  cc?: MailAddress[];
  replyTo?: MailAddress;
  subject: string;
  text?: string;
  html?: string;
  headers?: Record<string, string>;
  attachments?: ApiAttachment[];
}

/** Composes the email a provider would have sent for an API request, so it can be captured like SMTP mail. */
export async function composeMessage(input: ComposeInput): Promise<Buffer> {
  const transport = nodemailer.createTransport({ streamTransport: true, buffer: true, newline: 'windows' });
  const info = await transport.sendMail({
    from: input.from,
    to: input.to,
    ...(input.cc?.length && { cc: input.cc }),
    ...(input.replyTo && { replyTo: input.replyTo }),
    subject: input.subject,
    ...(input.text !== undefined && { text: input.text }),
    ...(input.html !== undefined && { html: input.html }),
    ...(input.headers && { headers: input.headers }),
    ...(input.attachments?.length && {
      attachments: input.attachments.map((a) => ({
        filename: a.filename,
        content: Buffer.from(a.content, 'base64'),
        ...(a.contentType && { contentType: a.contentType }),
        ...(a.cid && { cid: a.cid }),
      })),
    }),
  });
  return info.message as Buffer;
}

export interface CapturedAttachment {
  /** Position in the message; the id used to download it. */
  index: number;
  filename: string;
  contentType: string;
  size: number;
  /** Shown inside the HTML (referenced by `cid:`), not as a separate file. */
  inline: boolean;
}

export interface CapturedContent {
  subject: string;
  from?: string;
  to?: string;
  cc?: string;
  replyTo?: string;
  date?: string;
  messageId?: string;
  text?: string;
  /** HTML with `cid:` images inlined as data URIs, ready to show in a sandboxed frame. */
  html?: string;
  headers: Array<{ name: string; value: string }>;
  attachments: CapturedAttachment[];
  size: number;
}

/** Inline images larger than this stay as `cid:` links instead of being embedded in the HTML. */
const MAX_INLINE_IMAGE = 2 * 1024 * 1024;

/** Reads a captured message for display: bodies, headers and the list of attachments. */
export async function readContent(raw: Buffer): Promise<CapturedContent> {
  const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });

  const attachments = parsed.attachments.map((a, index) => ({
    index,
    filename: a.filename ?? `adjunto-${index + 1}`,
    contentType: a.contentType,
    size: a.size,
    inline: Boolean(a.cid && a.related),
    cid: a.cid,
    content: a.content,
  }));

  let html = typeof parsed.html === 'string' ? parsed.html : undefined;
  if (html) {
    for (const a of attachments) {
      if (!a.cid || a.size > MAX_INLINE_IMAGE) continue;
      const uri = `data:${a.contentType};base64,${a.content.toString('base64')}`;
      html = html.replaceAll(`cid:${a.cid}`, uri);
    }
  }

  return {
    subject: parsed.subject ?? '',
    ...(parsed.from && { from: parsed.from.text }),
    ...(parsed.to && { to: addressText(parsed.to) }),
    ...(parsed.cc && { cc: addressText(parsed.cc) }),
    ...(parsed.replyTo && { replyTo: parsed.replyTo.text }),
    ...(parsed.date && { date: parsed.date.toISOString() }),
    ...(parsed.messageId && { messageId: parsed.messageId }),
    ...(parsed.text !== undefined && { text: parsed.text }),
    ...(html !== undefined && { html }),
    headers: parsed.headerLines.map(({ line }) => {
      const colon = line.indexOf(':');
      return { name: line.slice(0, colon).trim(), value: line.slice(colon + 1).replace(/\r?\n[ \t]+/g, ' ').trim() };
    }),
    attachments: attachments.map(({ index, filename, contentType, size, inline }) => ({ index, filename, contentType, size, inline })),
    size: raw.length,
  };
}

/** One attachment of a captured message, for download. */
export async function readAttachment(raw: Buffer, index: number) {
  const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  const a = parsed.attachments[index];
  return a && { filename: a.filename ?? `adjunto-${index + 1}`, contentType: a.contentType, content: a.content };
}

function addressText(value: AddressObject | AddressObject[]): string {
  return (Array.isArray(value) ? value : [value]).map((a) => a.text).join(', ');
}

/** Top-level headers of a raw message, lowercased names, folded lines joined. */
export function readHeaders(raw: string): Map<string, string> {
  const end = raw.search(/\r?\n\r?\n/);
  const block = end === -1 ? raw : raw.slice(0, end);
  const headers = new Map<string, string>();
  let current: [string, string] | undefined;
  for (const line of block.split(/\r?\n/)) {
    if (/^[ \t]/.test(line) && current) {
      current[1] += ` ${line.trim()}`;
      continue;
    }
    if (current && !headers.has(current[0])) headers.set(current[0], current[1].trim());
    const colon = line.indexOf(':');
    current = colon > 0 ? [line.slice(0, colon).trim().toLowerCase(), line.slice(colon + 1)] : undefined;
  }
  if (current && !headers.has(current[0])) headers.set(current[0], current[1].trim());
  return headers;
}

/** Original headers kept to quote back in bounce and complaint reports. */
const QUOTED = ['from', 'to', 'subject', 'date', 'message-id', 'x-relayo-message-id', 'x-relayo-metadata'];

export function quotedHeaders(headers: Map<string, string>): Record<string, string> {
  return Object.fromEntries(QUOTED.filter((name) => headers.has(name)).map((name) => [name, headers.get(name)!]));
}
