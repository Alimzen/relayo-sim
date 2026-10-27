import { BadRequestException, HttpException, Inject, Injectable } from '@nestjs/common';
import { composeMessage, quotedHeaders, readHeaders, type ApiAttachment, type MailAddress } from '../capture/capture.js';
import type { Mode, Project } from '../domain.js';
import { LiveError, LiveService } from '../live/live.service.js';
import { isSmsScenario, PHONE, WHATSAPP } from '../scenarios/sms.js';
import { QuotaExceededError, SimulationService } from '../simulation/simulation.service.js';
import { TemplateError, TemplatesService } from '../templates/templates.js';

export type Address = string | { address: string; name?: string };

/** Body of `POST /v1/messages`. Mirrors Relayo's EmailMessage. */
export interface SendBody {
  from: Address;
  to: Address | Address[];
  cc?: Address[];
  bcc?: Address[];
  subject: string;
  html?: string;
  text?: string;
  replyTo?: Address;
  headers?: Record<string, string>;
  /** Content in base64. */
  attachments?: ApiAttachment[];
  metadata?: Record<string, string>;
  tags?: string[];
  /** Relayo's message id, so events come back with it. */
  relayoMessageId?: string;
  /** A saved template (alias or id) for subject, html and text; fields given here win over it. */
  template?: string;
  variables?: Record<string, unknown>;
  /** ISO date: send then instead of now (up to 30 days ahead). */
  sendAt?: string;
}

/** Body of `POST /v1/sms`. Mirrors Relayo's SmsMessage. */
export interface SendSmsBody {
  from?: string;
  to: Address | Address[];
  body: string;
  metadata?: Record<string, string>;
  tags?: string[];
  /** Relayo's message id, so events come back with it. */
  relayoMessageId?: string;
  /** Scenario for every recipient, instead of the magic numbers. */
  scenario?: string;
  /** A saved SMS template (alias or id) for the text, instead of `body`. */
  template?: string;
  variables?: Record<string, unknown>;
  /** ISO date: send then instead of now (up to 30 days ahead). */
  sendAt?: string;
  /**
   * WhatsApp's approved template (Twilio Content API), needed outside the 24-hour window after the user's
   * last message. `body` is then the message's readable summary.
   */
  whatsapp?: { contentSid?: string; contentVariables?: Record<string, string> };
}

/** What a send answers: the message, or the scheduled send. */
export type SendAnswer = { id: string; status: 'queued' | 'scheduled'; recipients?: unknown; sendAt?: Date };

export const EMAIL = /^[^\s@]+@[^\s@]+$/;
/** Sender ids: a phone number, or up to 11 letters and digits (alphanumeric sender id). */
const SENDER = /^((whatsapp:)?\+[1-9]\d{7,14}|[A-Za-z0-9 ]{1,11})$/;

export const addressOf = (value: Address) => (typeof value === 'string' ? value : value?.address);
/** A Relayo recipient from an API address. */
const recipientOf = (value: Address) =>
  typeof value === 'string' ? { address: value } : { address: value.address, ...(value.name && { name: value.name }) };

/** Simulator-only headers are not passed on to real providers. */
const withoutSimHeaders = (headers: Record<string, string>) =>
  Object.fromEntries(Object.entries(headers).filter(([name]) => name.toLowerCase() !== 'x-sim-scenario'));

/** The address with its display name, for the captured message's headers. */
const display = (value: Address): MailAddress =>
  typeof value === 'string' || !value.name ? addressOf(value) : { name: value.name, address: value.address };

/** Runs a live operation, answering its errors with their status and message. */
export async function liveCall<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof LiveError) throw new HttpException({ statusCode: error.status, message: error.message }, error.status);
    throw error;
  }
}

/** Template errors as HTTP answers, with their (Spanish, user-facing) message. */
export async function renderTemplate<T>(fn: () => Promise<T>): Promise<T> {
  try {
    return await fn();
  } catch (error) {
    if (error instanceof TemplateError) throw new HttpException({ statusCode: error.status, message: error.message }, error.status);
    throw error;
  }
}

export function variablesOf(body: { variables?: unknown }): Record<string, unknown> {
  if (body.variables === undefined) return {};
  if (body.variables === null || typeof body.variables !== 'object' || Array.isArray(body.variables)) {
    throw new BadRequestException('"variables" must be an object');
  }
  return body.variables as Record<string, unknown>;
}

function withoutUndefined<T extends object>(value: T): Partial<T> {
  return Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as Partial<T>;
}

function checkAttachments(value: unknown): ApiAttachment[] | undefined {
  if (value === undefined) return undefined;
  const ok =
    Array.isArray(value) &&
    value.every(
      (a: Partial<ApiAttachment>) =>
        a && typeof a.filename === 'string' && a.filename && typeof a.content === 'string' &&
        (a.contentType === undefined || typeof a.contentType === 'string') && (a.cid === undefined || typeof a.cid === 'string'),
    );
  if (!ok) throw new BadRequestException('"attachments" must be a list of { filename, content (base64), contentType?, cid? }');
  return value as ApiAttachment[];
}

interface PreparedEmail {
  body: SendBody;
  from: string;
  to: string[];
  attachments: ApiAttachment[] | undefined;
  scenarioHeader: string | undefined;
}

interface PreparedSms {
  body: SendSmsBody;
  from: string;
  to: string[];
}

/**
 * The sends behind the API (and the scheduler): \`prepare\` fills the template and checks the request without
 * sending; \`email\` and \`sms\` prepare, count the message against the plan and send it — simulated with a
 * test key, delivered through the project's connections with a live one.
 */
@Injectable()
export class SendingService {
  constructor(
    @Inject(SimulationService) private readonly sim: SimulationService,
    @Inject(LiveService) private readonly live: LiveService,
    @Inject(TemplatesService) private readonly templates: TemplatesService,
  ) {}

  async prepareEmail(project: Project, input: SendBody): Promise<PreparedEmail> {
    const body =
      input?.template === undefined
        ? input
        : ({ ...(await renderTemplate(() => this.templates.renderEmail(project, String(input.template), variablesOf(input)))), ...withoutUndefined(input) } as SendBody);
    const from = addressOf(body?.from);
    const to = [...(Array.isArray(body?.to) ? body.to : [body?.to]), ...(body?.cc ?? []), ...(body?.bcc ?? [])].map(addressOf);
    if (!from || !EMAIL.test(from)) throw new BadRequestException('"from" must be an email address');
    if (!to.length || to.some((a) => !a || !EMAIL.test(a))) throw new BadRequestException('"to" must contain email addresses');
    if (typeof body.subject !== 'string') throw new BadRequestException('"subject" is required');

    const scenarioHeader = Object.entries(body.headers ?? {}).find(([k]) => k.toLowerCase() === 'x-sim-scenario')?.[1];
    const attachments = checkAttachments(body.attachments);
    if (body.headers !== undefined && (typeof body.headers !== 'object' || Object.values(body.headers).some((v) => typeof v !== 'string'))) {
      throw new BadRequestException('"headers" must map names to strings');
    }
    return { body, from, to: to as string[], attachments, scenarioHeader };
  }

  async email(project: Project, mode: Mode, input: SendBody): Promise<SendAnswer> {
    const { body, from, to, attachments, scenarioHeader } = await this.prepareEmail(project, input);
    await this.reserve(project, mode);

    // Capture the email the provider would have sent, as SMTP mail is captured.
    const toList = Array.isArray(body.to) ? body.to : [body.to];
    const raw = await composeMessage({
      from: display(body.from),
      to: toList.map((a) => display(a)),
      ...(body.cc?.length && { cc: body.cc.map((a) => display(a)) }),
      ...(body.replyTo && { replyTo: display(body.replyTo) }),
      subject: body.subject,
      ...(typeof body.text === 'string' && { text: body.text }),
      ...(typeof body.html === 'string' && { html: body.html }),
      headers: {
        ...body.headers,
        ...(body.relayoMessageId && { 'X-Relayo-Message-ID': body.relayoMessageId }),
        ...(body.metadata && { 'X-Relayo-Metadata': Buffer.from(JSON.stringify(body.metadata)).toString('base64url') }),
      },
      ...(attachments && { attachments }),
    });

    if (mode === 'live') {
      const message = await liveCall(() =>
        this.live.sendEmail(project, {
          via: 'api',
          raw,
          ...(typeof input.template === 'string' && { template: input.template }),
          headers: quotedHeaders(readHeaders(raw.toString('utf8'))),
          ...(body.relayoMessageId && { relayoMessageId: body.relayoMessageId }),
          message: {
            from: recipientOf(body.from),
            to: toList.map(recipientOf),
            ...(body.cc?.length && { cc: body.cc.map(recipientOf) }),
            ...(body.bcc?.length && { bcc: body.bcc.map(recipientOf) }),
            ...(body.replyTo && { replyTo: recipientOf(body.replyTo) }),
            subject: body.subject,
            ...(typeof body.text === 'string' && { text: body.text }),
            ...(typeof body.html === 'string' && { html: body.html }),
            ...(body.headers && Object.keys(body.headers).length && { headers: withoutSimHeaders(body.headers) }),
            ...(attachments?.length && {
              attachments: attachments.map((a) => ({
                filename: a.filename,
                content: Buffer.from(a.content, 'base64'),
                ...(a.contentType && { contentType: a.contentType }),
                ...(a.cid && { cid: a.cid }),
              })),
            }),
            ...(body.metadata && { metadata: body.metadata }),
            ...(body.tags && { tags: body.tags }),
          },
        }),
      );
      return { id: message.id, status: 'queued', recipients: message.recipients };
    }

    const message = await this.sim.acceptFromApi(project, {
      raw,
      headers: quotedHeaders(readHeaders(raw.toString('utf8'))),
      from,
      to,
      subject: body.subject,
      ...(body.relayoMessageId && { relayoMessageId: body.relayoMessageId }),
      ...(body.metadata && { metadata: body.metadata }),
      ...(body.tags && { tags: body.tags }),
      ...(typeof input.template === 'string' && { template: input.template }),
      ...(scenarioHeader && { scenarioHeader }),
    });
    return { id: message.id, status: 'queued', recipients: message.recipients };
  }

  async prepareSms(project: Project, input: SendSmsBody): Promise<PreparedSms> {
    const body =
      input?.template === undefined
        ? input
        : { ...input, body: input.body ?? (await renderTemplate(() => this.templates.renderSms(project, String(input.template), variablesOf(input)))).body };
    const to = (Array.isArray(body?.to) ? body.to : [body?.to]).map((a) => addressOf(a as Address)?.trim());
    if (!to.length || to.some((n) => !n || !PHONE.test(n))) {
      throw new BadRequestException('"to" must contain phone numbers in E.164 format, e.g. +12015550100 (whatsapp:+12015550100 for WhatsApp)');
    }
    const whatsapp = to.filter((n) => n!.startsWith(WHATSAPP)).length;
    if (whatsapp && whatsapp < to.length) throw new BadRequestException('Send SMS and WhatsApp numbers in separate requests');
    if (body.whatsapp !== undefined) {
      const options = body.whatsapp;
      const valid =
        options !== null &&
        typeof options === 'object' &&
        (options.contentSid === undefined || typeof options.contentSid === 'string') &&
        (options.contentVariables === undefined || (typeof options.contentVariables === 'object' && options.contentVariables !== null));
      if (!valid) throw new BadRequestException('"whatsapp" must be { contentSid?, contentVariables? }');
      if (!whatsapp) throw new BadRequestException('"whatsapp" options need whatsapp: recipients');
    }
    if (typeof body.body !== 'string' || !body.body.trim()) throw new BadRequestException('"body" is required');
    if (body.body.length > 1600) throw new BadRequestException('"body" can have at most 1600 characters');
    const from = body.from?.trim() || 'RelayoSim';
    if (!SENDER.test(from)) throw new BadRequestException('"from" must be a phone number (E.164) or an alphanumeric sender id of up to 11 characters');
    if (body.scenario !== undefined && (typeof body.scenario !== 'string' || !isSmsScenario(body.scenario.trim().toLowerCase()))) {
      throw new BadRequestException(`Unknown SMS scenario "${String(body.scenario)}"`);
    }
    return { body, from, to: to as string[] };
  }

  async sms(project: Project, mode: Mode, input: SendSmsBody): Promise<SendAnswer> {
    const { body, from, to } = await this.prepareSms(project, input);
    await this.reserve(project, mode);

    if (mode === 'live') {
      const live = await liveCall(() =>
        this.live.sendSms(project, {
          ...(body.from?.trim() && { from: body.from.trim() }),
          to,
          body: body.body,
          ...(body.whatsapp && { whatsapp: body.whatsapp }),
          ...(body.relayoMessageId && { relayoMessageId: body.relayoMessageId }),
          ...(body.metadata && { metadata: body.metadata }),
          ...(body.tags && { tags: body.tags }),
          ...(typeof input.template === 'string' && { template: input.template }),
        }),
      );
      return { id: live.id, status: 'queued', recipients: live.recipients };
    }

    const message = await this.sim.acceptSms(project, {
      from,
      to,
      body: body.body,
      ...(body.relayoMessageId && { relayoMessageId: body.relayoMessageId }),
      ...(body.metadata && { metadata: body.metadata }),
      ...(body.tags && { tags: body.tags }),
      ...(body.scenario && { scenario: body.scenario }),
      ...(typeof input.template === 'string' && { template: input.template }),
    });
    return { id: message.id, status: 'queued', recipients: message.recipients };
  }

  private async reserve(project: Project, mode: Mode): Promise<void> {
    try {
      await this.sim.reserve(project, mode);
    } catch (error) {
      if (error instanceof QuotaExceededError) throw new HttpException({ statusCode: 429, message: error.message }, 429);
      throw error;
    }
  }
}
