import { SCENARIOS_BY_NAME, type ScenarioOutcome, type TimelineStep } from './catalog.js';

export const SCENARIO_HEADER = 'x-sim-scenario';

export interface ScenarioSelection {
  /** Scenario name, `delivered` when nothing special was asked for. */
  name: string;
  param?: string;
  /** Where the choice came from. */
  /** `number` and `field` are for SMS: the magic number, or the request's `scenario` field. */
  source: 'address' | 'header' | 'default' | 'number' | 'field';
}

/**
 * Picks the scenario for a recipient: the `X-Sim-Scenario` header wins (`greylist+3`), then the local part
 * of the address (`greylist+3@sim.relayo.dev`). Anything else is a normal mailbox that gets the mail.
 */
export function selectScenario(recipient: string, headerValue?: string): ScenarioSelection {
  const fromHeader = parseSelector(headerValue);
  if (fromHeader) return { ...fromHeader, source: 'header' };
  const local = recipient.slice(0, recipient.lastIndexOf('@')).toLowerCase();
  const fromAddress = parseSelector(local);
  if (fromAddress) return { ...fromAddress, source: 'address' };
  return { name: 'delivered', source: 'default' };
}

function parseSelector(value: string | undefined): { name: string; param?: string } | undefined {
  if (!value) return undefined;
  const [name = '', ...rest] = value.trim().toLowerCase().split('+');
  if (!SCENARIOS_BY_NAME.has(name)) return undefined;
  const param = rest.join('+');
  return param ? { name, param } : { name };
}

export interface ResolvedScenario extends ScenarioOutcome {
  selection: ScenarioSelection;
}

export function resolveScenario(selection: ScenarioSelection, attempt = 1): ResolvedScenario {
  const definition = SCENARIOS_BY_NAME.get(selection.name) ?? SCENARIOS_BY_NAME.get('delivered')!;
  const outcome = definition.resolve({ attempt, ...(selection.param !== undefined && { param: selection.param }) });
  // `+async`: accept over SMTP and fail later, like a relay that bounces after taking the message.
  // The problem then comes back as a report (DSN) to the envelope sender, and as events.
  if (selection.param === 'async' && outcome.smtp !== undefined && outcome.smtp !== 'hang') {
    return { timeline: outcome.timeline, smtpTimeline: outcome.timeline, selection };
  }
  return { ...outcome, selection };
}

/**
 * Events for a message sent over SMTP. Accepted sends follow the scenario's timeline; refused ones get the
 * event the refusal means, right away (the sender already got the error).
 */
export function smtpTimeline(outcome: ScenarioOutcome): TimelineStep[] {
  if (outcome.smtp === undefined) return outcome.smtpTimeline ?? outcome.timeline;
  if (outcome.smtpTimeline) return outcome.smtpTimeline;
  if (outcome.smtp === 'hang') return [];
  const reply = outcome.smtp;
  const event = outcome.timeline.find((s) => s.type === 'bounced' || s.type === 'deferred' || s.type === 'rejected');
  if (reply.code >= 500) {
    const bounce = outcome.timeline.find((s) => s.type === 'bounced' && s.bounce?.smtpCode === reply.code);
    return bounce ? [{ ...bounce, after: 0 }] : event ? [{ ...event, after: 0 }] : [];
  }
  return [{ after: 0, type: 'deferred' }];
}
