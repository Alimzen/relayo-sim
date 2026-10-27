import type { ProjectInvite, ProjectMember, ProjectRole, ScheduledSend, Template, WebhookAttempt, ManagedAccess, ApiKey, SendingDomain, Connection, Mode, Suppression, SuppressionReason, MessageListItem, PasswordReset, MessageWithEvents, Project, ProjectStats, Session, SimEvent, SimMessage, User } from '../domain.js';

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

/** An encrypted value in the store: a connection's credentials or a domain's DKIM private key. */
export interface SealedValue {
  kind: 'connection' | 'domain';
  projectId: string;
  id: string;
  value: string;
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
  /** Projects a user owns or is a member of, with their role, oldest first. */
  listProjectsFor(userId: string): Promise<Array<{ project: Project; role: ProjectRole }>>;

  // Teams
  addMember(member: ProjectMember): Promise<void>;
  getMember(projectId: string, userId: string): Promise<ProjectMember | undefined>;
  /** Oldest first. */
  listMembers(projectId: string): Promise<ProjectMember[]>;
  updateMemberRole(projectId: string, userId: string, role: ProjectMember['role']): Promise<boolean>;
  removeMember(projectId: string, userId: string): Promise<boolean>;
  createInvite(invite: ProjectInvite): Promise<void>;
  /** Invitations that have not expired, newest first. */
  listInvites(projectId: string): Promise<ProjectInvite[]>;
  /** The invitation of a token, if it has not expired. */
  findInvite(tokenHash: string): Promise<ProjectInvite | undefined>;
  deleteInvite(projectId: string, id: string): Promise<boolean>;
  /** Projects that asked for Relayo's own sending (whatever the answer), newest first. */
  listManagedAccess(): Promise<Project[]>;
  /** `null` clears an optional field; missing keys are left as they are. */
  updateProject(id: string, changes: ProjectChanges): Promise<void>;
  /** Deletes a project with everything in it: messages, keys, connections, templates, members... */
  deleteProject(id: string): Promise<void>;
  /** Deletes an account, its sessions and memberships, and the projects it owns (with everything in them). */
  deleteUser(id: string): Promise<void>;
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
  /** Every encrypted value, to seal them again after SECRETS_KEY changes. */
  listSealed(): Promise<SealedValue[]>;
  updateSealed(item: SealedValue, value: string): Promise<void>;
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
  getEvent(projectId: string, eventId: string): Promise<SimEvent | undefined>;

  // Scheduled sends
  createScheduled(send: ScheduledSend): Promise<void>;
  /** Soonest first for pending ones, newest first otherwise. */
  listScheduled(projectId: string, query: { mode: Mode; status?: ScheduledSend['status']; limit: number }): Promise<ScheduledSend[]>;
  getScheduled(projectId: string, id: string): Promise<ScheduledSend | undefined>;
  /** Cancels a pending send; false when it is not pending (already sent, sending or canceled). */
  cancelScheduled(projectId: string, id: string): Promise<boolean>;
  /**
   * Takes the sends whose time has come (pending, or stuck in `sending` for 10 minutes after a crash) and
   * marks them `sending`, atomically: two servers never take the same one.
   */
  claimDueScheduled(now: Date, limit: number): Promise<ScheduledSend[]>;
  finishScheduled(id: string, outcome: { status: 'sent' | 'failed'; messageId?: string; error?: string }): Promise<void>;

  // Templates
  createTemplate(template: Template): Promise<void>;
  /** Ordered by alias. */
  listTemplates(projectId: string): Promise<Template[]>;
  /** By id or alias. */
  getTemplate(projectId: string, ref: string): Promise<Template | undefined>;
  updateTemplate(template: Template): Promise<void>;
  deleteTemplate(projectId: string, id: string): Promise<boolean>;

  // Idempotency keys
  /**
   * Takes a key for a request, or says how it was used: by a request with this fingerprint or another, and
   * its answer once it finished. Expired keys can be taken again.
   */
  claimIdempotencyKey(
    projectId: string,
    key: string,
    fingerprint: string,
    ttlMs: number,
  ): Promise<{ claimed: true } | { claimed: false; fingerprint: string; response?: unknown }>;
  completeIdempotencyKey(projectId: string, key: string, response: unknown): Promise<void>;
  /** Frees a key whose request failed, so it can be retried. */
  releaseIdempotencyKey(projectId: string, key: string): Promise<void>;

  // Webhook delivery log
  addWebhookAttempt(attempt: WebhookAttempt): Promise<void>;
  /** Newest first. `failed`: only attempts that did not get a 2xx. */
  listWebhookAttempts(projectId: string, query: { limit: number; before?: Date; failed?: boolean; eventId?: string }): Promise<WebhookAttempt[]>;
  getWebhookAttempt(projectId: string, id: string): Promise<WebhookAttempt | undefined>;
  /** Attempts since a date: how many got a 2xx and how many did not. */
  webhookStats(projectId: string, since: Date): Promise<{ ok: number; failed: number }>;
  stats(projectId: string, since: Date, mode?: Mode): Promise<ProjectStats>;

  /** Adds one message to a project's usage for a month (`2026-10`) and returns the new total. */
  incrementUsage(projectId: string, month: string): Promise<number>;
  getUsage(projectId: string, month: string): Promise<number>;

  /**
   * Deletes messages created before a date (with their events and content), webhook attempts older than it,
   * and expired sessions, tokens and counters.
   */
  purge(before: Date): Promise<{ messages: number }>;

  /** Answers when the database does (health checks). In-memory stores leave it out. */
  ping?(): Promise<void>;

  /** Counts SMTP delivery attempts for a key (greylisting). Returns the attempt number, starting at 1. */
  nextAttempt(key: string, ttlMs: number): Promise<number>;

  close?(): Promise<void>;
}
