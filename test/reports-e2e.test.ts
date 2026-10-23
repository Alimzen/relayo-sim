import type { AddressInfo } from 'node:net';
import { parseBounceEmail } from '@alimzen/relayo-bounces';
import { createRelayo } from '@alimzen/relayo';
import { smtp } from '@alimzen/relayo-smtp';
import { SMTPServer } from 'smtp-server';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { SmtpReportSender } from '../src/reports/sender.js';
import { SmtpSimServer } from '../src/smtp/smtp-sim.server.js';
import { memorySimulation } from './helpers.js';

const cleanup: Array<() => Promise<void> | void> = [];
afterEach(async () => {
  for (const fn of cleanup.splice(0).reverse()) await fn();
});

/** The user's bounce mailbox: an SMTP server that keeps what it receives. */
async function bounceMailbox() {
  const received: Array<{ mailFrom: string | false; to: string[]; raw: string }> = [];
  const server = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS'],
    logger: false,
    onData(stream, session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        received.push({
          mailFrom: session.envelope.mailFrom && session.envelope.mailFrom.address,
          to: session.envelope.rcptTo.map((r) => r.address),
          raw: Buffer.concat(chunks).toString('utf8'),
        });
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanup.push(() => new Promise<void>((resolve) => server.close(() => resolve())));
  return { url: `smtp://127.0.0.1:${(server.server.address() as AddressInfo).port}`, received };
}

async function setup() {
  const mailbox = await bounceMailbox();
  const reports = new SmtpReportSender();
  const { sim, store, scheduler, dispatcher } = memorySimulation(0, reports);
  const { project, apiKey } = await sim.createProject('Reports');
  await store.updateProject(project.id, { reportsSmtpUrl: mailbox.url });
  const server = new SmtpSimServer(sim, { port: 0, host: '127.0.0.1' });
  const port = await server.listen();
  cleanup.push(() => reports.close(), () => scheduler.stop(), () => dispatcher.stop(), () => server.close());
  return { sim, mailbox, project: (await store.getProject(project.id))!, apiKey, port };
}

describe('bounce and complaint reports by email', () => {
  it('accepts hard-bounce+async over SMTP and later mails a DSN that @alimzen/relayo-bounces reads back', async () => {
    const { mailbox, apiKey, port } = await setup();
    const driver = smtp(
      { host: '127.0.0.1', port, secure: false, ignoreTLS: true, auth: { user: 'app', pass: apiKey } },
      { bounceAddress: 'bounces@empresa.com' },
    );
    cleanup.push(() => driver.close());
    const relayo = createRelayo({ email: driver });

    const sent = await relayo.email.send({
      from: { address: 'facturas@empresa.com' },
      to: { address: 'hard-bounce+async@sim.relayo.dev' },
      subject: 'Tu factura',
      text: 'Hola',
      metadata: { invoiceId: '123' },
    });
    expect(sent.status).toBe('sent'); // accepted: the bounce comes later

    await vi.waitFor(() => expect(mailbox.received).toHaveLength(1), { timeout: 10_000 });
    const [dsn] = mailbox.received;
    expect(dsn).toMatchObject({ mailFrom: '', to: ['bounces@empresa.com'] }); // null reverse path, envelope sender

    const { kind, events } = parseBounceEmail(dsn!.raw);
    expect(kind).toBe('dsn');
    expect(events).toEqual([
      expect.objectContaining({
        type: 'bounced',
        recipient: 'hard-bounce+async@sim.relayo.dev',
        bounceType: 'hard',
        reason: 'user_unknown',
        messageId: sent.messageId,
        metadata: { invoiceId: '123' },
      }),
    ]);
  });

  it('mails delay notices and the final bounce for an over-quota mailbox', async () => {
    const { sim, mailbox, project } = await setup();
    await sim.acceptFromApi(project, { from: 'facturas@empresa.com', to: ['mailbox-full@sim.relayo.dev'], subject: 's', relayoMessageId: 'msg_q' });

    await vi.waitFor(() => expect(mailbox.received).toHaveLength(3), { timeout: 10_000 });
    const kinds = mailbox.received.map((r) => parseBounceEmail(r.raw).events[0]?.type).sort();
    expect(kinds).toEqual(['bounced', 'deferred', 'deferred']);
    expect(mailbox.received.every((r) => r.to[0] === 'facturas@empresa.com')).toBe(true);
  });

  it('mails an ARF report for complaints', async () => {
    const { sim, mailbox, project } = await setup();
    await sim.acceptFromApi(project, { from: 'news@empresa.com', to: ['complaint@sim.relayo.dev'], subject: 's', relayoMessageId: 'msg_c' });

    await vi.waitFor(() => expect(mailbox.received).toHaveLength(1), { timeout: 10_000 });
    const { kind, events } = parseBounceEmail(mailbox.received[0]!.raw);
    expect(kind).toBe('arf');
    expect(events[0]).toMatchObject({ type: 'complained', messageId: 'msg_c', recipient: 'complaint@sim.relayo.dev' });
  });

  it('sends nothing for deliveries, and nothing when the project has no reports SMTP server', async () => {
    const { sim, mailbox, project } = await setup();
    await sim.acceptFromApi(project, { from: 'a@empresa.com', to: ['engaged@sim.relayo.dev'], subject: 's' });
    const { project: other } = await sim.createProject('No reports');
    await sim.acceptFromApi(other, { from: 'a@empresa.com', to: ['hard-bounce@sim.relayo.dev'], subject: 's' });

    await new Promise((r) => setTimeout(r, 300));
    expect(mailbox.received).toEqual([]);
  });

  it('rebuilds any event\'s report on demand', async () => {
    const { sim, project } = await setup();
    const message = await sim.acceptFromApi(project, { from: 'a@empresa.com', to: ['blocked@sim.relayo.dev'], subject: 's', relayoMessageId: 'msg_r' });
    const eventId = `${message.id}:blocked@sim.relayo.dev:001`;

    await vi.waitFor(async () => expect(await sim.report(project, eventId)).toBeDefined(), { timeout: 10_000 });
    const report = (await sim.report(project, eventId))!;
    expect(parseBounceEmail(report).events[0]).toMatchObject({ bounceType: 'block', reason: 'policy_block', messageId: 'msg_r' });
    expect(await sim.report(project, `${message.id}:blocked@sim.relayo.dev:000`)).toBeUndefined(); // "accepted": no report
  });
});
