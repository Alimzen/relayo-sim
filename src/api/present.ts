import type { ApiKey, Project, SimMessage } from '../domain.js';
import { maskSmtpUrl } from '../reports/sender.js';

/** A project as the API shows it: no secrets, SMTP password masked. */
export function publicProject(project: Project) {
  return {
    id: project.id,
    name: project.name,
    webhookUrl: project.webhookUrl ?? null,
    reportsSmtpUrl: project.reportsSmtpUrl ? maskSmtpUrl(project.reportsSmtpUrl) : null,
    createdAt: project.createdAt,
  };
}

export function publicMessage<M extends SimMessage>(message: M): Omit<M, 'projectId'> {
  const { projectId: _projectId, ...rest } = message;
  return rest;
}

export function publicKey(key: ApiKey) {
  return {
    id: key.id,
    name: key.name,
    prefix: key.prefix,
    createdAt: key.createdAt,
    lastUsedAt: key.lastUsedAt ?? null,
    revokedAt: key.revokedAt ?? null,
  };
}
