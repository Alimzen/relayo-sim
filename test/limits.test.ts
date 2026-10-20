import { smtp } from '@alimzen/relayo-smtp';
import { createRelayo, RateLimitError, ProviderUnavailableError, isRelayoError } from '@alimzen/relayo';
import { afterEach, describe, expect, it } from 'vitest';
import { SmtpSimServer } from '../src/smtp/smtp-sim.server.js';
import { MemoryScheduler } from '../src/scheduler/scheduler.js';
import { QuotaExceededError, SimulationService, usageMonth } from '../src/simulation/simulation.service.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { MemoryDispatcher } from '../src/webhooks/webhooks.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0)) await fn();
});

function simulation(limits: { monthlyMessages?: number; messagesPerMinute?: number }) {
  const store = new MemoryStore();
  const scheduler = new MemoryScheduler();
  const dispatcher = new MemoryDispatcher();
  const sim = new SimulationService(store, scheduler, dispatcher, { timeScale: 0, limits });
  cleanup.push(() => scheduler.stop(), () => dispatcher.stop());
  return { store, sim };
}

describe('plan limits', () => {
  it('counts every message and stops at the monthly limit', async () => {
    const { sim } = simulation({ monthlyMessages: 2 });
    const { project } = await sim.createProject('P');
    await sim.reserve(project);
    await sim.reserve(project);
    await expect(sim.reserve(project)).rejects.toMatchObject({ kind: 'monthly', limit: 2 });
    expect(await sim.usage(project)).toEqual({ month: usageMonth(), messages: 2, limits: { monthlyMessages: 2, messagesPerMinute: 0 } });
  });

  it('limits messages per minute, per project', async () => {
    const { sim } = simulation({ messagesPerMinute: 1 });
    const { project: a } = await sim.createProject('A');
    const { project: b } = await sim.createProject('B');
    await sim.reserve(a);
    await expect(sim.reserve(a)).rejects.toBeInstanceOf(QuotaExceededError);
    await sim.reserve(b);
  });

  it('has no limits by default', async () => {
    const { sim } = simulation({});
    const { project } = await sim.createProject('P');
    for (let i = 0; i < 50; i++) await sim.reserve(project);
  });

  it('answers over SMTP: 421 when too fast (rate limit), 452 when the month is used up', async () => {
    const { sim } = simulation({ messagesPerMinute: 1 });
    const { apiKey } = await sim.createProject('P');
    const server = new SmtpSimServer(sim, { port: 0, host: '127.0.0.1' });
    const port = await server.listen();
    cleanup.push(() => server.close());
    const relayo = createRelayo({ email: smtp({ host: '127.0.0.1', port, secure: false, ignoreTLS: true, auth: { user: 'x', pass: apiKey } }) });
    const message = { from: { address: 'a@empresa.com' }, to: { address: 'ana@sim.relayo.dev' }, subject: 's', text: 't' };

    await relayo.email.send(message);
    const error = await relayo.email.send(message).catch((e: unknown) => e);
    expect(isRelayoError(error) && error.retryable).toBe(true);
    expect(error).toBeInstanceOf(RateLimitError);

    const monthly = simulation({ monthlyMessages: 1 });
    const second = await monthly.sim.createProject('Q');
    const server2 = new SmtpSimServer(monthly.sim, { port: 0, host: '127.0.0.1' });
    const port2 = await server2.listen();
    cleanup.push(() => server2.close());
    const relayo2 = createRelayo({
      email: smtp({ host: '127.0.0.1', port: port2, secure: false, ignoreTLS: true, auth: { user: 'x', pass: second.apiKey } }),
    });
    await relayo2.email.send(message);
    const full = await relayo2.email.send(message).catch((e: unknown) => e);
    expect(full).toBeInstanceOf(ProviderUnavailableError);
    expect(String((full as Error).message)).toContain('Monthly limit');
  });
});
