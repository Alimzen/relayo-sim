import { describe, expect, it } from 'vitest';
import { AccountsService } from '../src/accounts/accounts.service.js';
import type { MailToSend } from '../src/accounts/mailer.js';
import { LiveError, LiveService } from '../src/live/live.service.js';
import { SecretBox } from '../src/live/secrets.js';
import { MemoryScheduler } from '../src/scheduler/scheduler.js';
import { SimulationService } from '../src/simulation/simulation.service.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { MemoryDispatcher } from '../src/webhooks/webhooks.js';

function setup(requireVerification = true) {
  const store = new MemoryStore();
  const sim = new SimulationService(store, new MemoryScheduler(), new MemoryDispatcher(), { timeScale: 0 });
  const sent: MailToSend[] = [];
  const accounts = new AccountsService(store, sim, {
    publicUrl: 'https://relayo.alimzen.com',
    mailer: { send: async (mail) => void sent.push(mail) },
    requireVerification,
    adminEmails: ['ana@empresa.com'],
  });
  const live = new LiveService(store, new MemoryDispatcher(), new SecretBox('k'));
  return { store, accounts, live, sent };
}

const tokenOf = (mail: MailToSend) => /verify-email\?token=([\w-]+)/.exec(mail.text)![1]!;

describe('email verification', () => {
  it('emails a link at sign-up; live mode waits for it', async () => {
    const { accounts, live, sent, store } = setup();
    const { user, project } = await accounts.signup({ email: 'Ana@empresa.com', name: 'Ana', password: 'una-clave-larga' });

    expect(accounts.present(user)).toMatchObject({ emailVerified: false, admin: false });
    expect(sent).toHaveLength(1);
    expect(sent[0]!.text).toContain('https://relayo.alimzen.com/verify-email?token=');
    const error = await live.assertCanGoLive(project).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(LiveError);
    expect(error).toMatchObject({ status: 403 });

    const verified = await accounts.verifyEmail({ token: tokenOf(sent[0]!) });
    expect(accounts.present(verified)).toMatchObject({ emailVerified: true, admin: true });
    await expect(live.assertCanGoLive(project)).resolves.toBeUndefined();
    // Single use, and only for verification: not a password reset token.
    await expect(accounts.verifyEmail({ token: tokenOf(sent[0]!) })).rejects.toMatchObject({ status: 400 });
    await expect(accounts.resetPassword({ token: tokenOf(sent[0]!), password: 'otra-clave-larga' })).rejects.toMatchObject({ status: 400 });
    expect((await store.getUser(user.id))!.emailVerifiedAt).toBeInstanceOf(Date);
  });

  it('resends the link a few times an hour, and not to verified accounts', async () => {
    const { accounts, sent } = setup();
    const { user } = await accounts.signup({ email: 'luis@empresa.com', name: 'Luis', password: 'una-clave-larga' });
    await accounts.sendVerification(user);
    await accounts.sendVerification(user);
    await expect(accounts.sendVerification(user)).rejects.toMatchObject({ status: 429 });
    expect(sent).toHaveLength(3);

    const verified = await accounts.verifyEmail({ token: tokenOf(sent[2]!) });
    await accounts.sendVerification(verified);
    expect(sent).toHaveLength(3);
  });

  it('tells the owner the answer to their request for Relayo\'s own sending', async () => {
    const { accounts, sent } = setup(false);
    const { user, project } = await accounts.signup({ email: 'eva@empresa.com', name: 'Eva', password: 'una-clave-larga' });
    await accounts.notifyManagedDecision(user, project, 'approved');
    await accounts.notifyManagedDecision(user, project, 'denied');
    expect(sent.map((m) => [m.to, m.subject])).toEqual([
      ['eva@empresa.com', 'Envío de Relayo aprobado'],
      ['eva@empresa.com', 'Tu solicitud del envío de Relayo'],
    ]);
    expect(sent[0]!.text).toContain('https://relayo.alimzen.com/domains');
  });

  it('starts accounts verified when the platform cannot send email', async () => {
    const { accounts, sent } = setup(false);
    const { user } = await accounts.signup({ email: 'eva@empresa.com', name: 'Eva', password: 'una-clave-larga' });
    expect(accounts.present(user).emailVerified).toBe(true);
    expect(sent).toHaveLength(0);
  });
});
