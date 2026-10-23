import type { WebhookAttempt, ApiKey, MessageListItem, MessageWithEvents, Project, ProjectStats, Session, SimEvent, SimMessage, User, PasswordReset, Connection, Mode, Suppression, SuppressionReason, SendingDomain } from '../domain.js';
import { emptyStats } from './stats.js';
import type { MessageQuery, ProjectChanges, SealedValue, SimStore } from './store.js';

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
    this.projects.set(id, next);
  }

  async createApiKey(key: ApiKey): Promise<void> {
    this.keys.set(key.id, { ...key });
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

  async usePasswordReset(tokenHash: string, purpose: 'reset' | 'verify' = 'reset'): Promise<string | undefined> {
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

  async purge(before: Date): Promise<{ messages: number }> {
    let messages = 0;
    for (const [id, message] of this.messages) {
      if (message.createdAt >= before) continue;
      this.messages.delete(id);
      this.events.delete(id);
      this.contents.delete(id);
      messages++;
    }
    const kept = this.webhookAttempts.filter((a) => a.createdAt >= before);
    this.webhookAttempts.splice(0, this.webhookAttempts.length, ...kept);
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

  async addWebhookAttempt(attempt: WebhookAttempt): Promise<void> {
    this.webhookAttempts.push({ ...attempt });
  }

  async listWebhookAttempts(projectId: string, query: { limit: number; before?: Date; failed?: boolean; eventId?: string }): Promise<WebhookAttempt[]> {
    return this.webhookAttempts
      .filter(
        (a) =>
          a.projectId === projectId &&
          (!query.before || a.createdAt < query.before) &&
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
