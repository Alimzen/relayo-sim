import { randomUUID } from 'node:crypto';
import { Inject, Injectable, Logger, SetMetadata } from '@nestjs/common';
import type { ApiKey, AuditActor, Mode, Project } from '../domain.js';
import { SIM_STORE, type SimStore } from '../store/store.js';

const NO_AUDIT = 'relayo:no-audit';
/** Marks POST endpoints that change nothing (previews): they stay out of the audit log. */
export const NoAudit = () => SetMetadata(NO_AUDIT, true);
export const NO_AUDIT_KEY = NO_AUDIT;

/** Request fields the audit log keeps: what was named or chosen, never credentials or content. */
const DETAIL_FIELDS = ['name', 'email', 'role', 'permission', 'allowedDomains', 'mode', 'address', 'reason', 'domain', 'kind', 'channel', 'slug', 'confirm'];

/** The parts of an Express request and response the log reads. */
export interface TrackedRequest {
  method: string;
  ip?: string;
  originalUrl?: string;
  url?: string;
  body?: unknown;
  params?: Record<string, string>;
  route?: { path?: string };
}

export interface TrackedResponse {
  statusCode: number;
  json(body: unknown): unknown;
  once(event: 'finish', listener: () => void): unknown;
}

export interface TrackOptions {
  project: Project;
  mode: Mode;
  /** The key that made the request; requests made from the panel have none and only reach the audit log. */
  key?: ApiKey;
  user?: { id: string; email: string };
  /** Sends are not changes to the project: they have the message log. */
  sends: boolean;
  noAudit: boolean;
}

/**
 * The project's audit log (who changed what) and API request log (every request made with a key, with its
 * answer). Both are written once the response has gone out, and a failure to write never fails the request.
 */
@Injectable()
export class ActivityLog {
  private readonly logger = new Logger('ActivityLog');

  constructor(@Inject(SIM_STORE) private readonly store: SimStore) {}

  track(req: TrackedRequest, res: TrackedResponse, options: TrackOptions): void {
    const started = Date.now();
    let error: string | undefined;
    // Errors are answered as JSON: keep their message for the request log.
    const json = res.json.bind(res);
    res.json = (body: unknown) => {
      if (res.statusCode >= 400) error = errorMessage(body);
      return json(body);
    };
    res.once('finish', () => {
      void this.record(req, res.statusCode, Date.now() - started, error, options).catch((e: Error) =>
        this.logger.warn(`Could not write the activity log: ${e.message}`),
      );
    });
  }

  /** An audit entry for a change made outside the project's own endpoints (platform admins). */
  async audit(project: Project, actor: AuditActor, action: string, details?: Record<string, unknown>): Promise<void> {
    await this.store.addAudit({
      id: `aud_${randomUUID()}`,
      projectId: project.id,
      actor,
      action,
      ...(details && { details }),
      mode: 'test',
      createdAt: new Date(),
    });
  }

  private async record(req: TrackedRequest, status: number, durationMs: number, error: string | undefined, o: TrackOptions): Promise<void> {
    const path = (req.originalUrl ?? req.url ?? '').split('?')[0]!;
    const now = new Date();
    if (o.key) {
      await this.store.addApiRequest({
        id: `req_${randomUUID()}`,
        projectId: o.project.id,
        keyId: o.key.id,
        keyName: o.key.name,
        mode: o.mode,
        method: req.method,
        path,
        status,
        durationMs,
        ...(req.ip && { ip: req.ip }),
        ...(error && { error: error.slice(0, 500) }),
        createdAt: now,
      });
    }
    const changes = req.method !== 'GET' && req.method !== 'HEAD' && req.method !== 'OPTIONS';
    if (!changes || o.sends || o.noAudit || status >= 400) return;
    const actor: AuditActor | undefined = o.key
      ? { kind: 'key', id: o.key.id, name: o.key.name }
      : o.user && { kind: 'user', id: o.user.id, email: o.user.email };
    if (!actor) return;
    const details = pick(req.body);
    const params = req.params && Object.keys(req.params).length ? { ...req.params } : undefined;
    await this.store.addAudit({
      id: `aud_${randomUUID()}`,
      projectId: o.project.id,
      actor,
      action: `${req.method} ${req.route?.path ?? path}`,
      ...(params && { params }),
      ...(details && { details }),
      ...(req.ip && { ip: req.ip }),
      mode: o.mode,
      createdAt: now,
    });
  }
}

function pick(body: unknown): Record<string, unknown> | undefined {
  if (!body || typeof body !== 'object' || Array.isArray(body)) return undefined;
  const picked: Record<string, unknown> = {};
  for (const field of DETAIL_FIELDS) {
    const value = (body as Record<string, unknown>)[field];
    if (typeof value === 'string') picked[field] = value.slice(0, 200);
    else if (typeof value === 'number' || typeof value === 'boolean') picked[field] = value;
    else if (Array.isArray(value) && value.every((v) => typeof v === 'string')) picked[field] = value.slice(0, 20);
  }
  return Object.keys(picked).length ? picked : undefined;
}

function errorMessage(body: unknown): string | undefined {
  const message = (body as { message?: unknown } | null)?.message;
  if (typeof message === 'string') return message;
  if (Array.isArray(message)) return message.join('; ');
  return undefined;
}
