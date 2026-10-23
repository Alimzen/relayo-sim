import type { BounceReason, BounceType } from '@alimzen/relayo';
import type { TimelineStep } from './catalog.js';
import type { ScenarioSelection } from './resolve.js';

/**
 * SMS scenarios, picked by the destination number. The numbers sit in 555-0100–0199, the range reserved
 * for fiction in North America, so a test can never text a real phone.
 */
export interface SmsScenarioDefinition {
  name: string;
  /** The magic number that selects it (E.164). */
  number: string;
  description: string;
  timeline(): TimelineStep[];
}

const SECOND = 1000;
const accepted: TimelineStep = { after: 0, type: 'accepted' };
const delivered = (after = 2 * SECOND): TimelineStep => ({ after, type: 'delivered' });

/** A carrier failure, with the carrier's error code in the diagnostic, as SMS providers report it. */
function failure(after: number, bounceType: BounceType, reason: BounceReason, code: number, text: string): TimelineStep {
  return { after, type: 'bounced', bounce: { bounceType, reason, diagnostic: `${text} (carrier error ${code})` } };
}

const deferred = (after: number, diagnostic: string): TimelineStep => ({ after, type: 'deferred', smtp: { code: 0, enhancedCode: '', diagnostic } });

export const SMS_SCENARIOS: readonly SmsScenarioDefinition[] = [
  {
    name: 'delivered',
    number: '+12015550100',
    description: 'Delivered to the handset. Any number that is not a scenario behaves like this.',
    timeline: () => [accepted, delivered()],
  },
  {
    name: 'invalid-number',
    number: '+12015550101',
    description: 'The number does not exist: a hard bounce, stop texting it.',
    timeline: () => [accepted, failure(2 * SECOND, 'hard', 'user_unknown', 30005, 'Unknown destination handset')],
  },
  {
    name: 'landline',
    number: '+12015550102',
    description: 'A landline, which cannot receive SMS: a hard bounce.',
    timeline: () => [accepted, failure(2 * SECOND, 'hard', 'unknown', 30006, 'Landline or unreachable carrier')],
  },
  {
    name: 'unreachable',
    number: '+12015550103',
    description: 'The phone is off or out of coverage: deferred twice, then a soft bounce.',
    timeline: () => [
      accepted,
      deferred(1 * SECOND, 'Destination handset unreachable, retrying'),
      deferred(4 * SECOND, 'Destination handset unreachable, retrying'),
      failure(8 * SECOND, 'soft', 'temporary_failure', 30003, 'Unreachable destination handset'),
    ],
  },
  {
    name: 'carrier-filtered',
    number: '+12015550104',
    description: 'The carrier filters the message as spam: a block, check your content and sender.',
    timeline: () => [accepted, failure(2 * SECOND, 'block', 'content_rejected', 30007, 'Message filtered by the carrier')],
  },
  {
    name: 'opt-out',
    number: '+12015550105',
    description: 'Delivered, then the recipient replies STOP: an unsubscribe.',
    timeline: () => [accepted, delivered(), { after: 6 * SECOND, type: 'unsubscribed' }],
  },
  {
    name: 'suppressed',
    number: '+12015550106',
    description: 'The recipient replied STOP before: rejected, never sent.',
    timeline: () => [
      { after: 0, type: 'rejected', reject: { reason: 'suppressed', diagnostic: 'The recipient has opted out (STOP) of messages from this sender' } },
    ],
  },
  {
    name: 'delay',
    number: '+12015550107',
    description: 'Delivered late, after 30 seconds, deferred in between.',
    timeline: () => [accepted, deferred(1 * SECOND, 'Queued at the carrier'), delivered(30 * SECOND)],
  },
];

const BY_NAME = new Map(SMS_SCENARIOS.map((s) => [s.name, s]));
const BY_NUMBER = new Map(SMS_SCENARIOS.map((s) => [s.number, s]));

/** E.164: `+` and 8 to 15 digits. */
/** E.164, or `whatsapp:` + E.164 for WhatsApp. */
export const PHONE = /^(whatsapp:)?\+[1-9]\d{7,14}$/;
export const WHATSAPP = 'whatsapp:';

/** The `scenario` field of the request wins; then the magic number; anything else is delivered. */
export function selectSmsScenario(to: string, requested?: string): ScenarioSelection {
  const name = requested?.trim().toLowerCase();
  if (name && BY_NAME.has(name)) return { name, source: 'field' };
  // WhatsApp numbers play the same scenarios as SMS ones.
  const byNumber = BY_NUMBER.get(to.startsWith(WHATSAPP) ? to.slice(WHATSAPP.length) : to);
  if (byNumber && byNumber.name !== 'delivered') return { name: byNumber.name, source: 'number' };
  return { name: 'delivered', source: 'default' };
}

export function smsTimeline(selection: ScenarioSelection): TimelineStep[] {
  return (BY_NAME.get(selection.name) ?? BY_NAME.get('delivered')!).timeline();
}

export const isSmsScenario = (name: string) => BY_NAME.has(name);
