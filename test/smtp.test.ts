import {
  AuthenticationError,
  createRelayo,
  ProviderUnavailableError,
  RateLimitError,
  RejectedError,
  type EmailMessage,
  type RelayoEvent,
} from '@alimzen/core';
import { smtp } from '@alimzen/smtp';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SmtpSimServer } from '../src/smtp/smtp-sim.server.js';
import { memorySimulation, webhookReceiver } from './helpers.js';

let cleanup: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(cleanup.splice(0).map((fn) => fn()));
});

let ctx: Awaited<ReturnType<typeof setup>>;
beforeEach(async () => {
  ctx = await setup();
});

async function setup() {
  const { sim, scheduler, dispatcher, store } = memorySimulation(0);
  const hooks = await webhookReceiver();
  const { project, apiKey } = await sim.createProject('Tests', { webhookUrl: hooks.url });
  hooks.setSecret(project.webhookSecret);
  const server = new SmtpSimServer(sim, { port: 0, host: '127.0.0.1', maxHangMs: 300 });
  const port = await server.listen();
  cleanup.push(() => server.close(), () => hooks.close(), () => scheduler.stop(), () => dispatcher.stop());

  const driver = (pass = apiKey, extra: object = {}) =>
    smtp({ host: '127.0.0.1', port, secure: false, ignoreTLS: true, auth: { user: 'relayo', pass }, ...extra });
  const relayo = createRelayo({ email: driver(), generateId: () => 'msg_1' });
  return { sim, store, hooks, project, apiKey, driver, relayo, port };
}

const message = (to: string, extra: Partial<EmailMessage> = {}): EmailMessage => ({
  from: { address: 'facturas@empresa.com' },
  to: { address: to },
  subject: 'Tu factura',
  text: 'Hola',
  metadata: { facturaId: '123' },
  ...extra,
});

const typesFor = (events: RelayoEvent[], recipient: string) => events.filter((e) => e.recipient === recipient).map((e) => e.type);

describe('Relayo Sim over SMTP, driven by @alimzen/smtp', () => {
  it('delivers a normal message and reports it with Relayo\'s id and metadata', async () => {
    const result = await ctx.relayo.email.send(message('ana@sim.relayo.dev'));
    expect(result).toMatchObject({ messageId: 'msg_1', status: 'sent' });

    await vi.waitFor(() => expect(ctx.hooks.events).toHaveLength(2));
    expect(ctx.hooks.events).toEqual([
      expect.objectContaining({ type: 'accepted', messageId: 'msg_1', provider: 'simulator', metadata: { facturaId: '123' } }),
      expect.objectContaining({ type: 'delivered', recipient: 'ana@sim.relayo.dev' }),
    ]);
    expect(ctx.hooks.invalid).toEqual([]);
  });

  it('refuses unknown mailboxes at RCPT with 550 5.1.1, a RejectedError for the sender', async () => {
    const error = await ctx.relayo.email.send(message('hard-bounce@sim.relayo.dev')).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RejectedError);
    expect(error).toMatchObject({ raw: { responseCode: 550, enhancedCode: '5.1.1' } });
    await vi.waitFor(() => expect(ctx.hooks.events).toHaveLength(1));
    expect(ctx.hooks.events[0]).toMatchObject({ type: 'bounced', bounceType: 'hard', reason: 'user_unknown', smtpCode: 550 });
  });

  it.each([
    ['dmarc', 550, '5.7.26', 'auth_failure'],
    ['too-large', 552, '5.3.4', 'message_too_large'],
  ])('refuses %s after DATA (%i %s) as a block', async (scenario, code, enhanced, reason) => {
    const error = await ctx.relayo.email.send(message(`${scenario}@sim.relayo.dev`)).catch((e: unknown) => e);

    expect(error).toBeInstanceOf(RejectedError);
    expect(error).toMatchObject({ raw: { responseCode: code, enhancedCode: enhanced, command: 'DATA' } });
    await vi.waitFor(() => expect(ctx.hooks.events).toHaveLength(1));
    expect(ctx.hooks.events[0]).toMatchObject({ type: 'bounced', bounceType: 'block', reason, messageId: 'msg_1' });
  });

  it('greylists the first attempt; Relayo\'s retry gets it through on the second', async () => {
    const onRetry = vi.fn();
    const relayo = createRelayo({ email: ctx.driver(), retry: { attempts: 2, minDelayMs: 10, jitter: false, onRetry } });

    await expect(relayo.email.send(message('greylist@sim.relayo.dev'))).resolves.toMatchObject({ status: 'sent' });
    expect(onRetry).toHaveBeenCalledWith(expect.objectContaining({ error: expect.any(ProviderUnavailableError) }));
    expect(onRetry.mock.calls[0]![0].error).not.toBeInstanceOf(RateLimitError);
    await vi.waitFor(() => expect(typesFor(ctx.hooks.events, 'greylist@sim.relayo.dev')).toEqual(['deferred', 'accepted', 'delivered']));
  });

  it('answers over-quota mailboxes with a retryable 452 and throttles with 421', async () => {
    await expect(ctx.relayo.email.send(message('mailbox-full@sim.relayo.dev'))).rejects.toBeInstanceOf(ProviderUnavailableError);
    await expect(ctx.relayo.email.send(message('rate-limit@sim.relayo.dev'))).rejects.toBeInstanceOf(RateLimitError);
    await vi.waitFor(() => expect(ctx.hooks.events.map((e) => e.type)).toEqual(['deferred', 'deferred']));
  });

  it('applies a scenario chosen with the X-Sim-Scenario header, after DATA', async () => {
    const error = await ctx.relayo.email
      .send(message('ana@sim.relayo.dev', { headers: { 'X-Sim-Scenario': 'blocked' } }))
      .catch((e: unknown) => e);
    expect(error).toBeInstanceOf(RejectedError);
    expect(error).toMatchObject({ raw: { responseCode: 550, enhancedCode: '5.7.1', command: 'DATA' } });
  });

  it('keeps timeout scenarios waiting until the client gives up', async () => {
    const started = Date.now();
    const error = await ctx.relayo.email.send(message('timeout@sim.relayo.dev')).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(ProviderUnavailableError);
    expect(Date.now() - started).toBeGreaterThanOrEqual(250);
  });

  it('plays the whole timeline: delivered and then a spam complaint', async () => {
    await ctx.relayo.email.send(message('complaint@sim.relayo.dev'));
    await vi.waitFor(() => expect(ctx.hooks.events.map((e) => e.type)).toEqual(['accepted', 'delivered', 'complained']));
  });

  it('handles several recipients, each with its own scenario', async () => {
    const result = await ctx.relayo.email.send(
      message('ana@sim.relayo.dev', { to: [{ address: 'ana@sim.relayo.dev' }, { address: 'hard-bounce@sim.relayo.dev' }] }),
    );
    expect(result.rejectedRecipients).toEqual(['hard-bounce@sim.relayo.dev']);
    await vi.waitFor(() => expect(ctx.hooks.events).toHaveLength(3));
    expect(typesFor(ctx.hooks.events, 'hard-bounce@sim.relayo.dev')).toEqual(['bounced']);
    expect(typesFor(ctx.hooks.events, 'ana@sim.relayo.dev')).toEqual(['accepted', 'delivered']);
  });

  it('refuses wrong API keys', async () => {
    const relayo = createRelayo({ email: ctx.driver('sim_live_wrong') });
    await expect(relayo.email.send(message('ana@sim.relayo.dev'))).rejects.toBeInstanceOf(AuthenticationError);
  });

  it('keeps the timeline of each message in the store', async () => {
    await ctx.relayo.email.send(message('engaged@sim.relayo.dev'));
    await vi.waitFor(() => expect(ctx.hooks.events).toHaveLength(4));
    const [stored] = await ctx.store.listMessages(ctx.project.id, { limit: 10 });
    const full = await ctx.store.getMessage(ctx.project.id, stored!.id);
    expect(full).toMatchObject({ via: 'smtp', relayoMessageId: 'msg_1', subject: 'Tu factura' });
    expect(full!.events.map((e) => e.type)).toEqual(['accepted', 'delivered', 'opened', 'clicked']);
  });
});
