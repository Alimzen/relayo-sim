import { classifyBounce, type BounceReason, type BounceType, type EventType, type RejectReason } from '@alimzen/core';

/** How the simulated receiving server answers over SMTP. */
export interface SmtpReply {
  /** SMTP command the reply is given to. */
  stage: 'rcpt' | 'data';
  code: number;
  enhancedCode: string;
  text: string;
}

/** One event in a message's simulated life, `after` milliseconds from when it was sent. */
export interface TimelineStep {
  after: number;
  type: EventType;
  bounce?: { bounceType: BounceType; reason: BounceReason; smtpCode: number; enhancedCode: string; diagnostic: string };
  /** For deferrals: the temporary SMTP answer behind them. */
  smtp?: { code: number; enhancedCode: string; diagnostic: string };
  reject?: { reason: RejectReason; diagnostic: string };
  url?: string;
}

export interface ScenarioInput {
  /** Text after `+` in the address, e.g. `3` in `greylist+3@`. */
  param?: string;
  /** SMTP delivery attempt for this sender and recipient, starting at 1. */
  attempt: number;
}

/**
 * What a scenario does. SMTP sends get `smtp` as the live answer (accepted when undefined) and, once
 * accepted, the `timeline`. API sends, like a provider's HTTP API, are always accepted and get the
 * `timeline` only: problems the SMTP path rejects on the spot arrive as later events instead.
 */
export interface ScenarioOutcome {
  smtp?: SmtpReply | 'hang';
  /** Events for SMTP sends. Defaults to `timeline`; rejected SMTP sends get the matching event at 0. */
  smtpTimeline?: TimelineStep[];
  timeline: TimelineStep[];
}

export interface ScenarioDefinition {
  name: string;
  description: string;
  /** Example address, for docs and the panel. */
  example: string;
  resolve(input: ScenarioInput): ScenarioOutcome;
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;

const accepted: TimelineStep = { after: 0, type: 'accepted' };
const delivered = (after = 1 * SECOND): TimelineStep => ({ after, type: 'delivered' });

/** A refusal: the live SMTP answer, and the bounce event the same answer produces. */
function refusal(stage: SmtpReply['stage'], code: number, enhancedCode: string, text: string) {
  const reply: SmtpReply = { stage, code, enhancedCode, text };
  const diagnostic = `${code} ${enhancedCode} ${text}`;
  // Classified with Relayo's own rules, so the simulator agrees with what the drivers would report.
  const { bounceType, reason } = classifyBounce({ smtpCode: code, enhancedCode, diagnostic });
  const bounce = (after: number): TimelineStep => ({
    after,
    type: 'bounced',
    bounce: { bounceType, reason, smtpCode: code, enhancedCode, diagnostic },
  });
  const deferred = (after: number): TimelineStep => ({ after, type: 'deferred', smtp: { code, enhancedCode, diagnostic } });
  return { reply, bounce, deferred, diagnostic };
}

/** Parses `30s`, `5m`, `2h`; defaults to minutes for bare numbers. */
export function parseDuration(value: string | undefined, fallback: number): number {
  const match = /^(\d+)(s|m|h)?$/.exec(value ?? '');
  if (!match) return fallback;
  const amount = Number(match[1]);
  const unit = match[2] ?? 'm';
  return amount * (unit === 's' ? SECOND : unit === 'h' ? 60 * MINUTE : MINUTE);
}

const hardBounce = refusal('rcpt', 550, '5.1.1', 'The email account that you tried to reach does not exist');
const noMx = refusal('rcpt', 550, '5.1.2', 'Host or domain name not found. Name service error for domain');
const mailboxFull = refusal('rcpt', 452, '4.2.2', 'The email account that you tried to reach is over quota');
const greylisted = refusal('rcpt', 451, '4.7.1', 'Greylisted, please try again later');
const blocked = refusal('rcpt', 550, '5.7.1', 'Message rejected due to local policy');
const blocklisted = refusal('rcpt', 554, '5.7.1', 'Service unavailable; Client host blocked using zen.spamhaus.org');
const dmarc = refusal('data', 550, '5.7.26', 'Unauthenticated email is not accepted due to DMARC policy');
const tooLarge = refusal('data', 552, '5.3.4', 'Message size exceeds fixed maximum message size');
const rateLimited = refusal('rcpt', 421, '4.7.28', 'Too many messages from your IP, try again later');
const timedOut = refusal('data', 451, '4.4.1', 'Connection timed out');

export const SCENARIOS: readonly ScenarioDefinition[] = [
  {
    name: 'delivered',
    description: 'Accepted and delivered. Any address that is not a scenario behaves like this.',
    example: 'ana@sim.relayo.dev',
    resolve: () => ({ timeline: [accepted, delivered()] }),
  },
  {
    name: 'hard-bounce',
    description: 'The mailbox does not exist: 550 5.1.1.',
    example: 'hard-bounce@sim.relayo.dev',
    resolve: () => ({ smtp: hardBounce.reply, timeline: [accepted, hardBounce.bounce(2 * SECOND)] }),
  },
  {
    name: 'no-mx',
    description: 'The domain cannot receive mail: 550 5.1.2.',
    example: 'no-mx@sim.relayo.dev',
    resolve: () => ({ smtp: noMx.reply, timeline: [accepted, noMx.bounce(2 * SECOND)] }),
  },
  {
    name: 'mailbox-full',
    description: 'Over quota: 452 4.2.2 on every attempt. API sends are deferred twice and then soft-bounce.',
    example: 'mailbox-full@sim.relayo.dev',
    resolve: () => ({
      smtp: mailboxFull.reply,
      timeline: [accepted, mailboxFull.deferred(1 * SECOND), mailboxFull.deferred(3 * SECOND), mailboxFull.bounce(5 * SECOND)],
    }),
  },
  {
    name: 'greylist',
    description: 'Greylisting: 451 4.7.1 until attempt N (default 2), then accepted. `greylist+3@` accepts the third.',
    example: 'greylist+3@sim.relayo.dev',
    resolve: ({ param, attempt }) => {
      const acceptOn = Math.max(1, Number(param) || 2);
      const deferrals = Array.from({ length: acceptOn - 1 }, (_, i) => greylisted.deferred((i + 1) * SECOND));
      const timeline = [accepted, ...deferrals, delivered(acceptOn * SECOND)];
      // Refused attempts get a deferral (the default); the accepted one is delivered right away.
      return attempt < acceptOn
        ? { smtp: greylisted.reply, timeline }
        : { smtpTimeline: [accepted, delivered()], timeline };
    },
  },
  {
    name: 'blocked',
    description: 'Refused by the receiver\'s policy: 550 5.7.1. A block, not a bad address.',
    example: 'blocked@sim.relayo.dev',
    resolve: () => ({ smtp: blocked.reply, timeline: [accepted, blocked.bounce(2 * SECOND)] }),
  },
  {
    name: 'blocklisted',
    description: 'Your sending IP is on a blocklist: 554 5.7.1 ... zen.spamhaus.org.',
    example: 'blocklisted@sim.relayo.dev',
    resolve: () => ({ smtp: blocklisted.reply, timeline: [accepted, blocklisted.bounce(2 * SECOND)] }),
  },
  {
    name: 'dmarc',
    description: 'SPF/DKIM/DMARC failure after DATA: 550 5.7.26.',
    example: 'dmarc@sim.relayo.dev',
    resolve: () => ({ smtp: dmarc.reply, timeline: [accepted, dmarc.bounce(2 * SECOND)] }),
  },
  {
    name: 'too-large',
    description: 'Message too large, after DATA: 552 5.3.4.',
    example: 'too-large@sim.relayo.dev',
    resolve: () => ({ smtp: tooLarge.reply, timeline: [accepted, tooLarge.bounce(2 * SECOND)] }),
  },
  {
    name: 'rate-limit',
    description: 'The receiver throttles you: 421 4.7.28. API sends are deferred and then delivered.',
    example: 'rate-limit@sim.relayo.dev',
    resolve: () => ({
      smtp: rateLimited.reply,
      timeline: [accepted, rateLimited.deferred(1 * SECOND), delivered(10 * SECOND)],
    }),
  },
  {
    name: 'timeout',
    description: 'The receiver never answers DATA, so the SMTP client times out. API sends soft-bounce.',
    example: 'timeout@sim.relayo.dev',
    resolve: () => ({
      smtp: 'hang',
      timeline: [accepted, timedOut.deferred(5 * SECOND), timedOut.bounce(30 * SECOND)],
    }),
  },
  {
    name: 'delay',
    description: 'Delivered late: `delay+30m@` (s, m or h; default 5m), deferred in between.',
    example: 'delay+30m@sim.relayo.dev',
    resolve: ({ param }) => {
      const delay = parseDuration(param, 5 * MINUTE);
      return { timeline: [accepted, { after: Math.min(1 * SECOND, delay), type: 'deferred' }, delivered(delay)] };
    },
  },
  {
    name: 'complaint',
    description: 'Delivered, then marked as spam.',
    example: 'complaint@sim.relayo.dev',
    resolve: () => ({ timeline: [accepted, delivered(), { after: 5 * SECOND, type: 'complained' }] }),
  },
  {
    name: 'unsubscribe',
    description: 'Delivered, then the recipient unsubscribes.',
    example: 'unsubscribe@sim.relayo.dev',
    resolve: () => ({ timeline: [accepted, delivered(), { after: 5 * SECOND, type: 'unsubscribed' }] }),
  },
  {
    name: 'engaged',
    description: 'Delivered, opened and clicked.',
    example: 'engaged@sim.relayo.dev',
    resolve: () => ({
      timeline: [
        accepted,
        delivered(),
        { after: 3 * SECOND, type: 'opened' },
        { after: 4 * SECOND, type: 'clicked', url: 'https://example.com/' },
      ],
    }),
  },
  {
    name: 'suppressed',
    description: 'On the suppression list: never attempted.',
    example: 'suppressed@sim.relayo.dev',
    resolve: () => {
      const reject: TimelineStep = {
        after: 0,
        type: 'rejected',
        reject: { reason: 'suppressed', diagnostic: 'Recipient is on the suppression list' },
      };
      return {
        smtp: { stage: 'rcpt', code: 550, enhancedCode: '5.7.1', text: 'Recipient is on the suppression list' },
        smtpTimeline: [reject],
        timeline: [reject],
      };
    },
  },
];

export const SCENARIOS_BY_NAME: ReadonlyMap<string, ScenarioDefinition> = new Map(SCENARIOS.map((s) => [s.name, s]));
