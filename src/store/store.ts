import type { MessageWithEvents, Project, SimEvent, SimMessage } from '../domain.js';

export const SIM_STORE = Symbol.for('relayo-sim:store');

/** Persistence for projects, messages and their event timelines. */
export interface SimStore {
  createProject(project: Project): Promise<void>;
  findProjectByApiKeyHash(hash: string): Promise<Project | undefined>;
  getProject(id: string): Promise<Project | undefined>;
  updateProject(id: string, changes: Partial<Pick<Project, 'name' | 'webhookUrl'>>): Promise<void>;

  saveMessage(message: SimMessage): Promise<void>;
  getMessage(projectId: string, id: string): Promise<MessageWithEvents | undefined>;
  /** Newest first. */
  listMessages(projectId: string, options: { limit: number; before?: Date }): Promise<SimMessage[]>;
  addEvent(event: SimEvent): Promise<void>;

  /** Counts SMTP delivery attempts for a key (greylisting). Returns the attempt number, starting at 1. */
  nextAttempt(key: string, ttlMs: number): Promise<number>;

  close?(): Promise<void>;
}
