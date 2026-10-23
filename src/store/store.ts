import type { ManagedAccess, ApiKey, SendingDomain, Connection, Mode, Suppression, SuppressionReason, MessageListItem, PasswordReset, MessageWithEvents, Project, ProjectStats, Session, SimEvent, SimMessage, User } from '../domain.js';

export interface ProjectChanges {
  name?: string;
  webhookUrl?: string | null;
  reportsSmtpUrl?: string | null;
  webhookSecret?: string;
  ownerId?: string;
  managedAccess?: ManagedAccess | null;
}

export interface MessageQuery {
  limit: number;
  before?: Date;
  /** Matches subject, sender and recipients, case-insensitively. */
  search?: string;
  /** Only messages with at least one event of this type. */
  status?: SimEvent['type'];
  channel?: 'email' | 'sms';
  /** Test or live messages; test when absent. */
  mode?: Mode;
}

export const SIM_STORE = Symbol.for('relayo-sim:store');

/** Persistence for accounts, projects, messages and their event timelines. */
export interface SimStore {
  // Accounts
  createUser(user: User): Promise<void>;
  findUserByEmail(email: string): Promise<User | undefined>;
  getUser(id: string): Promise<User | undefined>;
  updateUser(id: string, changes: Partial<Pick<User, 'name' | 'passwordHash' | 'emailVerifiedAt'>>): Promise<void>;
  createSession(session: Session): Promise<void>;
  /** The session with this token hash, if it has not expired. */
  getSession(idHash: string): Promise<Session | undefined>;
  deleteSession(idHash: string): Promise<void>;
  /** Ends every session of a user except, optionally, one (e.g. after a password change). */
  deleteUserSessions(userId: string, except?: string): Promise<void>;
  createPasswordReset(reset: PasswordReset): Promise<void>;
  /**
   * Consumes an emailed token of a purpose (password reset by default): returns its user if it exists and has
   * not expired, and deletes it either way.
   */
  usePasswordReset(tokenHash: string, purpose?: 'reset' | 'verify'): Promise<string | undefined>;

  // Projects and keys
  createProject(project: Project): Promise<void>;
  getProject(id: string): Promise<Project | undefined>;
  listProjects(ownerId: string): Promise<Project[]>;
  /** Projects that asked for Relayo's own sending (whatever the answer), newest first. */
  listManagedAccess(): Promise<Project[]>;
  /** `null` clears an optional field; missing keys are left as they are. */
  updateProject(id: string, changes: ProjectChanges): Promise<void>;
  createApiKey(key: ApiKey): Promise<void>;
  /** Active and revoked keys of a project, newest first. */
  listApiKeys(projectId: string): Promise<ApiKey[]>;
  revokeApiKey(projectId: string, id: string): Promise<boolean>;
  /** The project of an active key. */
  findProjectByApiKeyHash(hash: string): Promise<{ project: Project; key: ApiKey } | undefined>;
  touchApiKey(id: string, at: Date): Promise<void>;

  // Live delivery
  createConnection(connection: Connection): Promise<void>;
  /** The project's connections, by priority. */
  listConnections(projectId: string, channel?: 'email' | 'sms'): Promise<Connection[]>;
  getConnection(projectId: string, id: string): Promise<Connection | undefined>;
  findConnectionByInboundToken(token: string): Promise<Connection | undefined>;
  updateConnection(projectId: string, id: string, changes: Partial<Pick<Connection, 'name' | 'settings' | 'secrets' | 'priority'>>): Promise<void>;
  deleteConnection(projectId: string, id: string): Promise<boolean>;
  /** Adds a suppression; the first reason is kept. */
  suppress(projectId: string, address: string, reason: SuppressionReason): Promise<void>;
  /** Which of these addresses are suppressed (lowercased). */
  suppressed(projectId: string, addresses: string[]): Promise<Set<string>>;
  listSuppressions(projectId: string, limit: number): Promise<Suppression[]>;
  unsuppress(projectId: string, address: string): Promise<boolean>;
  createDomain(domain: SendingDomain): Promise<void>;
  listDomains(projectId: string): Promise<SendingDomain[]>;
  getDomain(projectId: string, id: string): Promise<SendingDomain | undefined>;
  updateDomain(projectId: string, id: string, changes: Partial<Pick<SendingDomain, 'checks' | 'verifiedAt' | 'lastCheckedAt'>>): Promise<void>;
  deleteDomain(projectId: string, id: string): Promise<boolean>;
  /** A message by its id alone, whatever project it belongs to (events of Relayo's managed sending). */
  findMessage(id: string): Promise<SimMessage | undefined>;
  /** Records which connection delivered a live message, and the provider's id for it. */
  setDelivery(projectId: string, messageId: string, delivery: NonNullable<SimMessage['delivery']>): Promise<void>;

  // Messages
  /** Stores a message and, when given, its raw MIME source (the captured email). */
  saveMessage(message: SimMessage, raw?: Uint8Array): Promise<void>;
  /** The raw MIME source of a captured message. */
  getContent(projectId: string, id: string): Promise<Buffer | undefined>;
  getMessage(projectId: string, id: string): Promise<MessageWithEvents | undefined>;
  /** Newest first, each with the latest event of its first recipient. */
  listMessages(projectId: string, query: MessageQuery): Promise<MessageListItem[]>;
  addEvent(event: SimEvent): Promise<void>;
  stats(projectId: string, since: Date, mode?: Mode): Promise<ProjectStats>;

  /** Adds one message to a project's usage for a month (`2026-10`) and returns the new total. */
  incrementUsage(projectId: string, month: string): Promise<number>;
  getUsage(projectId: string, month: string): Promise<number>;

  /** Deletes messages created before a date (with their events and content) and expired sessions, tokens and counters. */
  purge(before: Date): Promise<{ messages: number }>;

  /** Counts SMTP delivery attempts for a key (greylisting). Returns the attempt number, starting at 1. */
  nextAttempt(key: string, ttlMs: number): Promise<number>;

  close?(): Promise<void>;
}
