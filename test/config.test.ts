import { describe, expect, it } from 'vitest';
import { configFromEnv } from '../src/config.js';

describe('config', () => {
  it('accepts smtp and smtps urls, with escaped users', () => {
    const config = configFromEnv({ MAIL_URL: 'smtp://ana%40gmail.com:app-password@smtp.gmail.com:587', MAIL_FROM: 'Relayo <ana@gmail.com>' });
    expect(config.mail).toEqual({ url: 'smtp://ana%40gmail.com:app-password@smtp.gmail.com:587', from: 'Relayo <ana@gmail.com>' });
    expect(configFromEnv({ MANAGED_SMTP_URL: 'smtps://u:p@email-smtp.eu-west-1.amazonaws.com:465' }).managed?.smtpUrl).toContain('smtps://');
  });

  it('refuses a malformed SMTP url at start, saying how to write it', () => {
    expect(() => configFromEnv({ MAIL_URL: 'smtp(s)://ana@gmail.com:secret@smtp.gmail.com:587' })).toThrow(/MAIL_URL must look like smtp:\/\//);
    expect(() => configFromEnv({ MAIL_URL: 'smtp.gmail.com:587' })).toThrow(/%40/);
    expect(() => configFromEnv({ MANAGED_SMTP_URL: 'https://example.com' })).toThrow(/MANAGED_SMTP_URL/);
  });
});
