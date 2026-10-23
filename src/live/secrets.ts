import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';

/**
 * Encrypts provider credentials at rest with AES-256-GCM. The key comes from SECRETS_KEY (32 random bytes,
 * base64) and never touches the database: a database dump alone does not reveal anyone's credentials.
 * Format: `v1.<iv>.<tag>.<ciphertext>`, base64url parts.
 *
 * To change the key, set the new one as SECRETS_KEY and the old one in SECRETS_KEY_PREVIOUS: values sealed
 * with an old key still open, and `reseal` moves them to the new one (done for every stored secret at start).
 */
export class SecretBox {
  /** The current key first, then the previous ones. */
  private readonly keys: Buffer[];

  constructor(key: string, previous: string[] = []) {
    this.keys = [key, ...previous].map(derive);
  }

  seal(value: unknown): string {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm', this.keys[0]!, iv);
    const data = Buffer.concat([cipher.update(JSON.stringify(value), 'utf8'), cipher.final()]);
    return ['v1', iv.toString('base64url'), cipher.getAuthTag().toString('base64url'), data.toString('base64url')].join('.');
  }

  open<T>(sealed: string): T {
    return this.unseal<T>(sealed).value;
  }

  /** The value sealed again with the current key, if it was sealed with a previous one; otherwise undefined. */
  reseal(sealed: string): string | undefined {
    const { value, current } = this.unseal(sealed);
    return current ? undefined : this.seal(value);
  }

  private unseal<T>(sealed: string): { value: T; current: boolean } {
    const [version, iv, tag, data] = sealed.split('.');
    if (version !== 'v1' || !iv || !tag || data === undefined) throw new Error('Unrecognized secret format');
    let failure: unknown;
    for (const [index, key] of this.keys.entries()) {
      try {
        const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(iv, 'base64url'));
        decipher.setAuthTag(Buffer.from(tag, 'base64url'));
        const plain = Buffer.concat([decipher.update(Buffer.from(data, 'base64url')), decipher.final()]);
        return { value: JSON.parse(plain.toString('utf8')) as T, current: index === 0 };
      } catch (error) {
        // GCM refuses a wrong key: try the next one.
        failure = error;
      }
    }
    throw new Error('Cannot decrypt the secret with SECRETS_KEY (or SECRETS_KEY_PREVIOUS)', { cause: failure });
  }
}

/** A 32-byte key is used as is; anything else (a passphrase in development) is stretched with SHA-256. */
function derive(key: string): Buffer {
  const raw = Buffer.from(key, 'base64');
  return raw.length === 32 ? raw : createHash('sha256').update(key).digest();
}
