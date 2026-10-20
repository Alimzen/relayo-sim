import { parseBounceEmail } from '@alimzen/relayo-bounces';
import { describe, expect, it } from 'vitest';
import type { SimEvent, SimMessage } from '../src/domain.js';
import { buildArf, buildDsn, buildReport, reportKind } from '../src/reports/reports.js';
import { resolveScenario, selectScenario } from '../src/scenarios/resolve.js';

const message: SimMessage = {
  id: 'sim_1',
  projectId: 'prj_1',
  via: 'smtp',
  relayoMessageId: '7b1f3c9e-6a4d-4c1e-9d2b-1f0e8a7c6b5d',
  from: 'facturas@empresa.com',
  envelopeFrom: 'bounces@empresa.com',
  recipients: [{ address: 'hard-bounce@sim.relayo.dev', scenario: { name: 'hard-bounce', source: 'address' } }],
  subject: 'Tu factura',
  metadata: { invoiceId: '123' },
  createdAt: new Date('2026-10-18T10:00:00Z'),
};

/** The event the simulator would emit for a scenario's step of the given type. */
function eventFor(address: string, type: SimEvent['type']): SimEvent {
  const outcome = resolveScenario(selectScenario(address));
  const index = outcome.timeline.findIndex((s) => s.type === type);
  const step = outcome.timeline[index]!;
  return {
    id: `sim_1:${address}:${String(index).padStart(3, '0')}`,
    type,
    channel: 'email',
    provider: 'simulator',
    messageId: message.relayoMessageId!,
    providerMessageId: 'sim_1',
    recipient: address,
    timestamp: new Date('2026-10-18T10:00:02Z'),
    raw: { step },
    projectId: 'prj_1',
    ...(step.bounce ?? {}),
  } as SimEvent;
}

describe('reports, read back with @alimzen/relayo-bounces', () => {
  it.each([
    ['hard-bounce@sim.relayo.dev', 'hard', 'user_unknown', '5.1.1'],
    ['blocklisted@sim.relayo.dev', 'block', 'reputation_block', '5.7.1'],
    ['dmarc@sim.relayo.dev', 'block', 'auth_failure', '5.7.26'],
    ['mailbox-full@sim.relayo.dev', 'soft', 'mailbox_full', '4.2.2'],
  ])('a DSN for %s reads as a %s bounce (%s)', (address, bounceType, reason, status) => {
    const raw = buildDsn(message, eventFor(address, 'bounced'));
    const { kind, events } = parseBounceEmail(raw);

    expect(kind).toBe('dsn');
    expect(events).toEqual([
      expect.objectContaining({
        type: 'bounced',
        recipient: address,
        bounceType,
        reason,
        enhancedCode: status,
        messageId: message.relayoMessageId,
        metadata: { invoiceId: '123' },
      }),
    ]);
  });

  it('a delay notice reads as a deferral', () => {
    const raw = buildDsn(message, eventFor('mailbox-full@sim.relayo.dev', 'deferred'));
    expect(raw).toContain('Action: delayed');
    expect(raw).toContain('Status: 4.2.2');
    expect(parseBounceEmail(raw).events).toEqual([expect.objectContaining({ type: 'deferred', messageId: message.relayoMessageId })]);
  });

  it('a complaint comes back as an ARF report', () => {
    const raw = buildArf(message, eventFor('complaint@sim.relayo.dev', 'complained'));
    const { kind, events } = parseBounceEmail(raw);
    expect(kind).toBe('arf');
    expect(events).toEqual([
      expect.objectContaining({ type: 'complained', recipient: 'complaint@sim.relayo.dev', messageId: message.relayoMessageId }),
    ]);
  });

  it('is addressed to the envelope sender, with CRLF line endings, as reports are on the wire', () => {
    const raw = buildDsn(message, eventFor('hard-bounce@sim.relayo.dev', 'bounced'));
    expect(raw).toMatch(/^From: Mail Delivery System <MAILER-DAEMON@sim\.relayo\.dev>\r\n/);
    expect(raw).toContain('To: <bounces@empresa.com>\r\n');
    expect(raw.replace(/\r\n/g, '')).not.toContain('\n');
  });

  it('quotes Relayo-style headers for API sends that have no headers of their own', () => {
    const { envelopeFrom: _envelopeFrom, ...rest } = message;
    const api: SimMessage = { ...rest, via: 'api' };
    const raw = buildDsn(api, eventFor('hard-bounce@sim.relayo.dev', 'bounced'));
    expect(raw).toContain('To: <facturas@empresa.com>');
    expect(raw).toContain(`X-Relayo-Message-ID: ${message.relayoMessageId}`);
    expect(parseBounceEmail(raw).events[0]).toMatchObject({ messageId: message.relayoMessageId, metadata: { invoiceId: '123' } });
  });

  it('only builds reports for bounces, deferrals and complaints', () => {
    expect(reportKind({ type: 'delivered' })).toBeUndefined();
    expect(buildReport(message, eventFor('engaged@sim.relayo.dev', 'opened'))).toBeUndefined();
  });

  it('accepts +async for scenarios that refuse over SMTP', () => {
    const outcome = resolveScenario(selectScenario('hard-bounce+async@sim.relayo.dev'));
    expect(outcome.smtp).toBeUndefined();
    expect(outcome.smtpTimeline?.map((s) => s.type)).toEqual(['accepted', 'bounced']);
  });
});
