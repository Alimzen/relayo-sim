import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** What a link in a sent email points at: the project, the message and the one recipient it went to. */
export interface LinkTarget {
  projectId: string;
  messageId: string;
  recipient: string;
}

/**
 * Signed tokens for the links Relayo puts in live emails (unsubscribe, and later tracking): anyone can read
 * them, nobody can forge one without the server's key.
 */
export class LinkSigner {
  private readonly key: Buffer;

  constructor(
    secret: string,
    /** Public address of this server, where the links point. */
    readonly publicUrl: string,
  ) {
    // Its own key, so a token never doubles as anything sealed with the same secret.
    this.key = createHash('sha256').update(`relayo-links:${secret}`).digest();
  }

  sign(target: LinkTarget, extra: Record<string, string> = {}): string {
    const payload = Buffer.from(JSON.stringify({ p: target.projectId, m: target.messageId, r: target.recipient, ...extra })).toString('base64url');
    return `${payload}.${this.mac(payload)}`;
  }

  /** The target of a token, or undefined when it was not signed here or was changed. */
  open(token: string): (LinkTarget & { extra: Record<string, string> }) | undefined {
    const [payload, mac] = token.split('.');
    if (!payload || !mac) return undefined;
    const expected = Buffer.from(this.mac(payload));
    const given = Buffer.from(mac);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return undefined;
    try {
      const { p, m, r, ...extra } = JSON.parse(Buffer.from(payload, 'base64url').toString('utf8')) as Record<string, string>;
      if (!p || !m || !r) return undefined;
      return { projectId: p, messageId: m, recipient: r, extra };
    } catch {
      return undefined;
    }
  }

  unsubscribeUrl(target: LinkTarget): string {
    return `${this.publicUrl}/u/${this.sign(target)}`;
  }

  private mac(payload: string): string {
    return createHmac('sha256', this.key).update(payload).digest().subarray(0, 18).toString('base64url');
  }
}

/** The placeholder people put in their emails for the unsubscribe link. */
export const UNSUBSCRIBE_TAG = /\{\{\s*unsubscribe_url\s*\}\}/gi;
