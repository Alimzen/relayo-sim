import type { MessageWithEvents, Project, SimEvent, SimMessage } from '../domain.js';

export interface ProjectChanges {
  name?: string;
  webhookUrl?: string | null;
  reportsSmtpUrl?: string | null;
}

export const SIM_STORE = Symbol.for('relayo-sim:store');

/** Persistence for projects, messages and their event timelines. */
export interface SimStore {
  createProject(project: Project): Promise<void>;
  findProjectByApiKeyHash(hash: string): Promise<Project | undefined>;
  getProject(id: string): Promise<Project | undefined>;
  /** `null` clears an optional field; missing keys are left as they are. */
  updateProject(id: string, changes: ProjectChanges): Promise<void>;

  saveMessage(message: SimMessage): Promise<void>;
  getMessage(projectId: string, id: string): Promise<MessageWithEvents | undefined>;
  /** Newest first. */
  listMessages(projectId: string, options: { limit: number; before?: Date }): Promise<SimMessage[]>;
  addEvent(event: SimEvent): Promise<void>;

  /** Counts SMTP delivery attempts for a key (greylisting). Returns the attempt number, starting at 1. */
  nextAttempt(key: string, ttlMs: number): Promise<number>;

  close?(): Promise<void>;
}
