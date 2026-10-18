import { describe, expect, it } from 'vitest';
import { AccountsService } from '../src/accounts/accounts.service.js';
import { parseAddress, type MailToSend } from '../src/accounts/mailer.js';
import { MemoryScheduler } from '../src/scheduler/scheduler.js';
import { SimulationService } from '../src/simulation/simulation.service.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { MemoryDispatcher } from '../src/webhooks/webhooks.js';

function accounts() {
  const store = new MemoryStore();
  const sim = new SimulationService(store, new MemoryScheduler(), new MemoryDispatcher(), { timeScale: 0 });
  const sent: MailToSend[] = [];
  const service = new AccountsService(store, sim, {
    publicUrl: 'https://relayo.alimzen.com',
    mailer: { send: async (mail) => void sent.push(mail) },
  });
  return { store, service, sent };
}

const tokenOf = (mail: MailToSend) => /reset-password\?token=([\w-]+)/.exec(mail.text)![1]!;

describe('password reset', () => {
  it('emails a single-use link that sets a new password and signs out every session', async () => {
    const { store, service, sent } = accounts();
    const { user, token: oldSession } = await service.signup({ email: 'ana@empresa.com', name: 'Ana', password: 'contraseña-vieja' });

    await service.requestPasswordReset({ email: 'ANA@empresa.com' }, '1.2.3.4');
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe('ana@empresa.com');
    expect(sent[0]!.text).toContain('https://relayo.alimzen.com/reset-password?token=');
    expect(sent[0]!.html).toContain('Elegir una contraseña nueva');
    const token = tokenOf(sent[0]!);

    await expect(service.resetPassword({ token, password: 'corta' })).rejects.toMatchObject({ status: 400 });
    const { token: session } = await service.resetPassword({ token, password: 'contraseña-nueva' });
    expect(await service.userForSession(session)).toMatchObject({ user: { id: user.id } });
    expect(await service.userForSession(oldSession)).toBeUndefined();
    await expect(service.login({ email: 'ana@empresa.com', password: 'contraseña-vieja' }, 'ip')).rejects.toMatchObject({ status: 401 });
    await service.login({ email: 'ana@empresa.com', password: 'contraseña-nueva' }, 'ip');

    await expect(service.resetPassword({ token, password: 'otra-contraseña' })).rejects.toMatchObject({ status: 400 });
    expect(store).toBeDefined();
  });

  it('answers the same for unknown emails, without sending anything', async () => {
    const { service, sent } = accounts();
    await expect(service.requestPasswordReset({ email: 'nadie@empresa.com' }, 'ip')).resolves.toBeUndefined();
    expect(sent).toHaveLength(0);
  });

  it('limits reset emails per account', async () => {
    const { service, sent } = accounts();
    await service.signup({ email: 'ana@empresa.com', name: 'Ana', password: 'contraseña-vieja' });
    for (let i = 0; i < 3; i++) await service.requestPasswordReset({ email: 'ana@empresa.com' }, `ip${i}`);
    await expect(service.requestPasswordReset({ email: 'ana@empresa.com' }, 'ip9')).rejects.toMatchObject({ status: 429 });
    expect(sent).toHaveLength(3);
  });

  it('parses sender addresses', () => {
    expect(parseAddress('Relayo Sim <no-reply@alimzen.com>')).toEqual({ name: 'Relayo Sim', address: 'no-reply@alimzen.com' });
    expect(parseAddress('"Relayo, Sim" <a@b.co>')).toEqual({ name: 'Relayo, Sim', address: 'a@b.co' });
    expect(parseAddress('a@b.co')).toEqual({ address: 'a@b.co' });
  });
});
