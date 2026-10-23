import { randomUUID } from 'node:crypto';
import { BadRequestException, HttpException, Inject, Injectable, Logger } from '@nestjs/common';
import type { Mode, Project, ScheduledSend } from '../domain.js';
import { SIM_STORE, type SimStore } from '../store/store.js';
import { SendingService, type SendAnswer, type SendBody, type SendSmsBody } from './sending.js';

/** How far ahead a send can be scheduled. */
export const MAX_SCHEDULE_DAYS = 30;

/**
 * Sends with \`sendAt\`: checked when they arrive (template, addresses...), stored, and sent through the same
 * path as an immediate send when their time comes. The plan's limits apply then, at sending time.
 */
@Injectable()
export class ScheduledSends {
  private readonly logger = new Logger('ScheduledSends');
  private timer: ReturnType<typeof setInterval> | undefined;
  private running: Promise<number> | undefined;

  constructor(
    @Inject(SIM_STORE) private readonly store: SimStore,
    @Inject(SendingService) private readonly sending: SendingService,
  ) {}

  async schedule(project: Project, mode: Mode, channel: 'email' | 'sms', body: SendBody | SendSmsBody): Promise<SendAnswer> {
    const sendAt = parseSendAt(body.sendAt);
    const { sendAt: _sendAt, ...request } = body;
    // Refuse now what would fail later: a bad address or a missing template variable.
    const prepared =
      channel === 'email' ? await this.sending.prepareEmail(project, request as SendBody) : await this.sending.prepareSms(project, request as SendSmsBody);
    const summary =
      channel === 'email' ? (prepared.body as SendBody).subject : (prepared.body as SendSmsBody).body.slice(0, 120);
    const now = new Date();
    const send: ScheduledSend = {
      id: `sch_${randomUUID()}`,
      projectId: project.id,
      mode,
      channel,
      request: request as Record<string, unknown>,
      sendAt,
      status: 'pending',
      summary,
      recipients: prepared.to,
      createdAt: now,
      updatedAt: now,
    };
    await this.store.createScheduled(send);
    return { id: send.id, status: 'scheduled', sendAt };
  }

  /** Sends whatever is due. Returns how many it handled. */
  async runDue(now = new Date()): Promise<number> {
    const due = await this.store.claimDueScheduled(now, 50);
    for (const send of due) await this.run(send);
    return due.length;
  }

  /** Checks every \`intervalMs\` (15 s): a send leaves at most that late. */
  start(intervalMs = 15_000): void {
    this.timer = setInterval(() => {
      // One round at a time: a slow provider must not start a second round on the same sends.
      this.running ??= this.runDue()
        .catch((error: Error) => {
          this.logger.warn(`Scheduled sends: ${error.message}`);
          return 0;
        })
        .finally(() => (this.running = undefined));
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    await this.running;
  }

  private async run(send: ScheduledSend): Promise<void> {
    const project = await this.store.getProject(send.projectId);
    if (!project) return this.store.finishScheduled(send.id, { status: 'failed', error: 'The project no longer exists' });
    try {
      const answer =
        send.channel === 'email'
          ? await this.sending.email(project, send.mode, send.request as unknown as SendBody)
          : await this.sending.sms(project, send.mode, send.request as unknown as SendSmsBody);
      await this.store.finishScheduled(send.id, { status: 'sent', messageId: answer.id });
    } catch (error) {
      await this.store.finishScheduled(send.id, { status: 'failed', error: messageOf(error) });
    }
  }
}

function parseSendAt(value: unknown): Date {
  const date = typeof value === 'string' ? new Date(value) : undefined;
  if (!date || Number.isNaN(date.getTime())) throw new BadRequestException('"sendAt" must be an ISO date, e.g. 2026-11-01T09:00:00Z');
  if (date.getTime() > Date.now() + MAX_SCHEDULE_DAYS * 86_400_000) {
    throw new BadRequestException(`"sendAt" can be at most ${MAX_SCHEDULE_DAYS} days ahead`);
  }
  // A time in the past is sent on the next round, as soon as possible.
  return date;
}

/** The message the API would have answered, for the scheduled send's record. */
function messageOf(error: unknown): string {
  if (error instanceof HttpException) {
    const response = error.getResponse();
    const message = typeof response === 'object' && response && 'message' in response ? (response as { message: unknown }).message : response;
    return Array.isArray(message) ? message.join('; ') : String(message);
  }
  return error instanceof Error ? error.message : String(error);
}
