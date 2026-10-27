import { BadRequestException, HttpException, Inject, Injectable } from '@nestjs/common';
import type { ApiKey, Mode, Project } from '../domain.js';
import { fill, type Variables } from '../templates/templates.js';
import { senderAllowed } from './auth.js';
import { ScheduledSends } from './scheduled.js';
import { addressOf, SendingService, type SendAnswer, type SendBody, type SendSmsBody } from './sending.js';

/** Most messages one batch request can carry. */
export const MAX_BATCH = 500;
/** Sends running at once: live ones wait on the provider. */
const CONCURRENCY = 10;

/** One message's outcome, at its position in the request. */
export type BatchItem =
  | ({ index: number } & SendAnswer)
  | { index: number; status: 'failed'; error: { statusCode: number; message: string } };

/**
 * Many sends in one request: fields shared by all at the top level, and per message what changes (usually
 * `to` and `variables`). Each message is sent, or fails, on its own; the answer says which.
 */
@Injectable()
export class BatchSends {
  constructor(
    @Inject(SendingService) private readonly sending: SendingService,
    @Inject(ScheduledSends) private readonly scheduled: ScheduledSends,
  ) {}

  async email(project: Project, mode: Mode, body: Record<string, unknown>, key?: ApiKey): Promise<{ data: BatchItem[] }> {
    return this.run(body, (message) => {
      const send = withVariables(message, ['subject', 'html', 'text']) as unknown as SendBody;
      const from = addressOf(send.from);
      if (key && from && !senderAllowed(key, from)) throw new HttpException({ statusCode: 403, message: `This key can only send from ${key.allowedDomains!.join(', ')}` }, 403);
      if (send.sendAt !== undefined) return this.scheduled.schedule(project, mode, 'email', send);
      return this.sending.email(project, mode, send);
    });
  }

  async sms(project: Project, mode: Mode, body: Record<string, unknown>): Promise<{ data: BatchItem[] }> {
    return this.run(body, (message) => {
      const send = withVariables(message, ['body']) as unknown as SendSmsBody;
      if (send.sendAt !== undefined) return this.scheduled.schedule(project, mode, 'sms', send);
      return this.sending.sms(project, mode, send);
    });
  }

  private async run(body: Record<string, unknown>, send: (message: Record<string, unknown>) => Promise<SendAnswer>): Promise<{ data: BatchItem[] }> {
    const { messages, ...shared } = body ?? {};
    if (!Array.isArray(messages) || messages.length === 0) throw new BadRequestException('"messages" must be a list with at least one message');
    if (messages.length > MAX_BATCH) throw new BadRequestException(`A batch can carry at most ${MAX_BATCH} messages`);
    if (messages.some((m) => !m || typeof m !== 'object' || Array.isArray(m))) throw new BadRequestException('Each message must be an object');

    const results: BatchItem[] = new Array(messages.length);
    let next = 0;
    const worker = async () => {
      for (let index = next++; index < messages.length; index = next++) {
        try {
          results[index] = { index, ...(await send(merge(shared, messages[index] as Record<string, unknown>))) };
        } catch (error) {
          results[index] = { index, status: 'failed', error: failure(error) };
        }
      }
    };
    await Promise.all(Array.from({ length: Math.min(CONCURRENCY, messages.length) }, worker));
    return { data: results };
  }
}

/**
 * The shared fields under the message's own; variables and metadata are merged, the message's winning. A
 * message with its own template does not take the shared content, which would win over the template's.
 */
function merge(shared: Record<string, unknown>, message: Record<string, unknown>): Record<string, unknown> {
  const base = { ...shared };
  if (message.template !== undefined) for (const key of ['subject', 'html', 'text', 'body']) delete base[key];
  const merged: Record<string, unknown> = { ...base, ...message };
  for (const key of ['variables', 'metadata', 'headers'] as const) {
    if (isObject(shared[key]) || isObject(message[key])) merged[key] = { ...asObject(shared[key]), ...asObject(message[key]) };
  }
  return merged;
}

/**
 * Without a saved template, `{{variables}}` in the message's own text are filled too: a batch usually shares
 * one text and changes the variables. With a template, the template does it. A message missing a variable
 * fails rather than going out with the tag in it.
 */
function withVariables(message: Record<string, unknown>, fields: string[]): Record<string, unknown> {
  if (message.template !== undefined) return message;
  const variables = (isObject(message.variables) ? message.variables : {}) as Variables;
  const missing = new Set<string>();
  const filled = { ...message };
  for (const field of fields) {
    if (typeof message[field] === 'string') filled[field] = fill(message[field], variables, field === 'html', missing);
  }
  if (missing.size) throw new BadRequestException(`Faltan variables: ${[...missing].join(', ')}`);
  return filled;
}

function failure(error: unknown): { statusCode: number; message: string } {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const message = typeof response === 'string' ? response : (response as { message?: unknown }).message;
    return { statusCode: error.getStatus(), message: Array.isArray(message) ? message.join('; ') : String(message ?? error.message) };
  }
  return { statusCode: 500, message: error instanceof Error ? error.message : String(error) };
}

const isObject = (value: unknown): value is Record<string, unknown> => !!value && typeof value === 'object' && !Array.isArray(value);
const asObject = (value: unknown) => (isObject(value) ? value : {});
