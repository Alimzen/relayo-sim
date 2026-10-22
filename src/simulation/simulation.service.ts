import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { BounceEvent, ClickEvent, RejectEvent, RelayoEvent } from '@alimzen/relayo';
import type { ApiKey, Project, SimEvent, SimMessage, SimRecipient, Mode } from '../domain.js';
import { buildReport, reportRecipient } from '../reports/reports.js';
import type { ReportSender } from '../reports/sender.js';
import type { SmtpReply, TimelineStep } from '../scenarios/catalog.js';
import { resolveScenario, selectScenario, smtpTimeline, type ResolvedScenario } from '../scenarios/resolve.js';
import { selectSmsScenario, smsTimeline } from '../scenarios/sms.js';
import type { EventScheduler, ScheduledStep } from '../scheduler/scheduler.js';
import type { SimStore } from '../store/store.js';
import type { WebhookDispatcher } from '../webhooks/webhooks.js';

export interface SimulationOptions {
  /** Multiplies every timeline delay. `0` fires everything at once (CI); `1` is real time. Default 1. */
  timeScale?: number;
  /** How long greylisting remembers an attempt. Default 1 hour. */
  greylistTtlMs?: number;
  /** Sends bounce (DSN) and complaint (ARF) reports to projects that set `reportsSmtpUrl`. */
  reports?: ReportSender;
  /** Per project; 0 or missing means no limit. */
  limits?: { monthlyMessages?: number; messagesPerMinute?: number };
}

/** A project went over its plan: too many messages this month, or too fast. */
export class QuotaExceededError extends Error {
  constructor(
    readonly kind: 'monthly' | 'rate',
    readonly limit: number,
  ) {
    super(
      kind === 'monthly'
        ? `Monthly limit of ${limit} messages reached for this project`
        : `Too many messages: the limit is ${limit} per minute`,
    );
    this.name = 'QuotaExceededError';
  }
}

/** `2026-10`, in UTC. */
export const usageMonth = (date = new Date()) => date.toISOString().slice(0, 7);

export interface IncomingMessage {
  from: string;
  to: string[];
  subject: string;
  relayoMessageId?: string;
  metadata?: Record<string, string>;
  tags?: string[];
  /** Value of `X-Sim-Scenario`, applied to every recipient. */
  scenarioHeader?: string;
  /** SMTP envelope sender, when different from `from`. */
  envelopeFrom?: string;
  /** Original headers to quote back in reports. */
  headers?: Record<string, string>;
  /** The whole message (MIME), captured for the inbox. */
  raw?: Uint8Array;
}

/** An SMS sent through the HTTP API. */
export interface IncomingSms {
  /** Sender: a phone number or an alphanumeric sender id. */
  from: string;
  to: string[];
  body: string;
  relayoMessageId?: string;
  metadata?: Record<string, string>;
  tags?: string[];
  /** Scenario for every recipient, instead of the magic numbers. */
  scenario?: string;
}

/** Ties scenarios, storage, scheduling and webhooks together. */
export class SimulationService {
  private readonly timeScale: number;
  private readonly greylistTtlMs: number;
  private readonly reports: ReportSender | undefined;
  private readonly limits: { monthlyMessages: number; messagesPerMinute: number };

  constructor(
    private readonly store: SimStore,
    private readonly scheduler: EventScheduler,
    private readonly webhooks: WebhookDispatcher,
    options: SimulationOptions = {},
  ) {
    this.timeScale = options.timeScale ?? 1;
    this.greylistTtlMs = options.greylistTtlMs ?? 60 * 60_000;
    this.reports = options.reports;
    this.limits = { monthlyMessages: options.limits?.monthlyMessages ?? 0, messagesPerMinute: options.limits?.messagesPerMinute ?? 0 };
    scheduler.start((job) => this.runStep(job));
  }

  // --- Projects ---------------------------------------------------------------------------------

  /** Creates a project with a first API key. The key is returned only here; only its hash is stored. */
  async createProject(name: string, options: { ownerId?: string; webhookUrl?: string } = {}): Promise<{ project: Project; apiKey: string }> {
    const project: Project = {
      id: `prj_${randomUUID()}`,
      name,
      webhookSecret: newWebhookSecret(),
      createdAt: new Date(),
      ...(options.ownerId && { ownerId: options.ownerId }),
      ...(options.webhookUrl && { webhookUrl: options.webhookUrl }),
    };
    await this.store.createProject(project);
    const { apiKey } = await this.createApiKey(project.id, 'Default');
    return { project, apiKey };
  }

  /**
   * A new API key for a project, returned only here. `rly_test_...` keys simulate; `rly_live_...` keys deliver
   * through the project's connections. Keys from before live mode (`sim_live_...`) are test keys.
   */
  async createApiKey(projectId: string, name: string, mode: Mode = 'test'): Promise<{ key: ApiKey; apiKey: string }> {
    const apiKey = `rly_${mode}_${randomBytes(24).toString('base64url')}`;
    const key: ApiKey = {
      id: `key_${randomUUID()}`,
      projectId,
      name,
      mode,
      prefix: apiKey.slice(0, 13),
      keyHash: hashKey(apiKey),
      createdAt: new Date(),
    };
    await this.store.createApiKey(key);
    return { key, apiKey };
  }

  /** Replaces the webhook signing secret. Webhooks signed with the old one stop verifying. */
  async rotateWebhookSecret(projectId: string): Promise<string> {
    const secret = newWebhookSecret();
    await this.store.updateProject(projectId, { webhookSecret: secret });
    return secret;
  }

  async authenticate(apiKey: string): Promise<Project | undefined> {
    return (await this.authenticateKey(apiKey))?.project;
  }

  /** The project of a key and the mode the key works in. */
  async authenticateKey(apiKey: string): Promise<{ project: Project; mode: Mode } | undefined> {
    const found = await this.store.findProjectByApiKeyHash(hashKey(apiKey));
    if (!found) return undefined;
    // "Last used" is a hint, not an audit log: write it at most once a minute per key.
    const now = new Date();
    if (!found.key.lastUsedAt || now.getTime() - found.key.lastUsedAt.getTime() > 60_000) {
      void this.store.touchApiKey(found.key.id, now).catch(() => undefined);
    }
    return { project: found.project, mode: found.key.mode };
  }

  // --- Quotas -----------------------------------------------------------------------------------

  /**
   * Counts one message against the project's plan, or throws `QuotaExceededError`. Called once per API send
   * and once per SMTP transaction, before the message is accepted.
   */
  async reserve(project: Project): Promise<void> {
    const { monthlyMessages, messagesPerMinute } = this.limits;
    if (messagesPerMinute > 0) {
      const minute = Math.floor(Date.now() / 60_000);
      const count = await this.store.nextAttempt(`rate|${project.id}|${minute}`, 120_000);
      if (count > messagesPerMinute) throw new QuotaExceededError('rate', messagesPerMinute);
    }
    if (monthlyMessages > 0 && (await this.store.getUsage(project.id, usageMonth())) >= monthlyMessages) {
      throw new QuotaExceededError('monthly', monthlyMessages);
    }
    await this.store.incrementUsage(project.id, usageMonth());
  }

  async usage(project: Project): Promise<{ month: string; messages: number; limits: { monthlyMessages: number; messagesPerMinute: number } }> {
    const month = usageMonth();
    return { month, messages: await this.store.getUsage(project.id, month), limits: this.limits };
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

  /** HTTP API SMS send: accepted like a provider's API; each recipient plays its number's scenario. */
  async acceptSms(project: Project, input: IncomingSms): Promise<SimMessage> {
    const recipients = input.to.map((address) => ({ address, scenario: selectSmsScenario(address, input.scenario) }));
    const message = await this.save(
      project,
      {
        from: input.from,
        to: input.to,
        subject: '',
        ...(input.relayoMessageId && { relayoMessageId: input.relayoMessageId }),
        ...(input.metadata && { metadata: input.metadata }),
        ...(input.tags && { tags: input.tags }),
      },
      recipients,
      'api',
      { channel: 'sms', body: input.body },
    );
    for (const recipient of recipients) await this.play(message, recipient.address, smsTimeline(recipient.scenario));
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

  private async save(
    project: Project,
    input: IncomingMessage,
    recipients: SimRecipient[],
    via: SimMessage['via'],
    sms?: { channel: 'sms'; body: string },
  ): Promise<SimMessage> {
    const message: SimMessage = {
      id: `sim_${randomUUID()}`,
      projectId: project.id,
      via,
      ...sms,
      from: input.from,
      recipients,
      subject: input.subject,
      createdAt: new Date(),
      ...(input.relayoMessageId && { relayoMessageId: input.relayoMessageId }),
      ...(input.metadata && { metadata: input.metadata }),
      ...(input.tags?.length && { tags: input.tags }),
      ...(input.envelopeFrom && input.envelopeFrom !== input.from && { envelopeFrom: input.envelopeFrom }),
      ...(input.headers && Object.keys(input.headers).length && { headers: input.headers }),
      ...(input.raw && { size: input.raw.length }),
    };
    await this.store.saveMessage(message, input.raw);
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

    // Like a receiving server, mail the report to the envelope sender. A failure throws so the step is
    // retried; the event and webhook above are idempotent. SMS has no such reports.
    if (project.reportsSmtpUrl && this.reports && message.channel !== 'sms') {
      const report = buildReport(message, event);
      if (report) await this.reports.send(project.reportsSmtpUrl, reportRecipient(message), report);
    }
  }

  /** The report (DSN or ARF) an event produced, rebuilt on demand. */
  async report(project: Project, eventId: string): Promise<string | undefined> {
    const messageId = eventId.slice(0, eventId.indexOf(':'));
    const message = await this.store.getMessage(project.id, messageId);
    const event = message?.events.find((e) => e.id === eventId);
    return message && event && message.channel !== 'sms' ? buildReport(message, event) : undefined;
  }
}

function toEvent(message: SimMessage, job: ScheduledStep): SimEvent {
  const { step } = job;
  const scenario = message.recipients.find((r) => r.address === job.recipient)?.scenario;
  const base: RelayoEvent & { projectId: string } = {
    // Zero-padded so ids sort in timeline order when timestamps tie (e.g. TIME_SCALE=0).
    id: `${message.id}:${job.recipient}:${String(job.index).padStart(3, '0')}`,
    type: step.type,
    channel: message.channel ?? 'email',
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

function newWebhookSecret(): string {
  return `whsec_${randomBytes(24).toString('base64url')}`;
}

export function hashKey(apiKey: string): string {
  return createHash('sha256').update(apiKey).digest('hex');
}
