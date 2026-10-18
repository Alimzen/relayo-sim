import { describe, expect, it } from 'vitest';
import { parseDuration, SCENARIOS } from '../src/scenarios/catalog.js';
import { resolveScenario, selectScenario, smtpTimeline } from '../src/scenarios/resolve.js';

const resolve = (address: string, attempt = 1, header?: string) => resolveScenario(selectScenario(address, header), attempt);

describe('selectScenario', () => {
  it('reads the scenario from the address, with its parameter', () => {
    expect(selectScenario('Greylist+3@sim.relayo.dev')).toEqual({ name: 'greylist', param: '3', source: 'address' });
    expect(selectScenario('hard-bounce@sim.relayo.dev')).toEqual({ name: 'hard-bounce', source: 'address' });
  });

  it('lets the X-Sim-Scenario header override the address', () => {
    expect(selectScenario('ana@sim.relayo.dev', 'delay+30s')).toEqual({ name: 'delay', param: '30s', source: 'header' });
  });

  it('treats any other mailbox as a normal one that gets the mail', () => {
    expect(selectScenario('ana@sim.relayo.dev')).toEqual({ name: 'delivered', source: 'default' });
    expect(selectScenario('ana+hard-bounce@sim.relayo.dev')).toEqual({ name: 'delivered', source: 'default' });
    expect(selectScenario('ana@sim.relayo.dev', 'not-a-scenario')).toEqual({ name: 'delivered', source: 'default' });
  });
});

describe('scenario catalog', () => {
  it('has at least the 8–10 scenarios of the MVP, each with a description and an example', () => {
    expect(SCENARIOS.length).toBeGreaterThanOrEqual(10);
    for (const s of SCENARIOS) {
      expect(s.description.length).toBeGreaterThan(10);
      expect(selectScenario(s.example).name).toBe(s.name);
    }
  });

  it.each([
    ['hard-bounce', 550, '5.1.1', 'hard', 'user_unknown'],
    ['no-mx', 550, '5.1.2', 'hard', 'domain_invalid'],
    ['blocked', 550, '5.7.1', 'block', 'policy_block'],
    ['blocklisted', 554, '5.7.1', 'block', 'reputation_block'],
    ['dmarc', 550, '5.7.26', 'block', 'auth_failure'],
    ['too-large', 552, '5.3.4', 'block', 'message_too_large'],
  ])('%s refuses with %i %s and reports %s/%s', (name, code, enhanced, bounceType, reason) => {
    const outcome = resolve(`${name}@sim.relayo.dev`);
    expect(outcome.smtp).toMatchObject({ code, enhancedCode: enhanced });

    const bounce = outcome.timeline.find((s) => s.type === 'bounced');
    expect(bounce?.bounce).toMatchObject({ bounceType, reason, smtpCode: code, enhancedCode: enhanced });
    expect(smtpTimeline(outcome)).toEqual([{ ...bounce, after: 0 }]);
  });

  it('refuses after DATA when the problem is the content', () => {
    expect(resolve('dmarc@x').smtp).toMatchObject({ stage: 'data' });
    expect(resolve('too-large@x').smtp).toMatchObject({ stage: 'data' });
    expect(resolve('hard-bounce@x').smtp).toMatchObject({ stage: 'rcpt' });
  });

  it('greylists until the configured attempt', () => {
    expect(resolve('greylist+3@x', 1).smtp).toMatchObject({ code: 451, enhancedCode: '4.7.1' });
    expect(resolve('greylist+3@x', 2).smtp).toBeDefined();
    expect(resolve('greylist+3@x', 3).smtp).toBeUndefined();
    expect(resolve('greylist@x', 2).smtp).toBeUndefined();

    expect(smtpTimeline(resolve('greylist+3@x', 1))).toEqual([{ after: 0, type: 'deferred' }]);
    expect(smtpTimeline(resolve('greylist+3@x', 3)).map((s) => s.type)).toEqual(['accepted', 'delivered']);
    expect(resolve('greylist+3@x').timeline.map((s) => s.type)).toEqual(['accepted', 'deferred', 'deferred', 'delivered']);
  });

  it('defers temporary failures, ending in a soft bounce for API sends', () => {
    const full = resolve('mailbox-full@x');
    expect(full.timeline.map((s) => s.type)).toEqual(['accepted', 'deferred', 'deferred', 'bounced']);
    expect(full.timeline.at(-1)?.bounce).toMatchObject({ bounceType: 'soft', reason: 'mailbox_full' });
    expect(smtpTimeline(full)).toEqual([{ after: 0, type: 'deferred' }]);
  });

  it('delays delivery by the given duration', () => {
    expect(resolve('delay+30m@x').timeline.at(-1)).toEqual({ after: 30 * 60_000, type: 'delivered' });
    expect(resolve('delay+90s@x').timeline.at(-1)).toEqual({ after: 90_000, type: 'delivered' });
    expect(resolve('delay@x').timeline.at(-1)).toEqual({ after: 5 * 60_000, type: 'delivered' });
  });

  it('follows delivery with engagement, complaints and unsubscribes', () => {
    expect(resolve('engaged@x').timeline.map((s) => s.type)).toEqual(['accepted', 'delivered', 'opened', 'clicked']);
    expect(resolve('complaint@x').timeline.map((s) => s.type)).toEqual(['accepted', 'delivered', 'complained']);
    expect(resolve('unsubscribe@x').timeline.map((s) => s.type)).toEqual(['accepted', 'delivered', 'unsubscribed']);
  });

  it('rejects suppressed recipients without attempting delivery', () => {
    const outcome = resolve('suppressed@x');
    expect(outcome.timeline).toEqual([expect.objectContaining({ type: 'rejected', reject: expect.objectContaining({ reason: 'suppressed' }) })]);
    expect(smtpTimeline(outcome)).toEqual(outcome.timeline);
  });

  it('hangs SMTP sends that should time out, and soft-bounces API sends', () => {
    const outcome = resolve('timeout@x');
    expect(outcome.smtp).toBe('hang');
    expect(outcome.timeline.at(-1)?.bounce).toMatchObject({ bounceType: 'soft', reason: 'temporary_failure' });
  });

  it('keeps every timeline in chronological order', () => {
    for (const s of SCENARIOS) {
      const afters = resolve(s.example).timeline.map((t) => t.after);
      expect(afters).toEqual([...afters].sort((a, b) => a - b));
    }
  });
});

describe('parseDuration', () => {
  it.each([
    ['30s', 30_000],
    ['5m', 300_000],
    ['2h', 7_200_000],
    ['10', 600_000],
    ['soon', 1234],
    [undefined, 1234],
  ])('%s → %i ms', (value, ms) => {
    expect(parseDuration(value, 1234)).toBe(ms);
  });
});
