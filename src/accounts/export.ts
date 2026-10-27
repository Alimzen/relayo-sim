import type { Mode, Project, User } from '../domain.js';
import type { LiveService } from '../live/live.service.js';
import type { SimStore } from '../store/store.js';
import { publicKey, publicMessage, publicProject } from '../api/present.js';

/** Messages exported per project and mode: retention keeps the store small, this keeps a file bounded. */
const MAX_MESSAGES = 10_000;

/**
 * Everything the platform keeps about a person, as one JSON document (data portability): the account, and for
 * each project they own, its settings, keys (never the key itself), templates, suppressions, connections (no
 * credentials), domains (no private keys), members and the messages still kept, with their events. Projects
 * they were invited to are listed without their data: that belongs to their owners.
 */
export async function exportAccount(store: SimStore, live: LiveService, user: User) {
  const projects = await store.listProjectsFor(user.id);
  return {
    exportedAt: new Date(),
    account: { id: user.id, email: user.email, name: user.name, emailVerified: !!user.emailVerifiedAt, createdAt: user.createdAt },
    memberOf: projects.filter((p) => p.role !== 'owner').map(({ project, role }) => ({ id: project.id, name: project.name, role })),
    projects: await Promise.all(projects.filter((p) => p.role === 'owner').map(({ project }) => exportProject(store, live, project))),
  };
}

async function exportProject(store: SimStore, live: LiveService, project: Project) {
  const members = await store.listMembers(project.id);
  const users = await Promise.all(members.map((m) => store.getUser(m.userId)));
  return {
    ...publicProject(project),
    keys: (await store.listApiKeys(project.id)).map(publicKey),
    templates: (await store.listTemplates(project.id)).map(({ projectId: _p, ...t }) => t),
    suppressions: (await store.listSuppressions(project.id, 100_000)).map(({ projectId: _p, ...s }) => s),
    connections: (await store.listConnections(project.id)).map((c) => live.publicConnection(c)),
    domains: (await store.listDomains(project.id)).map((d) => live.publicDomain(d)),
    members: members.map((m, i) => ({ email: users[i]?.email ?? null, role: m.role, since: m.createdAt })),
    messages: {
      test: await messages(store, project.id, 'test'),
      live: await messages(store, project.id, 'live'),
    },
  };
}

async function messages(store: SimStore, projectId: string, mode: Mode) {
  const list = await store.listMessages(projectId, { limit: MAX_MESSAGES, mode });
  const full = await Promise.all(list.map((m) => store.getMessage(projectId, m.id)));
  return full.flatMap((message) => {
    if (!message) return [];
    const { events, ...rest } = message;
    return [{ ...publicMessage(rest), events: events.map(({ projectId: _p, ...e }) => e) }];
  });
}
