import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encrypts provider credentials at rest with AES-256-GCM. The key comes from SECRETS_KEY (32 random bytes,
 * base64) and never touches the database: a database dump alone does not reveal anyone's credentials.
 * Format: `v1.<iv>.<tag>.<ciphertext>`, base64url parts.
 */
export class SecretBox {
  private readonly key: Buffer;

  constructor(key: string) {
    const raw = Buffer.from(key, 'base64');
    // A 32-byte key is used as is; anything else (a passphrase in development) is stretched with SHA-256.
    this.key = raw.length === 32 ? raw : createHash('sha256').update(key).digest();
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.key, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  open<T>(sealed: string): T {
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unrecognized secret format');
    const decipher = createDecipheriv('aes-256-gcm', this.key, Buffer.from(iv, 'base64url'));
    decipher.setAuthTag(Buffer.from(tag, 'base64url'));
    const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]);
    return JSON.parse(plain.toString('utf8')) as T;
  }
}
