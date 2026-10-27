import { describe, expect, it } from 'vitest';
import { AccountsService } from '../src/accounts/accounts.service.js';
import { base32Decode, base32Encode, totp, verifyTotp } from '../src/accounts/totp.js';
import { SecretBox } from '../src/live/secrets.js';
import { MemoryScheduler } from '../src/scheduler/scheduler.js';
import { SimulationService } from '../src/simulation/simulation.service.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { MemoryDispatcher } from '../src/webhooks/webhooks.js';

describe('TOTP', () => {
  it('matches the RFC 6238 test vectors (SHA-1, last 6 digits)', () => {
    const secret = base32Encode(Buffer.from('12345678901234567890'));
    expect(secret).toBe('GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(base32Decode(secret).toString()).toBe('12345678901234567890');
    expect(totp(secret, 59_000)).toBe('287082');
    expect(totp(secret, 1_111_111_109_000)).toBe('081804');
    expect(totp(secret, 1_234_567_890_000)).toBe('005924');
    expect(verifyTotp(secret, '287 082', 59_000)).toBe(true);
    // One step of clock drift either way, not two.
    expect(verifyTotp(secret, totp(secret, 59_000 + 30_000), 59_000)).toBe(true);
    expect(verifyTotp(secret, totp(secret, 59_000 + 90_000), 59_000)).toBe(false);
    expect(verifyTotp(secret, 'abcdef', 59_000)).toBe(false);
  });
});

function setup() {
  const store = new MemoryStore();
  const sim = new SimulationService(store, new MemoryScheduler(), new MemoryDispatcher(), { timeScale: 0 });
  const accounts = new AccountsService(store, sim, { secrets: new SecretBox('k') });
  return { store, accounts };
}

describe('two-factor sign-in', () => {
  it('turns on with a first code, then asks for a code after the password', async () => {
    const { store, accounts } = setup();
    const { user } = await accounts.signup({ email: 'ana@empresa.com', name: 'Ana', password: 'una-clave-larga' });
    const { secret, otpauthUrl } = await accounts.setupTwoFactor(user);
    expect(otpauthUrl).toMatch(/^otpauth:\/\/totp\/Relayo%3Aana%40empresa\.com\?secret=[A-Z2-7]+&issuer=Relayo/);
    // Sealed at rest.
    expect((await store.getUser(user.id))!.twoFactor!.pending).not.toContain(secret);

    let current = (await store.getUser(user.id))!;
    await expect(accounts.enableTwoFactor(current, { code: '000000' })).rejects.toMatchObject({ status: 400 });
    const codes = await accounts.enableTwoFactor(current, { code: totp(secret) });
    expect(codes).toHaveLength(10);
    current = (await store.getUser(user.id))!;
    expect(accounts.present(current).twoFactor).toBe(true);

    const first = await accounts.login({ email: 'ana@empresa.com', password: 'una-clave-larga' }, 'ip');
    expect(first).not.toHaveProperty('token');
    const ticket = (first as { ticket: string }).ticket;
    // A wrong code does not use up the ticket.
    await expect(accounts.completeLogin({ ticket, code: '000000' }, 'ip')).rejects.toMatchObject({ status: 401 });
    const { token } = await accounts.completeLogin({ ticket, code: totp(secret) }, 'ip');
    expect(await accounts.userForSession(token)).toMatchObject({ user: { id: user.id } });
    await expect(accounts.completeLogin({ ticket, code: totp(secret) }, 'ip')).rejects.toMatchObject({ status: 401 });

    // A recovery code works once.
    const second = (await accounts.login({ email: 'ana@empresa.com', password: 'una-clave-larga' }, 'ip')) as { ticket: string };
    await accounts.completeLogin({ ticket: second.ticket, code: codes[0]! }, 'ip');
    const third = (await accounts.login({ email: 'ana@empresa.com', password: 'una-clave-larga' }, 'ip')) as { ticket: string };
    await expect(accounts.completeLogin({ ticket: third.ticket, code: codes[0]! }, 'ip')).rejects.toMatchObject({ status: 401 });

    // Off with the password and a code.
    current = (await store.getUser(user.id))!;
    await expect(accounts.disableTwoFactor(current, { password: 'mal', code: totp(secret) })).rejects.toMatchObject({ status: 400 });
    await accounts.disableTwoFactor(current, { password: 'una-clave-larga', code: totp(secret) });
    expect(await accounts.login({ email: 'ana@empresa.com', password: 'una-clave-larga' }, 'ip')).toHaveProperty('token');
  });

  it('limits wrong codes per account', async () => {
    const { store, accounts } = setup();
    const { user } = await accounts.signup({ email: 'luis@empresa.com', name: 'Luis', password: 'una-clave-larga' });
    const { secret } = await accounts.setupTwoFactor(user);
    await accounts.enableTwoFactor((await store.getUser(user.id))!, { code: totp(secret) });
    const { ticket } = (await accounts.login({ email: 'luis@empresa.com', password: 'una-clave-larga' }, 'ip')) as { ticket: string };
    for (let i = 0; i < 5; i++) await expect(accounts.completeLogin({ ticket, code: '000000' }, 'ip')).rejects.toMatchObject({ status: 401 });
    await expect(accounts.completeLogin({ ticket, code: totp(secret) }, 'ip')).rejects.toMatchObject({ status: 429 });
  });
});
