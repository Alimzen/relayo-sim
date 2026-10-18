import type { MessageWithEvents, Project, SimEvent, SimMessage } from '../domain.js';
import type { SimStore } from './store.js';

/** In-process store for tests and local runs without a database. Nothing survives a restart. */
export class MemoryStore implements SimStore {
  private readonly projects = new Map<string, Project>();
  private readonly messages = new Map<string, SimMessage>();
  private readonly events = new Map<string, SimEvent[]>();
  private readonly attempts = new Map<string, { count: number; expires: number }>();

  async createProject(project: Project): Promise<void> {
    this.projects.set(project.id, { ...project });
  }

  async findProjectByApiKeyHash(hash: string): Promise<Project | undefined> {
    return [...this.projects.values()].find((p) => p.apiKeyHash === hash);
  }

  async getProject(id: string): Promise<Project | undefined> {
    return this.projects.get(id);
  }

  async updateProject(id: string, changes: Partial<Pick<Project, 'name' | 'webhookUrl'>>): Promise<void> {
    const project = this.projects.get(id);
    if (project) this.projects.set(id, { ...project, ...changes });
  }

  async saveMessage(message: SimMessage): Promise<void> {
    this.messages.set(message.id, message);
  }

  async getMessage(projectId: string, id: string): Promise<MessageWithEvents | undefined> {
    const message = this.messages.get(id);
    if (!message || message.projectId !== projectId) return undefined;
    const events = [...(this.events.get(id) ?? [])].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
    return { ...message, events };
  }

  async listMessages(projectId: string, { limit, before }: { limit: number; before?: Date }): Promise<SimMessage[]> {
    return [...this.messages.values()]
      .filter((m) => m.projectId === projectId && (!before || m.createdAt < before))
      .sort((a, b) => b.createdAt.getTime() - a.createdAt.getTime())
      .slice(0, limit);
  }

  async addEvent(event: SimEvent): Promise<void> {
    const key = event.providerMessageId ?? '';
    const existing = this.events.get(key) ?? [];
    if (existing.some((e) => e.id === event.id)) return; // idempotent, like the PostgreSQL store
    this.events.set(key, [...existing, event]);
  }

  async nextAttempt(key: string, ttlMs: number): Promise<number> {
    const now = Date.now();
    const current = this.attempts.get(key);
    const count = current && current.expires > now ? current.count + 1 : 1;
    this.attempts.set(key, { count, expires: now + ttlMs });
    return count;
  }
}
