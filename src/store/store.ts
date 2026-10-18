import type { ApiKey, MessageListItem, MessageWithEvents, Project, ProjectStats, Session, SimEvent, SimMessage, User } from '../domain.js';

export interface ProjectChanges {
  name?: string;
  webhookUrl?: string | null;
  reportsSmtpUrl?: string | null;
  webhookSecret?: string;
  ownerId?: string;
}

export interface MessageQuery {
  limit: number;
  before?: Date;
  /** Matches subject, sender and recipients, case-insensitively. */
  search?: string;
  /** Only messages with at least one event of this type. */
  status?: SimEvent['type'];
}

export const SIM_STORE = Symbol.for('relayo-sim:store');

/** Persistence for accounts, projects, messages and their event timelines. */
export interface SimStore {
  // Accounts
  createUser(user: User): Promise<void>;
  findUserByEmail(email: string): Promise<User | undefined>;
  getUser(id: string): Promise<User | undefined>;
  updateUser(id: string, changes: Partial<Pick<User, 'name' | 'passwordHash'>>): Promise<void>;
  createSession(session: Session): Promise<void>;
  /** The session with this token hash, if it has not expired. */
  getSession(idHash: string): Promise<Session | undefined>;
  deleteSession(idHash: string): Promise<void>;
  /** Ends every session of a user except, optionally, one (e.g. after a password change). */
  deleteUserSessions(userId: string, except?: string): Promise<void>;

  // Projects and keys
  createProject(project: Project): Promise<void>;
  getProject(id: string): Promise<Project | undefined>;
  listProjects(ownerId: string): Promise<Project[]>;
  /** `null` clears an optional field; missing keys are left as they are. */
  updateProject(id: string, changes: ProjectChanges): Promise<void>;
  createApiKey(key: ApiKey): Promise<void>;
  /** Active and revoked keys of a project, newest first. */
  listApiKeys(projectId: string): Promise<ApiKey[]>;
  revokeApiKey(projectId: string, id: string): Promise<boolean>;
  /** The project of an active key. */
  findProjectByApiKeyHash(hash: string): Promise<{ project: Project; key: ApiKey } | undefined>;
  touchApiKey(id: string, at: Date): Promise<void>;

  // Messages
  saveMessage(message: SimMessage): Promise<void>;
  getMessage(projectId: string, id: string): Promise<MessageWithEvents | undefined>;
  /** Newest first, each with the latest event of its first recipient. */
  listMessages(projectId: string, query: MessageQuery): Promise<MessageListItem[]>;
  addEvent(event: SimEvent): Promise<void>;
  stats(projectId: string, since: Date): Promise<ProjectStats>;

  /** Counts SMTP delivery attempts for a key (greylisting). Returns the attempt number, starting at 1. */
  nextAttempt(key: string, ttlMs: number): Promise<number>;

  close?(): Promise<void>;
}
