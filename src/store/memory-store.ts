import type { InboundEmail, WebhookEndpoint, AuditEntry, ApiRequestLog, TokenPurpose, TwoFactor, ProjectInvite, ProjectMember, ProjectRole, ScheduledSend, Template, WebhookAttempt, ApiKey, MessageListItem, MessageWithEvents, Project, ProjectStats, Session, SimEvent, SimMessage, User, PasswordReset, Connection, Mode, Suppression, SuppressionReason, SendingDomain } from '../domain.js';
import { emptyStats } from './stats.js';
import type { AttemptQuery, MessageQuery, ProjectChanges, SealedValue, SimStore, WebhookEndpointChanges } from './store.js';

/** In-process store for tests and local runs without a database. Nothing survives a restart. */
export class MemoryStore implements SimStore {
  private readonly users = new Map<string, User>();
  private readonly sessions = new Map<string, Session>();
  private readonly projects = new Map<string, Project>();
  private readonly keys = new Map<string, ApiKey>();
  private readonly messages = new Map<string, SimMessage>();
  private readonly events = new Map<string, SimEvent[]>();
  private readonly contents = new Map<string, Buffer>();
  private readonly resets = new Map<string, PasswordReset>();
  private readonly connections = new Map<string, Connection>();
  private readonly suppressions = new Map<string, Suppression>();
  private readonly domains = new Map<string, SendingDomain>();
  private readonly usage = new Map<string, number>();
  private readonly webhookAttempts: WebhookAttempt[] = [];
  private readonly audit: AuditEntry[] = [];
  private readonly endpoints: WebhookEndpoint[] = [];
  private readonly inbound: InboundEmail[] = [];
  private readonly requests: ApiRequestLog[] = [];
  private readonly templates = new Map<string, Template>();
  private readonly scheduled = new Map<string, ScheduledSend>();
  private readonly members = new Map<string, ProjectMember>();
  private readonly invites = new Map<string, ProjectInvite>();
  private readonly idempotency = new Map<string, { fingerprint: string; response?: unknown; expires: number }>();
  private readonly attempts = new Map<string, { count: number; expires: number }>();

  // --- Accounts ---------------------------------------------------------------------------------

  async createUser(user: User): Promise<void> {
    if (await this.findUserByEmail(user.email)) throw new Error('A user with this email already exists');
    this.users.set(user.id, { ...user });
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    return [...this.users.values()].find((u) => u.email === email.toLowerCase());
  }

  async getUser(id: string): Promise<User | undefined> {
    return this.users.get(id);
  }

  async updateUser(id: string, changes: Partial<Pick<User, 'name' | 'passwordHash' | 'emailVerifiedAt'>>): Promise<void> {
    const user = this.users.get(id);
    if (user) this.users.set(id, { ...user, ...changes });
  }

  async createSession(session: Session): Promise<void> {
    this.sessions.set(session.idHash, session);
  }

  async getSession(idHash: string): Promise<Session | undefined> {
    const session = this.sessions.get(idHash);
    return session && session.expiresAt > new Date() ? session : undefined;
  }

  async deleteSession(idHash: string): Promise<void> {
    this.sessions.delete(idHash);
  }

  async deleteUserSessions(userId: string, except?: string): Promise<void> {
    for (const [hash, session] of this.sessions) {
      if (session.userId === userId && hash !== except) this.sessions.delete(hash);
    }
  }

  // --- Projects and keys ------------------------------------------------------------------------

  async createProject(project: Project): Promise<void> {
    this.projects.set(project.id, { ...project });
  }

  async getProject(id: string): Promise<Project | undefined> {
    return this.projects.get(id);
  }

  async listProjects(ownerId: string): Promise<Project[]> {
    return [...this.projects.values()]
      .filter((p) => p.ownerId === ownerId)
      .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async listProjectsFor(userId: string): Promise<Array<{ project: Project; role: ProjectRole }>> {
    return [...this.projects.values()]
      .flatMap((project): Array<{ project: Project; role: ProjectRole }> => {
        if (project.ownerId === userId) return [{ project, role: 'owner' }];
        const member = this.members.get(`${project.id}|${userId}`);
        return member ? [{ project, role: member.role }] : [];
      })
      .sort((a, b) => a.project.createdAt.getTime() - b.project.createdAt.getTime());
  }

  async addMember(member: ProjectMember): Promise<void> {
    this.members.set(`${member.projectId}|${member.userId}`, { ...member });
  }

  async getMember(projectId: string, userId: string): Promise<ProjectMember | undefined> {
    return this.members.get(`${projectId}|${userId}`);
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    return [...this.members.values()].filter((m) => m.projectId === projectId).sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
  }

  async updateMemberRole(projectId: string, userId: string, role: ProjectMember['role']): Promise<boolean> {
    const member = this.members.get(`${projectId}|${userId}`);
    if (!member) return false;
    member.role = role;
    return true;
  }

  async removeMember(projectId: string, userId: string): Promise<boolean> {
    return this.members.delete(`${projectId}|${userId}`);
  }

  async createInvite(invite: ProjectInvite): Promise<void> {
    this.invites.set(invite.id, { ...invite });
  }

  async listInvites(projectId: string): Promise<ProjectInvite[]> {
    const now = Date.now();
    return [...this.invites.values()]
      .filter((i) => i.projectId === projectId && i.expiresAt.getTime() > now)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async findInvite(tokenHash: string): Promise<ProjectInvite | undefined> {
    const invite = [...this.invites.values()].find((i) => i.tokenHash === tokenHash);
    return invite && invite.expiresAt.getTime() > Date.now() ? invite : undefined;
  }

  async deleteInvite(projectId: string, id: string): Promise<boolean> {
    if (this.invites.get(id)?.projectId !== projectId) return false;
    return this.invites.delete(id);
  }

  async searchProjects(query: { text?: string; limit: number }): Promise<Array<{ project: Project; ownerEmail?: string }>> {
    const text = query.text?.trim().toLowerCase();
    return [...this.projects.values()]
      .map((project) => ({ project, ownerEmail: project.ownerId ? this.users.get(project.ownerId)?.email : undefined }))
      .filter(({ project, ownerEmail }) => !text || project.name.toLowerCase().includes(text) || project.id === query.text?.trim() || !!ownerEmail?.includes(text))
      .sort((a, b) => b.project.createdAt.getTime() - a.project.createdAt.getTime())
      .slice(0, query.limit)
      .map(({ project, ownerEmail }) => ({ project, ...(ownerEmail && { ownerEmail }) }));
  }

  async listCustomRetention(): Promise<Array<{ projectId: string; days: number }>> {
    return [...this.projects.values()].flatMap((p) => (p.limits?.retentionDays !== undefined ? [{ projectId: p.id, days: p.limits.retentionDays }] : []));
  }

  async listManagedAccess(): Promise<Project[]> {
    return [...this.projects.values()].filter((p) => p.managedAccess).sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async updateProject(id: string, changes: ProjectChanges): Promise<void> {
    const project = this.projects.get(id);
    if (!project) return;
    const next: Project = { ...project };
    if (changes.name !== undefined) next.name = changes.name;
    if (changes.webhookSecret !== undefined) next.webhookSecret = changes.webhookSecret;
    if (changes.ownerId !== undefined) next.ownerId = changes.ownerId;
    for (const key of ['webhookUrl', 'reportsSmtpUrl'] as const) {
      const value = changes[key];
      if (value === null) delete next[key];
      else if (value !== undefined) next[key] = value;
    }
    if (changes.managedAccess === null) delete next.managedAccess;
    else if (changes.managedAccess !== undefined) next.managedAccess = changes.managedAccess;
    if (changes.limits === null) delete next.limits;
    else if (changes.limits !== undefined) next.limits = { ...changes.limits };
    if (changes.options === null) delete next.options;
    else if (changes.options !== undefined) next.options = { ...changes.options };
    if (changes.inboundToken === null) delete next.inboundToken;
    else if (changes.inboundToken !== undefined) next.inboundToken = changes.inboundToken;
    this.projects.set(id, next);
  }

  async deleteProject(id: string): Promise<void> {
    this.projects.delete(id);
    const byProject = <T extends { projectId: string }>(map: Map<string, T>) => {
      for (const [key, value] of map) if (value.projectId === id) map.delete(key);
    };
    for (const [messageId, message] of this.messages) {
      if (message.projectId !== id) continue;
      this.messages.delete(messageId);
      this.events.delete(messageId);
      this.contents.delete(messageId);
    }
    byProject(this.keys);
    byProject(this.connections);
    byProject(this.suppressions);
    byProject(this.domains);
    byProject(this.templates);
    byProject(this.scheduled);
    byProject(this.members);
    byProject(this.invites);
    for (const map of [this.usage, this.idempotency]) {
      for (const key of map.keys()) if (key.startsWith(`${id}|`)) map.delete(key);
    }
    const kept = this.webhookAttempts.filter((a) => a.projectId !== id);
    this.webhookAttempts.splice(0, this.webhookAttempts.length, ...kept);
    keep(this.audit, (e) => e.projectId !== id);
    keep(this.endpoints, (e) => e.projectId !== id);
    keep(this.inbound, (e) => e.projectId !== id);
    keep(this.requests, (r) => r.projectId !== id);
  }

  async deleteUser(id: string): Promise<void> {
    for (const project of [...this.projects.values()]) if (project.ownerId === id) await this.deleteProject(project.id);
    for (const [key, member] of this.members) if (member.userId === id) this.members.delete(key);
    for (const [hash, session] of this.sessions) if (session.userId === id) this.sessions.delete(hash);
    for (const [hash, reset] of this.resets) if (reset.userId === id) this.resets.delete(hash);
    this.users.delete(id);
  }

  async createApiKey(key: ApiKey): Promise<void> {
    this.keys.set(key.id, { permission: 'full', ...key });
  }

  async listApiKeys(projectId: string): Promise<ApiKey[]> {
    return [...this.keys.values()]
      .filter((k) => k.projectId === projectId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime());
  }

  async revokeApiKey(projectId: string, id: string): Promise<boolean> {
    const key = this.keys.get(id);
    if (!key || key.projectId !== projectId || key.revokedAt) return false;
    this.keys.set(id, { ...key, revokedAt: new Date() });
    return true;
  }

  async findProjectByApiKeyHash(hash: string): Promise<{ project: Project; key: ApiKey } | undefined> {
    const key = [...this.keys.values()].find((k) => k.keyHash === hash && !k.revokedAt);
    const project = key && this.projects.get(key.projectId);
    return key && project ? { project, key } : undefined;
  }

  async touchApiKey(id: string, at: Date): Promise<void> {
    const key = this.keys.get(id);
    if (key) this.keys.set(id, { ...key, lastUsedAt: at });
  }

  // --- Messages ---------------------------------------------------------------------------------

  async createConnection(connection: Connection): Promise<void> {
    this.connections.set(connection.id, connection);
  }

  async listConnections(projectId: string, channel?: 'email' | 'sms'): Promise<Connection[]> {
    return [...this.connections.values()]
      .filter((c) => c.projectId === projectId && (!channel || c.channel === channel))
      .sort((a, b) => a.priority - b.priority || a.createdAt.getTime() - b.createdAt.getTime());
  }

  async getConnection(projectId: string, id: string): Promise<Connection | undefined> {
    const connection = this.connections.get(id);
    return connection?.projectId === projectId ? connection : undefined;
  }

  async findConnectionByInboundToken(token: string): Promise<Connection | undefined> {
    return [...this.connections.values()].find((c) => c.inboundToken === token);
  }

  async updateConnection(projectId: string, id: string, changes: Partial<Pick<Connection, 'name' | 'settings' | 'secrets' | 'priority'>>): Promise<void> {
    const connection = await this.getConnection(projectId, id);
    if (connection) this.connections.set(id, { ...connection, ...changes });
  }

  async deleteConnection(projectId: string, id: string): Promise<boolean> {
    if (!(await this.getConnection(projectId, id))) return false;
    return this.connections.delete(id);
  }

  async suppress(projectId: string, address: string, reason: SuppressionReason): Promise<void> {
    const key = `${projectId}|${address.toLowerCase()}`;
    if (!this.suppressions.has(key)) this.suppressions.set(key, { projectId, address: address.toLowerCase(), reason, createdAt: new Date() });
  }

  async suppressed(projectId: string, addresses: string[]): Promise<Set<string>> {
    return new Set(addresses.map((a) => a.toLowerCase()).filter((a) => this.suppressions.has(`${projectId}|${a}`)));
  }

  async listSuppressions(projectId: string, limit: number): Promise<Suppression[]> {
    return [...this.suppressions.values()]
      .filter((s) => s.projectId === projectId)
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async unsuppress(projectId: string, address: string): Promise<boolean> {
    return this.suppressions.delete(`${projectId}|${address.toLowerCase()}`);
  }

  async createDomain(domain: SendingDomain): Promise<void> {
    this.domains.set(domain.id, domain);
  }

  async listDomains(projectId: string): Promise<SendingDomain[]> {
    return [...this.domains.values()].filter((d) => d.projectId === projectId).sort((a, b) => a.domain.localeCompare(b.domain));
  }

  async getDomain(projectId: string, id: string): Promise<SendingDomain | undefined> {
    const domain = this.domains.get(id);
    return domain?.projectId === projectId ? domain : undefined;
  }

  async updateDomain(projectId: string, id: string, changes: Partial<Pick<SendingDomain, 'checks' | 'verifiedAt' | 'lastCheckedAt'>>): Promise<void> {
    const domain = await this.getDomain(projectId, id);
    if (domain) this.domains.set(id, { ...domain, ...changes });
  }

  async deleteDomain(projectId: string, id: string): Promise<boolean> {
    if (!(await this.getDomain(projectId, id))) return false;
    return this.domains.delete(id);
  }

  async listSealed(): Promise<SealedValue[]> {
    return [
      ...[...this.connections.values()].map((c) => ({ kind: 'connection' as const, projectId: c.projectId, id: c.id, value: c.secrets })),
      ...[...this.domains.values()].map((d) => ({ kind: 'domain' as const, projectId: d.projectId, id: d.id, value: d.dkimPrivateKey })),
    ];
  }

  async updateSealed(item: SealedValue, value: string): Promise<void> {
    if (item.kind === 'connection') {
      const connection = this.connections.get(item.id);
      if (connection?.projectId === item.projectId) this.connections.set(item.id, { ...connection, secrets: value });
    } else {
      const domain = this.domains.get(item.id);
      if (domain?.projectId === item.projectId) this.domains.set(item.id, { ...domain, dkimPrivateKey: value });
    }
  }

  async findMessage(id: string): Promise<SimMessage | undefined> {
    return this.messages.get(id);
  }

  async setDelivery(projectId: string, messageId: string, delivery: NonNullable<SimMessage['delivery']>): Promise<void> {
    const message = this.messages.get(messageId);
    if (message?.projectId === projectId) this.messages.set(messageId, { ...message, delivery });
  }

  async createPasswordReset(reset: PasswordReset): Promise<void> {
    this.resets.set(reset.tokenHash, reset);
  }

  async setTwoFactor(userId: string, state: TwoFactor | null): Promise<void> {
    const user = this.users.get(userId);
    if (!user) return;
    const next = { ...user };
    if (state) next.twoFactor = structuredClone(state);
    else delete next.twoFactor;
    this.users.set(userId, next);
  }

  async usePasswordReset(tokenHash: string, purpose: TokenPurpose = 'reset'): Promise<string | undefined> {
    const reset = this.resets.get(tokenHash);
    if (!reset || (reset.purpose ?? 'reset') !== purpose) return undefined;
    this.resets.delete(tokenHash);
    return reset.expiresAt > new Date() ? reset.userId : undefined;
  }

  async incrementUsage(projectId: string, month: string): Promise<number> {
    const key = `${projectId}|${month}`;
    const count = (this.usage.get(key) ?? 0) + 1;
    this.usage.set(key, count);
    return count;
  }

  async getUsage(projectId: string, month: string): Promise<number> {
    return this.usage.get(`${projectId}|${month}`) ?? 0;
  }

  async purgeProject(projectId: string, before: Date): Promise<number> {
    let deleted = 0;
    for (const [id, message] of this.messages) {
      if (message.projectId !== projectId || message.createdAt >= before) continue;
      this.messages.delete(id);
      this.events.delete(id);
      this.contents.delete(id);
      deleted++;
    }
    keep(this.requests, (r) => r.projectId !== projectId || r.createdAt >= before);
    keep(this.inbound, (e) => e.projectId !== projectId || e.createdAt >= before);
    return deleted;
  }

  async purge(before: Date, keepProjects: string[] = []): Promise<{ messages: number }> {
    let messages = 0;
    for (const [id, message] of this.messages) {
      if (message.createdAt >= before || keepProjects.includes(message.projectId)) continue;
      this.messages.delete(id);
      this.events.delete(id);
      this.contents.delete(id);
      messages++;
    }
    for (const [id, entry] of this.idempotency) if (entry.expires <= Date.now()) this.idempotency.delete(id);
    for (const [id, invite] of this.invites) if (invite.expiresAt.getTime() <= Date.now()) this.invites.delete(id);
    for (const [id, send] of this.scheduled) {
      if (send.status !== 'pending' && send.status !== 'sending' && send.updatedAt < before) this.scheduled.delete(id);
    }
    const kept = this.webhookAttempts.filter((a) => a.createdAt >= before);
    this.webhookAttempts.splice(0, this.webhookAttempts.length, ...kept);
    keep(this.requests, (r) => r.createdAt >= before || keepProjects.includes(r.projectId));
    keep(this.inbound, (e) => e.createdAt >= before || keepProjects.includes(e.projectId));
    const yearAgo = new Date(Date.now() - 365 * 86_400_000);
    keep(this.audit, (e) => e.createdAt >= yearAgo);
    const now = new Date();
    for (const [hash, session] of this.sessions) if (session.expiresAt <= now) this.sessions.delete(hash);
    for (const [hash, reset] of this.resets) if (reset.expiresAt <= now) this.resets.delete(hash);
    for (const [key, attempt] of this.attempts) if (attempt.expires <= now.getTime()) this.attempts.delete(key);
    return { messages };
  }

  async saveMessage(message: SimMessage, raw?: Uint8Array): Promise<void> {
    this.messages.set(message.id, message);
    if (raw) this.contents.set(message.id, Buffer.from(raw));
  }

  async getContent(projectId: string, id: string): Promise<Buffer | undefined> {
    return this.messages.get(id)?.projectId === projectId ? this.contents.get(id) : undefined;
  }

  async getEvent(projectId: string, eventId: string): Promise<SimEvent | undefined> {
    for (const events of this.events.values()) {
      const event = events.find((e) => e.id === eventId);
      if (event) return event.projectId === projectId ? event : undefined;
    }
    return undefined;
  }

  async createScheduled(send: ScheduledSend): Promise<void> {
    this.scheduled.set(send.id, structuredClone(send));
  }

  async listScheduled(projectId: string, query: { mode: Mode; status?: ScheduledSend['status']; limit: number }): Promise<ScheduledSend[]> {
    return [...this.scheduled.values()]
      .filter((s) => s.projectId === projectId && s.mode === query.mode && (!query.status || s.status === query.status))
      .sort((a, b) =>
        query.status === 'pending' ? a.sendAt.getTime() - b.sendAt.getTime() : b.sendAt.getTime() - a.sendAt.getTime(),
      )
      .slice(0, query.limit)
      .map((s) => structuredClone(s));
  }

  async getScheduled(projectId: string, id: string): Promise<ScheduledSend | undefined> {
    const send = this.scheduled.get(id);
    return send?.projectId === projectId ? structuredClone(send) : undefined;
  }

  async cancelScheduled(projectId: string, id: string): Promise<boolean> {
    const send = this.scheduled.get(id);
    if (send?.projectId !== projectId || send.status !== 'pending') return false;
    send.status = 'canceled';
    send.updatedAt = new Date();
    return true;
  }

  async claimDueScheduled(now: Date, limit: number): Promise<ScheduledSend[]> {
    const stuck = now.getTime() - 10 * 60_000;
    const due = [...this.scheduled.values()]
      .filter((s) => s.sendAt <= now && (s.status === 'pending' || (s.status === 'sending' && s.updatedAt.getTime() < stuck)))
      .sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime())
      .slice(0, limit);
    for (const send of due) {
      send.status = 'sending';
      send.updatedAt = now;
    }
    return due.map((s) => structuredClone(s));
  }

  async finishScheduled(id: string, outcome: { status: 'sent' | 'failed'; messageId?: string; error?: string }): Promise<void> {
    const send = this.scheduled.get(id);
    if (send) Object.assign(send, outcome, { updatedAt: new Date() });
  }

  async createTemplate(template: Template): Promise<void> {
    if (await this.getTemplate(template.projectId, template.alias)) throw new Error('A template with this alias already exists');
    this.templates.set(template.id, structuredClone(template));
  }

  async listTemplates(projectId: string): Promise<Template[]> {
    return [...this.templates.values()].filter((t) => t.projectId === projectId).sort((a, b) => a.alias.localeCompare(b.alias));
  }

  async getTemplate(projectId: string, ref: string): Promise<Template | undefined> {
    return [...this.templates.values()].find((t) => t.projectId === projectId && (t.id === ref || t.alias === ref));
  }

  async updateTemplate(template: Template): Promise<void> {
    const current = this.templates.get(template.id);
    if (current?.projectId === template.projectId) this.templates.set(template.id, structuredClone(template));
  }

  async deleteTemplate(projectId: string, id: string): Promise<boolean> {
    if (this.templates.get(id)?.projectId !== projectId) return false;
    return this.templates.delete(id);
  }

  async claimIdempotencyKey(
    projectId: string,
    key: string,
    fingerprint: string,
    ttlMs: number,
  ): Promise<{ claimed: true } | { claimed: false; fingerprint: string; response?: unknown }> {
    const id = `${projectId}|${key}`;
    const existing = this.idempotency.get(id);
    if (existing && existing.expires > Date.now()) {
      return { claimed: false, fingerprint: existing.fingerprint, ...(existing.response !== undefined && { response: existing.response }) };
    }
    this.idempotency.set(id, { fingerprint, expires: Date.now() + ttlMs });
    return { claimed: true };
  }

  async completeIdempotencyKey(projectId: string, key: string, response: unknown): Promise<void> {
    const entry = this.idempotency.get(`${projectId}|${key}`);
    if (entry) entry.response = JSON.parse(JSON.stringify(response ?? null));
  }

  async releaseIdempotencyKey(projectId: string, key: string): Promise<void> {
    this.idempotency.delete(`${projectId}|${key}`);
  }

  async findProjectByInboundToken(token: string): Promise<Project | undefined> {
    return [...this.projects.values()].find((p) => p.inboundToken === token);
  }

  async saveInbound(email: InboundEmail): Promise<void> {
    this.inbound.push(structuredClone(email));
  }

  async listInbound(projectId: string, query: { limit: number; before?: Date }): Promise<InboundEmail[]> {
    return newest(this.inbound.filter((e) => e.projectId === projectId && (!query.before || e.createdAt < query.before)), query.limit).map((e) =>
      structuredClone(e),
    );
  }

  async getInbound(projectId: string, id: string): Promise<InboundEmail | undefined> {
    const found = this.inbound.find((e) => e.projectId === projectId && e.id === id);
    return found && structuredClone(found);
  }

  async findMessageByReference(projectId: string, ids: string[]): Promise<SimMessage | undefined> {
    const wanted = new Set(ids);
    return [...this.messages.values()]
      .filter((m) => m.projectId === projectId)
      .filter((m) => {
        const header = Object.entries(m.headers ?? {}).find(([name]) => name.toLowerCase() === 'message-id')?.[1];
        return (header && wanted.has(header)) || (m.delivery?.providerMessageId && wanted.has(m.delivery.providerMessageId));
      })
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())[0];
  }

  async addAudit(entry: AuditEntry): Promise<void> {
    this.audit.push(structuredClone(entry));
  }

  async listAudit(projectId: string, query: { limit: number; before?: Date }): Promise<AuditEntry[]> {
    return newest(this.audit.filter((e) => e.projectId === projectId && (!query.before || e.createdAt < query.before)), query.limit);
  }

  async addApiRequest(entry: ApiRequestLog): Promise<void> {
    this.requests.push({ ...entry });
  }

  async listApiRequests(projectId: string, query: { limit: number; before?: Date; failed?: boolean; keyId?: string }): Promise<ApiRequestLog[]> {
    const found = this.requests.filter(
      (r) =>
        r.projectId === projectId &&
        (!query.before || r.createdAt < query.before) &&
        (!query.failed || r.status >= 400) &&
        (!query.keyId || r.keyId === query.keyId),
    );
    return newest(found, query.limit);
  }

  async addWebhookAttempt(attempt: WebhookAttempt): Promise<void> {
    this.webhookAttempts.push({ ...attempt });
  }

  async createWebhookEndpoint(endpoint: WebhookEndpoint): Promise<void> {
    this.endpoints.push(structuredClone(endpoint));
  }

  async listWebhookEndpoints(projectId: string): Promise<WebhookEndpoint[]> {
    return this.endpoints.filter((e) => e.projectId === projectId).map((e) => structuredClone(e));
  }

  async getWebhookEndpoint(projectId: string, id: string): Promise<WebhookEndpoint | undefined> {
    const found = this.endpoints.find((e) => e.projectId === projectId && e.id === id);
    return found && structuredClone(found);
  }

  async updateWebhookEndpoint(projectId: string, id: string, changes: WebhookEndpointChanges): Promise<void> {
    const found = this.endpoints.find((e) => e.projectId === projectId && e.id === id);
    if (!found) return;
    for (const [key, value] of Object.entries(changes)) {
      if (value === undefined) continue;
      if (value === null) delete (found as unknown as Record<string, unknown>)[key];
      else (found as unknown as Record<string, unknown>)[key] = structuredClone(value);
    }
  }

  async deleteWebhookEndpoint(projectId: string, id: string): Promise<boolean> {
    const before = this.endpoints.length;
    keep(this.endpoints, (e) => !(e.projectId === projectId && e.id === id));
    return this.endpoints.length < before;
  }

  async listWebhookAttempts(projectId: string, query: AttemptQuery): Promise<WebhookAttempt[]> {
    return this.webhookAttempts
      .filter(
        (a) =>
          a.projectId === projectId &&
          (!query.before || a.createdAt < query.before) &&
          (!query.since || a.createdAt >= query.since) &&
          (query.endpointId === undefined || (a.endpointId ?? null) === query.endpointId) &&
          (!query.failed || !a.ok) &&
          (!query.eventId || a.eventId === query.eventId),
      )
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, query.limit);
  }

  async getWebhookAttempt(projectId: string, id: string): Promise<WebhookAttempt | undefined> {
    return this.webhookAttempts.find((a) => a.id === id && a.projectId === projectId);
  }

  async webhookStats(projectId: string, since: Date): Promise<{ ok: number; failed: number }> {
    const recent = this.webhookAttempts.filter((a) => a.projectId === projectId && a.createdAt >= since);
    return { ok: recent.filter((a) => a.ok).length, failed: recent.filter((a) => !a.ok).length };
  }

  async getMessage(projectId: string, id: string): Promise<MessageWithEvents | undefined> {
    const message = this.messages.get(id);
    if (!message || message.projectId !== projectId) return undefined;
    return { ...message, events: this.eventsOf(id) };
  }

  async listMessages(projectId: string, { limit, before, search, status, channel, mode = 'test' }: MessageQuery): Promise<MessageListItem[]> {
    const needle = search?.trim().toLowerCase();
    return [...this.messages.values()]
      .filter((m) => (m.mode ?? 'test') === mode && (!channel || (m.channel ?? 'email') === channel))
      .filter((m) => m.projectId === projectId && (!before || m.createdAt < before))
      .filter(
        (m) =>
          !needle ||
          [m.subject, m.from, m.body ?? '', ...m.recipients.map((r) => r.address)].some((v) => v.toLowerCase().includes(needle)),
      )
      .filter((m) => !status || this.eventsOf(m.id).some((e) => e.type === status))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit)
      .map((m) => {
        const first = m.recipients[0]?.address;
        const latest = this.eventsOf(m.id).filter((e) => e.recipient === first).at(-1);
        if (!latest) return m;
        const bounceType = (latest as { bounceType?: 'hard' | 'soft' | 'block' }).bounceType;
        return { ...m, latest: { type: latest.type, ...(bounceType && { bounceType }) } };
      });
  }

  async addEvent(event: SimEvent): Promise<void> {
    const key = event.providerMessageId ?? '';
    const existing = this.events.get(key) ?? [];
    if (existing.some((e) => e.id === event.id)) return; // idempotent, like the PostgreSQL store
    this.events.set(key, [...existing, event]);
  }

  async stats(projectId: string, since: Date, mode: Mode = 'test'): Promise<ProjectStats> {
    const stats = emptyStats(since);
    const days = new Map(stats.daily.map((d) => [d.date, d]));
    for (const message of this.messages.values()) {
      if (message.projectId !== projectId || message.createdAt < since || (message.mode ?? 'test') !== mode) continue;
      stats.messages++;
      for (const event of this.eventsOf(message.id)) {
        stats.events[event.type] = (stats.events[event.type] ?? 0) + 1;
        const bounceType = (event as { bounceType?: keyof ProjectStats['bounces'] }).bounceType;
        if (event.type === 'bounced' && bounceType) stats.bounces[bounceType]++;
        const day = days.get(event.timestamp.toISOString().slice(0, 10));
        if (day && (event.type === 'delivered' || event.type === 'bounced' || event.type === 'deferred' || event.type === 'complained')) {
          day[event.type]++;
        }
      }
    }
    return stats;
  }

  async deliverability(
    projectId: string,
    query: { since: Date; mode: Mode; by: 'domain' | 'template' | 'tag'; limit: number },
  ): Promise<Array<{ key: string; counts: Partial<Record<SimEvent['type'], number>> }>> {
    const groups = new Map<string, Map<SimEvent['type'], Set<string>>>();
    for (const message of this.messages.values()) {
      if (message.projectId !== projectId || (message.mode ?? 'test') !== query.mode) continue;
      if (query.by === 'domain' && message.channel === 'sms') continue;
      for (const event of this.eventsOf(message.id)) {
        if (event.timestamp < query.since) continue;
        const recipient = event.recipient.toLowerCase();
        const keys =
          query.by === 'domain' ? [recipient.split('@')[1] ?? ''] : query.by === 'template' ? [message.template ?? ''] : (message.tags ?? []);
        for (const key of keys) {
          if (!key) continue;
          const types = groups.get(key) ?? new Map<SimEvent['type'], Set<string>>();
          groups.set(key, types);
          const seen = types.get(event.type) ?? new Set<string>();
          types.set(event.type, seen);
          seen.add(`${message.id}|${recipient}`);
        }
      }
    }
    return [...groups.entries()]
      .map(([key, types]) => ({ key, counts: Object.fromEntries([...types].map(([type, seen]) => [type, seen.size])) }))
      .sort((a, b) => (b.counts.accepted ?? 0) - (a.counts.accepted ?? 0))
      .slice(0, query.limit);
  }

  async nextAttempt(key: string, ttlMs: number): Promise<number> {
    const now = Date.now();
    const current = this.attempts.get(key);
    const count = current && current.expires > now ? current.count + 1 : 1;
    this.attempts.set(key, { count, expires: now + ttlMs });
    return count;
  }

  private eventsOf(messageId: string): SimEvent[] {
    return [...(this.events.get(messageId) ?? [])].sort(
      (a, b) => a.timestamp.getTime() - b.timestamp.getTime() || a.id.localeCompare(b.id),
    );
  }
}

/** Keeps, in place, the items that pass. */
function keep<T>(list: T[], test: (item: T) => boolean): void {
  list.splice(0, list.length, ...list.filter(test));
}

function newest<T extends { createdAt: Date }>(list: T[], limit: number): T[] {
  return [...list].sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime()).slice(0, limit);
}
