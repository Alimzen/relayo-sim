import type { Attachment, EmailMessage, Recipient } from '@alimzen/relayo';
import { simpleParser, type AddressObject } from 'mailparser';

/** Headers the sender's library or the simulator use; the provider driver adds its own. */
const INTERNAL_HEADERS = new Set(['x-relayo-message-id', 'x-relayo-metadata', 'x-sim-scenario']);
/** Headers worth passing on to the provider; the rest (Received, DKIM, Message-ID...) the provider sets. */
const PASSED_ON = /^(x-|list-unsubscribe|list-id|precedence|auto-submitted|references|in-reply-to)/i;

/**
 * Turns an email received over SMTP into a Relayo message, so live mode can hand it to any provider.
 * Envelope recipients decide who gets it: those in To or Cc keep their place, the rest go as Bcc.
 */
export async function emailFromMime(
  raw: Buffer,
  envelope: { from: string; to: string[] },
): Promise<{ message: EmailMessage; relayoMessageId?: string }> {
  const parsed = await simpleParser(raw, { skipHtmlToText: true, skipTextToHtml: true, skipImageLinks: true });
  const listed = (value: AddressObject | AddressObject[] | undefined) =>
    new Set(addresses(value).map((r) => r.address.toLowerCase()));
  const inTo = listed(parsed.to);
  const inCc = listed(parsed.cc);
  const named = new Map([...addresses(parsed.to), ...addresses(parsed.cc)].map((r) => [r.address.toLowerCase(), r]));
  const recipient = (address: string): Recipient => named.get(address.toLowerCase()) ?? { address };

  const to = envelope.to.filter((a) => inTo.has(a.toLowerCase())).map(recipient);
  const cc = envelope.to.filter((a) => inCc.has(a.toLowerCase())).map(recipient);
  const bcc = envelope.to.filter((a) => !inTo.has(a.toLowerCase()) && !inCc.has(a.toLowerCase())).map(recipient);
  // A message needs someone in To: when every recipient was blind-copied, the first one takes that place.
  if (!to.length) to.push((bcc.shift() ?? cc.shift())!);

  const sender = addresses(parsed.from)[0] ?? { address: envelope.from };
  const headers: Record<string, string> = {};
  let metadata: Record<string, string> | undefined;
  let relayoMessageId: string | undefined;
  for (const { key, line } of parsed.headerLines) {
    const value = line.slice(line.indexOf(':') + 1).replace(/\r?\n[ \t]+/g, ' ').trim();
    if (key === 'x-relayo-message-id') relayoMessageId = value;
    else if (key === 'x-relayo-metadata') metadata = decodeMetadata(value);
    if (INTERNAL_HEADERS.has(key) || !PASSED_ON.test(key)) continue;
    headers[line.slice(0, line.indexOf(':')).trim()] = value;
  }

  const attachments: Attachment[] = parsed.attachments.map((a) => ({
    filename: a.filename ?? 'adjunto',
    content: a.content,
    contentType: a.contentType,
    ...(a.cid && { cid: a.cid }),
  }));
  const replyTo = addresses(parsed.replyTo)[0];

  const message: EmailMessage = {
    from: sender,
    to,
    ...(cc.length && { cc }),
    ...(bcc.length && { bcc }),
    ...(replyTo && { replyTo }),
    subject: parsed.subject ?? '',
    ...(typeof parsed.text === 'string' && { text: parsed.text }),
    ...(typeof parsed.html === 'string' && { html: parsed.html }),
    ...(attachments.length && { attachments }),
    ...(Object.keys(headers).length && { headers }),
    ...(metadata && { metadata }),
  };
  return { message, ...(relayoMessageId && { relayoMessageId }) };
}

function addresses(value: AddressObject | AddressObject[] | undefined): Recipient[] {
  const list = value === undefined ? [] : Array.isArray(value) ? value : [value];
  return list.flatMap((group) =>
    group.value.flatMap((a) => (a.address ? [{ address: a.address, ...(a.name && { name: a.name }) }] : [])),
  );
}

function decodeMetadata(value: string): Record<string, string> | undefined {
  try {
    const parsed: unknown = JSON.parse(Buffer.from(value, 'base64url').toString('utf8'));
    return parsed && typeof parsed === 'object' ? (parsed as Record<string, string>) : undefined;
  } catch {
    return undefined;
  }
}
