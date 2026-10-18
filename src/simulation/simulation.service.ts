import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BounceEvent, ClickEvent, RejectEvent, RelayoEvent } from '@alimzen/core';
import type { Project, SimEvent, SimMessage, SimRecipient } from '../domain.js';
import type { SmtpReply, TimelineStep } from '../scenarios/catalog.js';
import { resolveScenario, selectScenario, smtpTimeline, type ResolvedScenario } from '../scenarios/resolve.js';
import type { EventScheduler, ScheduledStep } from '../scheduler/scheduler.js';
import type { SimStore } from '../store/store.js';
import type { WebhookDispatcher } from '../webhooks/webhooks.js';

export interface SimulationOptions {
  /** Multiplies every timeline delay. `0` fires everything at once (CI); `1` is real time. Default 1. */
  timeScale?: number;
  /** How long greylisting remembers an attempt. Default 1 hour. */
  greylistTtlMs?: number;
}

export interface IncomingMessage {
  from: string;
  to: string[];
  subject: string;
  relayoMessageId?: string;
  metadata?: Record<string, string>;
  tags?: string[];
  /** Value of `X-Sim-Scenario`, applied to every recipient. */
  scenarioHeader?: string;
}

/** Ties scenarios, storage, scheduling and webhooks together. */
export class SimulationService {
  private readonly timeScale: number;
  private readonly greylistTtlMs: number;

  constructor(
    private readonly store: SimStore,
    private readonly scheduler: EventScheduler,
    private readonly webhooks: WebhookDispatcher,
    options: SimulationOptions = {},
  ) {
    this.timeScale = options.timeScale ?? 1;
    this.greylistTtlMs = options.greylistTtlMs ?? 60 * 60_000;
    scheduler.start((job) => this.runStep(job));
  }

  // --- Projects ---------------------------------------------------------------------------------

  /** Creates a project. The API key is returned only here; only its hash is stored. */
  async createProject(name: string, webhookUrl?: string): Promise<{ project: Project; apiKey: string }> {
    const apiKey = `sim_live_${randomBytes(24).toString('base64url')}`;
    const project: Project = {
      id: `prj_${randomUUID()}`,
      name,
      apiKeyHash: hashKey(apiKey),
      webhookSecret: `whsec_${randomBytes(24).toString('base64url')}`,
      createdAt: new Date(),
      ...(webhookUrl && { webhookUrl }),
    };
    await this.store.createProject(project);
    return { project, apiKey };
  }

  authenticate(apiKey: string): Promise<Project | undefined> {
    return this.store.findProjectByApiKeyHash(hashKey(apiKey));
  }

  // --- Sending ----------------------------------------------------------------------------------

  /** HTTP API send: always accepted, like a provider's API; the scenario plays out as events. */
  async acceptFromApi(project: Project, input: IncomingMessage): Promise<SimMessage> {
    const recipients = input.to.map((address) => ({ address, scenario: selectScenario(address, input.scenarioHeader) }));
    const message = await this.save(project, input, recipients, 'api');
    for (const recipient of recipients) {
      await this.play(message, recipient.address, resolveScenario(recipient.scenario).timeline);
    }
    return message;
  }

  /**
   * SMTP `RCPT TO`: decides the live answer for one recipient. Header-selected scenarios are not known yet;
   * they are applied after DATA by `smtpData`.
   */
  async smtpRecipient(project: Project, from: string, recipient: string): Promise<{ outcome: ResolvedScenario; reply?: SmtpReply | 'hang' }> {
    const selection = selectScenario(recipient);
    const attempt = await this.store.nextAttempt(`${project.id}|${from.toLowerCase()}|${recipient.toLowerCase()}`, this.greylistTtlMs);
    const outcome = resolveScenario(selection, attempt);
    const reply = outcome.smtp;
    return reply !== undefined && reply !== 'hang' && reply.stage === 'rcpt' ? { outcome, reply } : { outcome };
  }

  /** Records a recipient refused at RCPT, with the event its refusal means. */
  async smtpRefused(project: Project, from: string, recipient: string, outcome: ResolvedScenario): Promise<void> {
    const message = await this.save(project, { from, to: [recipient], subject: '' }, [{ address: recipient, scenario: outcome.selection }], 'smtp');
    await this.play(message, recipient, smtpTimeline(outcome));
  }

  /**
   * End of SMTP DATA, for the recipients accepted at RCPT. Returns the reply to give, if the message is
   * refused after DATA (content problems, or a scenario chosen with `X-Sim-Scenario`).
   */
  async smtpData(
    project: Project,
    input: IncomingMessage,
    accepted: Array<{ address: string; outcome: ResolvedScenario }>,
  ): Promise<{ reply?: SmtpReply | 'hang'; message?: SimMessage }> {
    const decided = accepted.map(({ address, outcome }) => {
      if (!input.scenarioHeader) return { address, outcome };
      const selection = selectScenario(address, input.scenarioHeader);
      return { address, outcome: selection.source === 'header' ? resolveScenario(selection) : outcome };
    });

    // Recipients reaching DATA passed RCPT, so any live answer left is given now: content problems, a
    // timeout, or a scenario picked by header. SMTP can only refuse the whole message at this point.
    const refusal = decided.find((d) => d.outcome.smtp !== undefined)?.outcome;
    if (refusal?.smtp === 'hang') return { reply: 'hang' };

    const recipients = decided.map((d) => ({ address: d.address, scenario: d.outcome.selection }));
    const message = await this.save(project, input, recipients, 'smtp');
    for (const { address, outcome } of decided) {
      await this.play(message, address, smtpTimeline(refusal ?? outcome));
    }
    return refusal?.smtp ? { reply: refusal.smtp, message } : { message };
  }

  // --- Timeline ---------------------------------------------------------------------------------

  private async save(project: Project, input: IncomingMessage, recipients: SimRecipient[], via: SimMessage['via']): Promise<SimMessage> {
    const message: SimMessage = {
      id: `sim_${randomUUID()}`,
      projectId: project.id,
      via,
      from: input.from,
      recipients,
      subject: input.subject,
      createdAt: new Date(),
      ...(input.relayoMessageId && { relayoMessageId: input.relayoMessageId }),
      ...(input.metadata && { metadata: input.metadata }),
      ...(input.tags?.length && { tags: input.tags }),
    };
    await this.store.saveMessage(message);
    return message;
  }

  private async play(message: SimMessage, recipient: string, steps: TimelineStep[]): Promise<void> {
    for (const [index, step] of steps.entries()) {
      const delay = step.after * this.timeScale;
      const at = message.createdAt.getTime() + delay;
      const job: ScheduledStep = { projectId: message.projectId, messageId: message.id, recipient, index, step, at };
      await this.scheduler.schedule(job, delay);
    }
  }

  private async runStep(job: ScheduledStep): Promise<void> {
    const message = await this.store.getMessage(job.projectId, job.messageId);
    const project = await this.store.getProject(job.projectId);
    if (!message || !project) return;

    const event = toEvent(message, job);
    await this.store.addEvent(event);
    if (project.webhookUrl) await this.webhooks.dispatch(event, { url: project.webhookUrl, secret: project.webhookSecret });
  }
}

function toEvent(message: SimMessage, job: ScheduledStep): SimEvent {
  const { step } = job;
  const scenario = message.recipients.find((r) => r.address === job.recipient)?.scenario;
  const base: RelayoEvent & { projectId: string } = {
    // Zero-padded so ids sort in timeline order when timestamps tie (e.g. TIME_SCALE=0).
    id: `${message.id}:${job.recipient}:${String(job.index).padStart(3, '0')}`,
    type: step.type,
    channel: 'email',
    provider: 'simulator',
    messageId: message.relayoMessageId ?? message.id,
    providerMessageId: message.id,
    recipient: job.recipient,
    // The simulated time of the step, not when a worker got to it: queues may run steps out of order.
    timestamp: new Date(job.at),
    raw: { scenario, step, via: message.via },
    projectId: message.projectId,
  };
  if (message.metadata) base.metadata = message.metadata;

  if (step.type === 'bounced' && step.bounce) {
    const event: BounceEvent & { projectId: string } = { ...base, type: 'bounced', ...step.bounce };
    return event;
  }
  if (step.type === 'rejected' && step.reject) {
    const event: RejectEvent & { projectId: string } = { ...base, type: 'rejected', ...step.reject };
    return event;
  }
  if (step.type === 'clicked' && step.url) {
    const event: ClickEvent & { projectId: string } = { ...base, type: 'clicked', url: step.url };
    return event;
  }
  return base;
}

export function hashKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}
