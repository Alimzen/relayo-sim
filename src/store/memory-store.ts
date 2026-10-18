import type { ApiKey, MessageListItem, MessageWithEvents, Project, ProjectStats, Session, SimEvent, SimMessage, User } from '../domain.js';
import { emptyStats } from './stats.js';
import type { MessageQuery, ProjectChanges, SimStore } from './store.js';

/** In-process store for tests and local runs without a database. Nothing survives a restart. */
export class MemoryStore implements SimStore {
  private readonly users = new Map<string, User>();
  private readonly sessions = new Map<string, Session>();
  private readonly projects = new Map<string, Project>();
  private readonly keys = new Map<string, ApiKey>();
  private readonly messages = new Map<string, SimMessage>();
  private readonly events = new Map<string, SimEvent[]>();
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

  async updateUser(id: string, changes: Partial<Pick<User, 'name' | 'passwordHash'>>): Promise<void> {
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

  async saveMessage(message: SimMessage): Promise<void> {
    this.messages.set(message.id, message);
  }

  async getMessage(projectId: string, id: string): Promise<MessageWithEvents | undefined> {
    const message = this.messages.get(id);
    if (!message || message.projectId !== projectId) return undefined;
    return { ...message, events: this.eventsOf(id) };
  }

  async listMessages(projectId: string, { limit, before, search, status }: MessageQuery): Promise<MessageListItem[]> {
    const needle = search?.trim().toLowerCase();
    return [...this.messages.values()]
      .filter((m) => m.projectId === projectId && (!before || m.createdAt < before))
      .filter(
        (m) =>
          !needle ||
          [m.subject, m.from, ...m.recipients.map((r) => r.address)].some((v) => v.toLowerCase().includes(needle)),
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

  async stats(projectId: string, since: Date): Promise<ProjectStats> {
    const stats = emptyStats(since);
    const days = new Map(stats.daily.map((d) => [d.date, d]));
    for (const message of this.messages.values()) {
      if (message.projectId !== projectId || message.createdAt < since) continue;
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
