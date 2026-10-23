import { createHash } from 'node:crypto';
import {
  ConflictException,
  Inject,
  Injectable,
  UnprocessableEntityException,
  BadRequestException,
  type CallHandler,
  type ExecutionContext,
  type NestInterceptor,
} from '@nestjs/common';
import { from, lastValueFrom, type Observable } from 'rxjs';
import { SIM_STORE, type SimStore } from '../store/store.js';
import type { AuthedRequest } from './auth.js';

export const IDEMPOTENCY_HEADER = 'idempotency-key';
/** How long a key is remembered: a client retrying after a timeout does it well within a day. */
export const IDEMPOTENCY_TTL_MS = 24 * 3_600_000;

interface Reply {
  setHeader(name: string, value: string): void;
}

/**
 * \`Idempotency-Key\` on sends: the first request with a key does the work; repeating it (a client retrying
 * after a timeout) gets the first answer back instead of sending again. The same key with a different
 * request is refused, and so is a repeat while the first one is still running.
 */
@Injectable()
export class IdempotencyInterceptor implements NestInterceptor {
  constructor(@Inject(SIM_STORE) private readonly store: SimStore) {}

  intercept(context: ExecutionContext, next: CallHandler): Observable<unknown> {
    const req = context.switchToHttp().getRequest<AuthedRequest & { body?: unknown; path?: string }>();
    const header = req.headers[IDEMPOTENCY_HEADER];
    const key = Array.isArray(header) ? header[0] : header;
    if (!key) return next.handle();
    return from(this.run(key, req, context.switchToHttp().getResponse<Reply>(), () => lastValueFrom(next.handle())));
  }

  private async run(key: string, req: AuthedRequest & { body?: unknown; path?: string }, res: Reply, handle: () => Promise<unknown>): Promise<unknown> {
    if (key.length > 255) throw new BadRequestException('Idempotency-Key can have at most 255 characters');
    const projectId = req.project!.id;
    // Same key, same request: the mode and endpoint count, so a test send cannot answer for a live one.
    const fingerprint = createHash('sha256')
      .update(`${req.mode ?? 'test'} ${req.path ?? ''} ${JSON.stringify(req.body ?? null)}`)
      .digest('hex');

    const claim = await this.store.claimIdempotencyKey(projectId, key, fingerprint, IDEMPOTENCY_TTL_MS);
    if (!claim.claimed) {
      if (claim.fingerprint !== fingerprint) {
        throw new UnprocessableEntityException('This Idempotency-Key was used with a different request: use a new key for a new send');
      }
      if (claim.response === undefined) throw new ConflictException('A request with this Idempotency-Key is still running: retry in a moment');
      res.setHeader('Idempotent-Replayed', 'true');
      return claim.response;
    }

    try {
      const response = await handle();
      await this.store.completeIdempotencyKey(projectId, key, response);
      return response;
    } catch (error) {
      // Nothing was sent (or the send failed): the client may retry with the same key.
      await this.store.releaseIdempotencyKey(projectId, key).catch(() => undefined);
      throw error;
    }
  }
}
