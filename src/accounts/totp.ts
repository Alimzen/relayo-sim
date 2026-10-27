import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238), as authenticator apps (Google Authenticator, 1Password, Authy…)
 * generate them: HMAC-SHA1, 30-second steps, 6 digits. Secrets travel in base32 (RFC 4648), as the apps expect.
 */
const ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
const STEP_SECONDS = 30;
const DIGITS = 6;

export function base32Encode(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

export function base32Decode(text: string): Buffer {
  const clean = text.toUpperCase().replace(/[\s=-]/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of clean) {
    const index = ALPHABET.indexOf(char);
    if (index < 0) throw new Error('Invalid base32');
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

/** A new secret: 20 random bytes, the size RFC 4226 recommends for HMAC-SHA1. */
export const newSecret = () => base32Encode(randomBytes(20));

/** The code for a moment (now by default). */
export function totp(secret: string, at = Date.now()): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(at / 1000 / STEP_SECONDS)));
  const hmac = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const offset = hmac[hmac.length - 1]! & 15;
  const number = (hmac.readUInt32BE(offset) & 0x7fffffff) % 10 ** DIGITS;
  return String(number).padStart(DIGITS, '0');
}

/** Whether a code is valid now, allowing one step before and after for clock drift. */
export function verifyTotp(secret: string, code: string, at = Date.now()): boolean {
  const given = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(given)) return false;
  return [-1, 0, 1].some((step) => {
    const expected = totp(secret, at + step * STEP_SECONDS * 1000);
    return timingSafeEqual(Buffer.from(expected), Buffer.from(given));
  });
}

/** The link authenticator apps read from a QR code. */
export function otpauthUrl(issuer: string, account: string, secret: string): string {
  const label = encodeURIComponent(`${issuer}:${account}`);
  const params = new URLSearchParams({ secret, issuer, algorithm: 'SHA1', digits: String(DIGITS), period: String(STEP_SECONDS) });
  return `otpauth://totp/${label}?${params}`;
}

/** Ten single-use recovery codes, like `7kq2-m9xd`, for when the phone is lost. */
export function recoveryCodes(): string[] {
  const chars = 'abcdefghjkmnpqrstuvwxyz23456789';
  return Array.from({ length: 10 }, () => {
    const bytes = randomBytes(8);
    const code = Array.from(bytes, (b) => chars[b % chars.length]).join('');
    return `${code.slice(0, 4)}-${code.slice(4)}`;
  });
}
