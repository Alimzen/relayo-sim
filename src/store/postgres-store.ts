import pg from 'pg';
import type { InboundEmail, ProjectOptions, WebhookEndpoint, AuditEntry, AuditActor, ApiRequestLog, ProjectLimits, KeyPermission, TokenPurpose, TwoFactor, ProjectInvite, ProjectMember, ProjectRole, ScheduledSend, Template, WebhookAttempt, ManagedAccess, ApiKey, MessageListItem, MessageWithEvents, Project, ProjectStats, Session, SimEvent, SimMessage, User, PasswordReset, Connection, Mode, Suppression, SuppressionReason, SendingDomain } from '../domain.js';
import { emptyStats } from './stats.js';
import type { MessageQuery, ProjectChanges, SealedValue, SimStore, AttemptQuery, WebhookEndpointChanges } from './store.js';

/** Idempotent: safe to run on every start, on new and existing databases. */
const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  id text PRIMARY KEY,
  email text NOT NULL UNIQUE,
  name text NOT NULL,
  password_hash text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE TABLE IF NOT EXISTS sessions (
  id_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS sessions_user ON sessions (user_id);
CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  api_key_hash text UNIQUE,
  webhook_url text,
  webhook_secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
ALTER TABLE projects ADD COLUMN IF NOT EXISTS reports_smtp_url text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS managed_access text;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS limits jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS options jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS inbound_token text;
CREATE UNIQUE INDEX IF NOT EXISTS projects_inbound_token ON projects (inbound_token) WHERE inbound_token IS NOT NULL;
-- Accounts created before email verification existed count as verified (the default fills them once).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz DEFAULT now();
ALTER TABLE users ALTER COLUMN email_verified_at DROP DEFAULT;
ALTER TABLE users ADD COLUMN IF NOT EXISTS two_factor jsonb;
ALTER TABLE projects ADD COLUMN IF NOT EXISTS owner_id text REFERENCES users(id) ON DELETE CASCADE;
ALTER TABLE projects ALTER COLUMN api_key_hash DROP NOT NULL;
CREATE INDEX IF NOT EXISTS projects_owner ON projects (owner_id);
CREATE TABLE IF NOT EXISTS api_keys (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  prefix text NOT NULL,
  key_hash text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz,
  revoked_at timestamptz
);
CREATE INDEX IF NOT EXISTS api_keys_project ON api_keys (project_id);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'test';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS permission text NOT NULL DEFAULT 'full';
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS allowed_domains jsonb;
-- Keys created before api_keys existed lived on the project row.
INSERT INTO api_keys (id, project_id, name, prefix, key_hash, created_at)
  SELECT 'key_' || md5(p.api_key_hash), p.id, 'Default', 'sim_live_', p.api_key_hash, p.created_at
  FROM projects p
  WHERE p.api_key_hash IS NOT NULL AND NOT EXISTS (SELECT 1 FROM api_keys k WHERE k.key_hash = p.api_key_hash);
CREATE TABLE IF NOT EXISTS messages (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  via text NOT NULL,
  relayo_message_id text,
  from_address text NOT NULL,
  recipients jsonb NOT NULL,
  subject text NOT NULL,
  metadata jsonb,
  tags jsonb,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS messages_project_created ON messages (project_id, created_at DESC);
ALTER TABLE messages ADD COLUMN IF NOT EXISTS envelope_from text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS headers jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS size integer;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS channel text NOT NULL DEFAULT 'email';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS body text;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'test';
ALTER TABLE messages ADD COLUMN IF NOT EXISTS delivery jsonb;
ALTER TABLE messages ADD COLUMN IF NOT EXISTS template text;
CREATE INDEX IF NOT EXISTS messages_project_mode_created ON messages (project_id, mode, created_at DESC);
CREATE TABLE IF NOT EXISTS connections (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name text NOT NULL,
  channel text NOT NULL,
  provider text NOT NULL,
  settings jsonb NOT NULL,
  secrets text NOT NULL,
  priority integer NOT NULL,
  inbound_token text NOT NULL UNIQUE,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS connections_project ON connections (project_id, channel, priority);
CREATE TABLE IF NOT EXISTS sending_domains (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  domain text NOT NULL,
  selector text NOT NULL,
  dkim_public_key text NOT NULL,
  dkim_private_key text NOT NULL,
  checks jsonb NOT NULL,
  verified_at timestamptz,
  last_checked_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (project_id, domain)
);
CREATE TABLE IF NOT EXISTS suppressions (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  address text NOT NULL,
  reason text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, address)
);
CREATE TABLE IF NOT EXISTS message_contents (
  message_id text PRIMARY KEY REFERENCES messages(id) ON DELETE CASCADE,
  raw bytea NOT NULL
);
CREATE TABLE IF NOT EXISTS events (
  id text PRIMARY KEY,
  message_id text NOT NULL REFERENCES messages(id) ON DELETE CASCADE,
  project_id text NOT NULL,
  type text NOT NULL,
  recipient text NOT NULL,
  occurred_at timestamptz NOT NULL,
  body jsonb NOT NULL
);
CREATE INDEX IF NOT EXISTS events_message ON events (message_id, occurred_at);
CREATE INDEX IF NOT EXISTS events_project_time ON events (project_id, occurred_at);
CREATE TABLE IF NOT EXISTS password_resets (
  token_hash text PRIMARY KEY,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires_at timestamptz NOT NULL
);
ALTER TABLE password_resets ADD COLUMN IF NOT EXISTS purpose text NOT NULL DEFAULT 'reset';
CREATE TABLE IF NOT EXISTS usage (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  month text NOT NULL,
  messages integer NOT NULL,
  PRIMARY KEY (project_id, month)
);
CREATE INDEX IF NOT EXISTS sessions_expires ON sessions (expires_at);
CREATE TABLE IF NOT EXISTS project_members (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id text NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role text NOT NULL,
  created_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS project_members_user ON project_members (user_id);
CREATE TABLE IF NOT EXISTS project_invites (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  email text NOT NULL,
  role text NOT NULL,
  token_hash text NOT NULL UNIQUE,
  invited_by text NOT NULL,
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS project_invites_project ON project_invites (project_id);
CREATE TABLE IF NOT EXISTS scheduled_sends (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  mode text NOT NULL,
  channel text NOT NULL,
  request jsonb NOT NULL,
  send_at timestamptz NOT NULL,
  status text NOT NULL,
  summary text NOT NULL,
  recipients jsonb NOT NULL,
  message_id text,
  error text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS scheduled_sends_due ON scheduled_sends (send_at) WHERE status IN ('pending', 'sending');
CREATE INDEX IF NOT EXISTS scheduled_sends_project ON scheduled_sends (project_id, mode, send_at);
CREATE TABLE IF NOT EXISTS templates (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  alias text NOT NULL,
  name text NOT NULL,
  channel text NOT NULL,
  subject text,
  html text,
  text text,
  body text,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (project_id, alias)
);
CREATE TABLE IF NOT EXISTS idempotency_keys (
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key text NOT NULL,
  fingerprint text NOT NULL,
  response jsonb,
  expires_at timestamptz NOT NULL,
  PRIMARY KEY (project_id, key)
);
CREATE TABLE IF NOT EXISTS webhook_attempts (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  event_id text NOT NULL,
  event_type text NOT NULL,
  recipient text NOT NULL,
  url text NOT NULL,
  attempt integer NOT NULL,
  max_attempts integer NOT NULL,
  trigger text NOT NULL,
  ok boolean NOT NULL,
  status_code integer,
  error text,
  response_body text,
  duration_ms integer NOT NULL,
  will_retry boolean NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_attempts_project_created ON webhook_attempts (project_id, created_at DESC);
ALTER TABLE webhook_attempts ADD COLUMN IF NOT EXISTS endpoint_id text;
CREATE TABLE IF NOT EXISTS webhook_endpoints (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  url text NOT NULL,
  secret text NOT NULL,
  description text,
  events jsonb,
  mode text,
  enabled boolean NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS webhook_endpoints_project ON webhook_endpoints (project_id, created_at);
CREATE TABLE IF NOT EXISTS inbound_emails (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  body jsonb NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS inbound_emails_project_created ON inbound_emails (project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS audit_log (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  actor jsonb NOT NULL,
  action text NOT NULL,
  params jsonb,
  details jsonb,
  ip text,
  mode text NOT NULL,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS audit_log_project_created ON audit_log (project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS api_requests (
  id text PRIMARY KEY,
  project_id text NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  key_id text NOT NULL,
  key_name text NOT NULL,
  mode text NOT NULL,
  method text NOT NULL,
  path text NOT NULL,
  status integer NOT NULL,
  duration_ms integer NOT NULL,
  ip text,
  error text,
  created_at timestamptz NOT NULL
);
CREATE INDEX IF NOT EXISTS api_requests_project_created ON api_requests (project_id, created_at DESC);
CREATE TABLE IF NOT EXISTS smtp_attempts (
  key text PRIMARY KEY,
  count integer NOT NULL,
  expires_at timestamptz NOT NULL
);
`;

interface UserRow {
  id: string;
  email: string;
  name: string;
  password_hash: string;
  email_verified_at: Date | null;
  two_factor: (Omit<TwoFactor, 'enabledAt'> & { enabledAt?: string }) | null;
  created_at: Date;
}

interface ProjectRow {
  id: string;
  name: string;
  owner_id: string | null;
  webhook_url: string | null;
  webhook_secret: string;
  reports_smtp_url: string | null;
  managed_access: ManagedAccess | null;
  limits: ProjectLimits | null;
  options: ProjectOptions | null;
  inbound_token: string | null;
  created_at: Date;
}

interface KeyRow {
  id: string;
  project_id: string;
  name: string;
  prefix: string;
  key_hash: string;
  created_at: Date;
  last_used_at: Date | null;
  revoked_at: Date | null;
  mode: Mode;
  permission?: KeyPermission;
  allowed_domains?: string[] | null;
}

interface ConnectionRow {
  id: string;
  project_id: string;
  name: string;
  channel: 'email' | 'sms';
  provider: Connection['provider'];
  settings: Record<string, string>;
  secrets: string;
  priority: number;
  inbound_token: string;
  created_at: Date;
}

interface MessageRow {
  id: string;
  project_id: string;
  via: SimMessage['via'];
  relayo_message_id: string | null;
  from_address: string;
  recipients: SimMessage['recipients'];
  subject: string;
  metadata: Record<string, string> | null;
  tags: string[] | null;
  envelope_from: string | null;
  headers: Record<string, string> | null;
  size: number | null;
  channel: 'email' | 'sms';
  body: string | null;
  mode: Mode;
  delivery: SimMessage['delivery'] | null;
  template?: string | null;
  created_at: Date;
}

export class PostgresStore implements SimStore {
  private constructor(private readonly pool: pg.Pool) {}

  /**
   * Connects and creates the tables if they do not exist yet. `schema` puts everything in its own
   * PostgreSQL schema (created if missing), e.g. to keep tests away from real data.
   */
  static async connect(connectionString: string, options: { schema?: string } = {}): Promise<PostgresStore> {
    if (options.schema && !/^[a-z_][a-z0-9_]*$/.test(options.schema)) {
      throw new Error(`Invalid schema name: ${options.schema}`);
    }
    // search_path as a startup parameter: every pooled connection uses the schema from its first query.
    const pool = new pg.Pool({
      connectionString,
      max: 10,
      // Fail in seconds, not minutes, when the database cannot be reached (wrong host, firewall).
      connectionTimeoutMillis: 10_000,
      ...(options.schema && { options: `-c search_path=${options.schema}` }),
    });
    try {
      if (options.schema) await pool.query(`CREATE SCHEMA IF NOT EXISTS ${options.schema}`);
      await pool.query(SCHEMA);
    } catch (error) {
      await pool.end().catch(() => undefined);
      throw new Error(`Cannot connect to PostgreSQL at ${describeTarget(connectionString)}: ${(error as Error).message}`, { cause: error });
    }
    return new PostgresStore(pool);
  }

  async ping(): Promise<void> {
    await this.pool.query('SELECT 1');
  }

  /** Drops a schema created with `connect(..., { schema })`. */
  async dropSchema(schema: string): Promise<void> {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
    await this.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }

  // --- Accounts ---------------------------------------------------------------------------------

  async createUser(u: User): Promise<void> {
    await this.pool.query('INSERT INTO users (id, email, name, password_hash, email_verified_at, created_at) VALUES ($1, $2, $3, $4, $5, $6)', [
      u.id,
      u.email.toLowerCase(),
      u.name,
      u.passwordHash,
      u.emailVerifiedAt ?? null,
      u.createdAt,
    ]);
  }

  async findUserByEmail(email: string): Promise<User | undefined> {
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE email = $1', [email.toLowerCase()]);
    return rows[0] && toUser(rows[0]);
  }

  async getUser(id: string): Promise<User | undefined> {
    const { rows } = await this.pool.query<UserRow>('SELECT * FROM users WHERE id = $1', [id]);
    return rows[0] && toUser(rows[0]);
  }

  async updateUser(id: string, changes: Partial<Pick<User, 'name' | 'passwordHash' | 'emailVerifiedAt'>>): Promise<void> {
    await this.pool.query(
      'UPDATE users SET name = COALESCE($2, name), password_hash = COALESCE($3, password_hash), email_verified_at = COALESCE($4, email_verified_at) WHERE id = $1',
      [id, changes.name ?? null, changes.passwordHash ?? null, changes.emailVerifiedAt ?? null],
    );
  }

  async createSession(s: Session): Promise<void> {
    await this.pool.query('INSERT INTO sessions (id_hash, user_id, created_at, expires_at) VALUES ($1, $2, $3, $4)', [
      s.idHash,
      s.userId,
      s.createdAt,
      s.expiresAt,
    ]);
  }

  async getSession(idHash: string): Promise<Session | undefined> {
    const { rows } = await this.pool.query<{ id_hash: string; user_id: string; created_at: Date; expires_at: Date }>(
      'SELECT * FROM sessions WHERE id_hash = $1 AND expires_at > now()',
      [idHash],
    );
    const row = rows[0];
    return row && { idHash: row.id_hash, userId: row.user_id, createdAt: row.created_at, expiresAt: row.expires_at };
  }

  async deleteSession(idHash: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE id_hash = $1', [idHash]);
  }

  async deleteUserSessions(userId: string, except?: string): Promise<void> {
    await this.pool.query('DELETE FROM sessions WHERE user_id = $1 AND id_hash <> $2', [userId, except ?? '']);
  }

  // --- Projects and keys ------------------------------------------------------------------------

  async createProject(p: Project): Promise<void> {
    await this.pool.query(
      'INSERT INTO projects (id, name, owner_id, webhook_url, webhook_secret, reports_smtp_url, managed_access, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
      [p.id, p.name, p.ownerId ?? null, p.webhookUrl ?? null, p.webhookSecret, p.reportsSmtpUrl ?? null, p.managedAccess ?? null, p.createdAt],
    );
  }

  async getProject(id: string): Promise<Project | undefined> {
    const { rows } = await this.pool.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [id]);
    return rows[0] && toProject(rows[0]);
  }

  async listProjects(ownerId: string): Promise<Project[]> {
    const { rows } = await this.pool.query<ProjectRow>('SELECT * FROM projects WHERE owner_id = $1 ORDER BY created_at', [ownerId]);
    return rows.map(toProject);
  }

  async listProjectsFor(userId: string): Promise<Array<{ project: Project; role: ProjectRole }>> {
    const { rows } = await this.pool.query<ProjectRow & { member_role: ProjectRole | null }>(
      `SELECT p.*, m.role AS member_role FROM projects p
       LEFT JOIN project_members m ON m.project_id = p.id AND m.user_id = $1
       WHERE p.owner_id = $1 OR m.user_id IS NOT NULL
       ORDER BY p.created_at`,
      [userId],
    );
    return rows.map((row) => ({ project: toProject(row), role: row.owner_id === userId ? 'owner' : row.member_role! }));
  }

  async addMember(m: ProjectMember): Promise<void> {
    await this.pool.query(
      `INSERT INTO project_members (project_id, user_id, role, created_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (project_id, user_id) DO UPDATE SET role = EXCLUDED.role`,
      [m.projectId, m.userId, m.role, m.createdAt],
    );
  }

  async getMember(projectId: string, userId: string): Promise<ProjectMember | undefined> {
    const { rows } = await this.pool.query<MemberRow>('SELECT * FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
    return rows[0] && toMember(rows[0]);
  }

  async listMembers(projectId: string): Promise<ProjectMember[]> {
    const { rows } = await this.pool.query<MemberRow>('SELECT * FROM project_members WHERE project_id = $1 ORDER BY created_at', [projectId]);
    return rows.map(toMember);
  }

  async updateMemberRole(projectId: string, userId: string, role: ProjectMember['role']): Promise<boolean> {
    const { rowCount } = await this.pool.query('UPDATE project_members SET role = $3 WHERE project_id = $1 AND user_id = $2', [projectId, userId, role]);
    return (rowCount ?? 0) > 0;
  }

  async removeMember(projectId: string, userId: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM project_members WHERE project_id = $1 AND user_id = $2', [projectId, userId]);
    return (rowCount ?? 0) > 0;
  }

  async createInvite(i: ProjectInvite): Promise<void> {
    await this.pool.query(
      `INSERT INTO project_invites (id, project_id, email, role, token_hash, invited_by, expires_at, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [i.id, i.projectId, i.email, i.role, i.tokenHash, i.invitedBy, i.expiresAt, i.createdAt],
    );
  }

  async listInvites(projectId: string): Promise<ProjectInvite[]> {
    const { rows } = await this.pool.query<InviteRow>(
      'SELECT * FROM project_invites WHERE project_id = $1 AND expires_at > now() ORDER BY created_at DESC',
      [projectId],
    );
    return rows.map(toInvite);
  }

  async findInvite(tokenHash: string): Promise<ProjectInvite | undefined> {
    const { rows } = await this.pool.query<InviteRow>('SELECT * FROM project_invites WHERE token_hash = $1 AND expires_at > now()', [tokenHash]);
    return rows[0] && toInvite(rows[0]);
  }

  async deleteInvite(projectId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM project_invites WHERE id = $1 AND project_id = $2', [id, projectId]);
    return (rowCount ?? 0) > 0;
  }

  async searchProjects(query: { text?: string; limit: number }): Promise<Array<{ project: Project; ownerEmail?: string }>> {
    const text = query.text?.trim();
    const { rows } = await this.pool.query<ProjectRow & { owner_email: string | null }>(
      `SELECT p.*, u.email AS owner_email FROM projects p LEFT JOIN users u ON u.id = p.owner_id
       ${text ? 'WHERE p.name ILIKE $2 OR p.id = $3 OR u.email ILIKE $2' : ''}
       ORDER BY p.created_at DESC LIMIT $1`,
      text ? [query.limit, `%${text.replace(/[%_\\]/g, (c) => `\\${c}`)}%`, text] : [query.limit],
    );
    return rows.map((row) => ({ project: toProject(row), ...(row.owner_email && { ownerEmail: row.owner_email }) }));
  }

  async listCustomRetention(): Promise<Array<{ projectId: string; days: number }>> {
    const { rows } = await this.pool.query<{ id: string; days: number }>(
      "SELECT id, (limits->>'retentionDays')::int AS days FROM projects WHERE limits ? 'retentionDays'",
    );
    return rows.map((r) => ({ projectId: r.id, days: r.days }));
  }

  async listManagedAccess(): Promise<Project[]> {
    const { rows } = await this.pool.query<ProjectRow>('SELECT * FROM projects WHERE managed_access IS NOT NULL ORDER BY created_at DESC');
    return rows.map(toProject);
  }

  async updateProject(id: string, changes: ProjectChanges): Promise<void> {
    const columns = { name: 'name', webhookUrl: 'webhook_url', reportsSmtpUrl: 'reports_smtp_url', webhookSecret: 'webhook_secret', ownerId: 'owner_id', managedAccess: 'managed_access', limits: 'limits', options: 'options', inboundToken: 'inbound_token' } as const;
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, column] of Object.entries(columns) as Array<[keyof ProjectChanges, string]>) {
      if (changes[key] === undefined) continue;
      const value = changes[key];
      values.push((key === 'limits' || key === 'options') && value !== null ? JSON.stringify(value) : value);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length) await this.pool.query(`UPDATE projects SET ${sets.join(', ')} WHERE id = $1`, values);
  }

  async deleteProject(id: string): Promise<void> {
    // Everything else references the project ON DELETE CASCADE; events go with their messages.
    await this.pool.query('DELETE FROM projects WHERE id = $1', [id]);
  }

  async deleteUser(id: string): Promise<void> {
    // Owned projects, sessions, memberships and tokens reference the user ON DELETE CASCADE.
    await this.pool.query('DELETE FROM users WHERE id = $1', [id]);
  }

  async createApiKey(k: ApiKey): Promise<void> {
    await this.pool.query(
      'INSERT INTO api_keys (id, project_id, name, prefix, key_hash, created_at, mode, permission, allowed_domains) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [k.id, k.projectId, k.name, k.prefix, k.keyHash, k.createdAt, k.mode, k.permission ?? 'full', k.allowedDomains ? JSON.stringify(k.allowedDomains) : null],
    );
  }

  async listApiKeys(projectId: string): Promise<ApiKey[]> {
    const { rows } = await this.pool.query<KeyRow>('SELECT * FROM api_keys WHERE project_id = $1 ORDER BY created_at DESC', [projectId]);
    return rows.map(toKey);
  }

  async revokeApiKey(projectId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      'UPDATE api_keys SET revoked_at = now() WHERE id = $1 AND project_id = $2 AND revoked_at IS NULL',
      [id, projectId],
    );
    return (rowCount ?? 0) > 0;
  }

  async findProjectByApiKeyHash(hash: string): Promise<{ project: Project; key: ApiKey } | undefined> {
    const { rows } = await this.pool.query<KeyRow & { project: ProjectRow }>(
      `SELECT k.*, to_jsonb(p) AS project FROM api_keys k JOIN projects p ON p.id = k.project_id
       WHERE k.key_hash = $1 AND k.revoked_at IS NULL`,
      [hash],
    );
    const row = rows[0];
    if (!row) return undefined;
    return { key: toKey(row), project: toProject({ ...row.project, created_at: new Date(row.project.created_at) }) };
  }

  async touchApiKey(id: string, at: Date): Promise<void> {
    await this.pool.query('UPDATE api_keys SET last_used_at = $2 WHERE id = $1', [id, at]);
  }

  // --- Messages ---------------------------------------------------------------------------------

  async saveMessage(m: SimMessage, raw?: Uint8Array): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages (id, project_id, via, relayo_message_id, from_address, recipients, subject, metadata, tags, envelope_from, headers, created_at, size, channel, body, mode, delivery, template)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17, $18) ON CONFLICT (id) DO NOTHING`,
      [
        m.id,
        m.projectId,
        m.via,
        m.relayoMessageId ?? null,
        m.from,
        JSON.stringify(m.recipients),
        m.subject,
        m.metadata ? JSON.stringify(m.metadata) : null,
        m.tags ? JSON.stringify(m.tags) : null,
        m.envelopeFrom ?? null,
        m.headers ? JSON.stringify(m.headers) : null,
        m.createdAt,
        m.size ?? null,
        m.channel ?? 'email',
        m.body ?? null,
        m.mode ?? 'test',
        m.delivery ? JSON.stringify(m.delivery) : null,
        m.template ?? null,
      ],
    );
    if (raw) {
      await this.pool.query('INSERT INTO message_contents (message_id, raw) VALUES ($1, $2) ON CONFLICT (message_id) DO NOTHING', [
        m.id,
        Buffer.from(raw),
      ]);
    }
  }

  async getContent(projectId: string, id: string): Promise<Buffer | undefined> {
    const { rows } = await this.pool.query<{ raw: Buffer }>(
      'SELECT c.raw FROM message_contents c JOIN messages m ON m.id = c.message_id WHERE c.message_id = $1 AND m.project_id = $2',
      [id, projectId],
    );
    return rows[0]?.raw;
  }

  async getMessage(projectId: string, id: string): Promise<MessageWithEvents | undefined> {
    const { rows } = await this.pool.query<MessageRow>('SELECT * FROM messages WHERE id = $1 AND project_id = $2', [id, projectId]);
    if (!rows[0]) return undefined;
    const events = await this.pool.query<{ body: SimEvent }>('SELECT body FROM events WHERE message_id = $1 ORDER BY occurred_at, id', [id]);
    return {
      ...toMessage(rows[0]),
      events: events.rows.map(({ body }) => ({ ...body, timestamp: new Date(body.timestamp) })),
    };
  }

  async listMessages(projectId: string, { limit, before, search, status, channel, mode = 'test' }: MessageQuery): Promise<MessageListItem[]> {
    const { rows } = await this.pool.query<MessageRow & { latest_type: string | null; latest_bounce: string | null }>(
      `SELECT m.*, latest.type AS latest_type, latest.body->>'bounceType' AS latest_bounce
       FROM messages m
       LEFT JOIN LATERAL (
         SELECT e.type, e.body FROM events e
         WHERE e.message_id = m.id AND e.recipient = m.recipients->0->>'address'
         ORDER BY e.occurred_at DESC, e.id DESC LIMIT 1
       ) latest ON true
       WHERE m.project_id = $1
         AND ($2::timestamptz IS NULL OR m.created_at < $2)
         AND ($3::text IS NULL OR m.subject ILIKE $3 OR m.from_address ILIKE $3 OR m.body ILIKE $3 OR m.recipients::text ILIKE $3)
         AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM events s WHERE s.message_id = m.id AND s.type = $4))
         AND ($6::text IS NULL OR m.channel = $6)
         AND m.mode = $7
       ORDER BY m.created_at DESC LIMIT $5`,
      [projectId, before ?? null, search?.trim() ? `%${escapeLike(search.trim())}%` : null, status ?? null, limit, channel ?? null, mode],
    );
    return rows.map((row) => {
      const message: MessageListItem = toMessage(row);
      if (row.latest_type) {
        message.latest = {
          type: row.latest_type as SimEvent['type'],
          ...(row.latest_bounce && { bounceType: row.latest_bounce as 'hard' | 'soft' | 'block' }),
        };
      }
      return message;
    });
  }

  async addEvent(event: SimEvent): Promise<void> {
    // Idempotent: a retried job must not record the same event twice.
    await this.pool.query(
      `INSERT INTO events (id, message_id, project_id, type, recipient, occurred_at, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      [event.id, event.providerMessageId, event.projectId, event.type, event.recipient, event.timestamp, JSON.stringify(event)],
    );
  }

  async getEvent(projectId: string, eventId: string): Promise<SimEvent | undefined> {
    const { rows } = await this.pool.query<{ body: SimEvent }>('SELECT body FROM events WHERE id = $1 AND project_id = $2', [eventId, projectId]);
    return rows[0] && { ...rows[0].body, timestamp: new Date(rows[0].body.timestamp) };
  }

  async createScheduled(s: ScheduledSend): Promise<void> {
    await this.pool.query(
      `INSERT INTO scheduled_sends (id, project_id, mode, channel, request, send_at, status, summary, recipients, message_id, error, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        s.id,
        s.projectId,
        s.mode,
        s.channel,
        JSON.stringify(s.request),
        s.sendAt,
        s.status,
        s.summary,
        JSON.stringify(s.recipients),
        s.messageId ?? null,
        s.error ?? null,
        s.createdAt,
        s.updatedAt,
      ],
    );
  }

  async listScheduled(projectId: string, query: { mode: Mode; status?: ScheduledSend['status']; limit: number }): Promise<ScheduledSend[]> {
    const values: unknown[] = [projectId, query.mode, query.limit];
    const status = query.status ? `AND status = $${values.push(query.status)}` : '';
    const order = query.status === 'pending' ? 'send_at ASC' : 'send_at DESC';
    const { rows } = await this.pool.query<ScheduledRow>(
      `SELECT * FROM scheduled_sends WHERE project_id = $1 AND mode = $2 ${status} ORDER BY ${order} LIMIT $3`,
      values,
    );
    return rows.map(toScheduled);
  }

  async getScheduled(projectId: string, id: string): Promise<ScheduledSend | undefined> {
    const { rows } = await this.pool.query<ScheduledRow>('SELECT * FROM scheduled_sends WHERE id = $1 AND project_id = $2', [id, projectId]);
    return rows[0] && toScheduled(rows[0]);
  }

  async cancelScheduled(projectId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query(
      "UPDATE scheduled_sends SET status = 'canceled', updated_at = now() WHERE id = $1 AND project_id = $2 AND status = 'pending'",
      [id, projectId],
    );
    return (rowCount ?? 0) > 0;
  }

  async claimDueScheduled(now: Date, limit: number): Promise<ScheduledSend[]> {
    // SKIP LOCKED: servers claiming at the same moment take different rows instead of waiting for each other.
    const { rows } = await this.pool.query<ScheduledRow>(
      `UPDATE scheduled_sends SET status = 'sending', updated_at = $1
       WHERE id IN (
         SELECT id FROM scheduled_sends
         WHERE send_at <= $1 AND (status = 'pending' OR (status = 'sending' AND updated_at < $1::timestamptz - interval '10 minutes'))
         ORDER BY send_at LIMIT $2 FOR UPDATE SKIP LOCKED
       )
       RETURNING *`,
      [now, limit],
    );
    return rows.map(toScheduled).sort((a, b) => a.sendAt.getTime() - b.sendAt.getTime());
  }

  async finishScheduled(id: string, outcome: { status: 'sent' | 'failed'; messageId?: string; error?: string }): Promise<void> {
    await this.pool.query('UPDATE scheduled_sends SET status = $2, message_id = $3, error = $4, updated_at = now() WHERE id = $1', [
      id,
      outcome.status,
      outcome.messageId ?? null,
      outcome.error ?? null,
    ]);
  }

  async createTemplate(t: Template): Promise<void> {
    await this.pool.query(
      `INSERT INTO templates (id, project_id, alias, name, channel, subject, html, text, body, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [t.id, t.projectId, t.alias, t.name, t.channel, t.subject ?? null, t.html ?? null, t.text ?? null, t.body ?? null, t.createdAt, t.updatedAt],
    );
  }

  async listTemplates(projectId: string): Promise<Template[]> {
    const { rows } = await this.pool.query<TemplateRow>('SELECT * FROM templates WHERE project_id = $1 ORDER BY alias', [projectId]);
    return rows.map(toTemplate);
  }

  async getTemplate(projectId: string, ref: string): Promise<Template | undefined> {
    const { rows } = await this.pool.query<TemplateRow>('SELECT * FROM templates WHERE project_id = $1 AND (id = $2 OR alias = $2)', [projectId, ref]);
    return rows[0] && toTemplate(rows[0]);
  }

  async updateTemplate(t: Template): Promise<void> {
    await this.pool.query(
      `UPDATE templates SET alias = $3, name = $4, subject = $5, html = $6, text = $7, body = $8, updated_at = $9
       WHERE id = $1 AND project_id = $2`,
      [t.id, t.projectId, t.alias, t.name, t.subject ?? null, t.html ?? null, t.text ?? null, t.body ?? null, t.updatedAt],
    );
  }

  async deleteTemplate(projectId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM templates WHERE id = $1 AND project_id = $2', [id, projectId]);
    return (rowCount ?? 0) > 0;
  }

  async claimIdempotencyKey(
    projectId: string,
    key: string,
    fingerprint: string,
    ttlMs: number,
  ): Promise<{ claimed: true } | { claimed: false; fingerprint: string; response?: unknown }> {
    // Takes the key if it is new or expired, atomically: two requests at once cannot both take it.
    const claimed = await this.pool.query(
      `INSERT INTO idempotency_keys (project_id, key, fingerprint, response, expires_at)
       VALUES ($1, $2, $3, NULL, now() + $4 * interval '1 millisecond')
       ON CONFLICT (project_id, key) DO UPDATE SET fingerprint = $3, response = NULL, expires_at = now() + $4 * interval '1 millisecond'
         WHERE idempotency_keys.expires_at <= now()
       RETURNING key`,
      [projectId, key, fingerprint, ttlMs],
    );
    if (claimed.rowCount) return { claimed: true };
    const { rows } = await this.pool.query<{ fingerprint: string; response: unknown }>(
      'SELECT fingerprint, response FROM idempotency_keys WHERE project_id = $1 AND key = $2',
      [projectId, key],
    );
    const row = rows[0]!;
    return { claimed: false, fingerprint: row.fingerprint, ...(row.response !== null && { response: row.response }) };
  }

  async completeIdempotencyKey(projectId: string, key: string, response: unknown): Promise<void> {
    await this.pool.query('UPDATE idempotency_keys SET response = $3 WHERE project_id = $1 AND key = $2', [projectId, key, JSON.stringify(response ?? null)]);
  }

  async releaseIdempotencyKey(projectId: string, key: string): Promise<void> {
    await this.pool.query('DELETE FROM idempotency_keys WHERE project_id = $1 AND key = $2', [projectId, key]);
  }

  async findProjectByInboundToken(token: string): Promise<Project | undefined> {
    const { rows } = await this.pool.query<ProjectRow>('SELECT * FROM projects WHERE inbound_token = $1', [token]);
    return rows[0] && toProject(rows[0]);
  }

  async saveInbound(email: InboundEmail): Promise<void> {
    const { id, projectId, createdAt, ...body } = email;
    await this.pool.query('INSERT INTO inbound_emails (id, project_id, body, created_at) VALUES ($1, $2, $3, $4)', [id, projectId, JSON.stringify(body), createdAt]);
  }

  async listInbound(projectId: string, query: { limit: number; before?: Date }): Promise<InboundEmail[]> {
    const values: unknown[] = [projectId, query.limit];
    const before = query.before ? `AND created_at < $${values.push(query.before)}` : '';
    const { rows } = await this.pool.query<InboundRow>(
      `SELECT * FROM inbound_emails WHERE project_id = $1 ${before} ORDER BY created_at DESC LIMIT $2`,
      values,
    );
    return rows.map(toInbound);
  }

  async getInbound(projectId: string, id: string): Promise<InboundEmail | undefined> {
    const { rows } = await this.pool.query<InboundRow>('SELECT * FROM inbound_emails WHERE project_id = $1 AND id = $2', [projectId, id]);
    return rows[0] && toInbound(rows[0]);
  }

  async findMessageByReference(projectId: string, ids: string[]): Promise<SimMessage | undefined> {
    if (!ids.length) return undefined;
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT * FROM messages WHERE project_id = $1
         AND (headers->>'message-id' = ANY($2) OR delivery->>'providerMessageId' = ANY($2))
       ORDER BY created_at DESC LIMIT 1`,
      [projectId, ids],
    );
    return rows[0] && toMessage(rows[0]);
  }

  async addAudit(e: AuditEntry): Promise<void> {
    await this.pool.query(
      'INSERT INTO audit_log (id, project_id, actor, action, params, details, ip, mode, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [
        e.id,
        e.projectId,
        JSON.stringify(e.actor),
        e.action,
        e.params ? JSON.stringify(e.params) : null,
        e.details ? JSON.stringify(e.details) : null,
        e.ip ?? null,
        e.mode,
        e.createdAt,
      ],
    );
  }

  async listAudit(projectId: string, query: { limit: number; before?: Date }): Promise<AuditEntry[]> {
    const values: unknown[] = [projectId, query.limit];
    const where = ['project_id = $1'];
    if (query.before) where.push(`created_at < $${values.push(query.before)}`);
    const { rows } = await this.pool.query<AuditRow>(`SELECT * FROM audit_log WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $2`, values);
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      actor: row.actor,
      action: row.action,
      mode: row.mode,
      createdAt: row.created_at,
      ...(row.params && { params: row.params }),
      ...(row.details && { details: row.details }),
      ...(row.ip !== null && { ip: row.ip }),
    }));
  }

  async addApiRequest(r: ApiRequestLog): Promise<void> {
    await this.pool.query(
      `INSERT INTO api_requests (id, project_id, key_id, key_name, mode, method, path, status, duration_ms, ip, error, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)`,
      [r.id, r.projectId, r.keyId, r.keyName, r.mode, r.method, r.path, r.status, r.durationMs, r.ip ?? null, r.error ?? null, r.createdAt],
    );
  }

  async listApiRequests(projectId: string, query: { limit: number; before?: Date; failed?: boolean; keyId?: string }): Promise<ApiRequestLog[]> {
    const values: unknown[] = [projectId, query.limit];
    const where = ['project_id = $1'];
    if (query.before) where.push(`created_at < $${values.push(query.before)}`);
    if (query.failed) where.push('status >= 400');
    if (query.keyId) where.push(`key_id = $${values.push(query.keyId)}`);
    const { rows } = await this.pool.query<RequestRow>(`SELECT * FROM api_requests WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $2`, values);
    return rows.map((row) => ({
      id: row.id,
      projectId: row.project_id,
      keyId: row.key_id,
      keyName: row.key_name,
      mode: row.mode,
      method: row.method,
      path: row.path,
      status: row.status,
      durationMs: row.duration_ms,
      createdAt: row.created_at,
      ...(row.ip !== null && { ip: row.ip }),
      ...(row.error !== null && { error: row.error }),
    }));
  }

  async addWebhookAttempt(a: WebhookAttempt): Promise<void> {
    await this.pool.query(
      `INSERT INTO webhook_attempts (id, project_id, event_id, event_type, recipient, url, attempt, max_attempts, trigger, ok, status_code, error,
         response_body, duration_ms, will_retry, created_at, endpoint_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)`,
      [
        a.id,
        a.projectId,
        a.eventId,
        a.eventType,
        a.recipient,
        a.url,
        a.attempt,
        a.maxAttempts,
        a.trigger,
        a.ok,
        a.statusCode ?? null,
        a.error ?? null,
        a.responseBody ?? null,
        a.durationMs,
        a.willRetry,
        a.createdAt,
        a.endpointId ?? null,
      ],
    );
  }

  async createWebhookEndpoint(e: WebhookEndpoint): Promise<void> {
    await this.pool.query(
      'INSERT INTO webhook_endpoints (id, project_id, url, secret, description, events, mode, enabled, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)',
      [e.id, e.projectId, e.url, e.secret, e.description ?? null, e.events ? JSON.stringify(e.events) : null, e.mode ?? null, e.enabled, e.createdAt],
    );
  }

  async listWebhookEndpoints(projectId: string): Promise<WebhookEndpoint[]> {
    const { rows } = await this.pool.query<EndpointRow>('SELECT * FROM webhook_endpoints WHERE project_id = $1 ORDER BY created_at, id', [projectId]);
    return rows.map(toEndpoint);
  }

  async getWebhookEndpoint(projectId: string, id: string): Promise<WebhookEndpoint | undefined> {
    const { rows } = await this.pool.query<EndpointRow>('SELECT * FROM webhook_endpoints WHERE project_id = $1 AND id = $2', [projectId, id]);
    return rows[0] && toEndpoint(rows[0]);
  }

  async updateWebhookEndpoint(projectId: string, id: string, changes: WebhookEndpointChanges): Promise<void> {
    const columns = { url: 'url', secret: 'secret', description: 'description', events: 'events', mode: 'mode', enabled: 'enabled' } as const;
    const values: unknown[] = [projectId, id];
    const sets: string[] = [];
    for (const [key, column] of Object.entries(columns)) {
      const value = changes[key as keyof WebhookEndpointChanges];
      if (value === undefined) continue;
      sets.push(`${column} = $${values.push(key === 'events' && value !== null ? JSON.stringify(value) : value)}`);
    }
    if (sets.length) await this.pool.query(`UPDATE webhook_endpoints SET ${sets.join(', ')} WHERE project_id = $1 AND id = $2`, values);
  }

  async deleteWebhookEndpoint(projectId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM webhook_endpoints WHERE project_id = $1 AND id = $2', [projectId, id]);
    return (rowCount ?? 0) > 0;
  }

  async listWebhookAttempts(projectId: string, query: AttemptQuery): Promise<WebhookAttempt[]> {
    const values: unknown[] = [projectId, query.limit];
    const where = ['project_id = $1'];
    if (query.before) where.push(`created_at < $${values.push(query.before)}`);
    if (query.since) where.push(`created_at >= $${values.push(query.since)}`);
    if (query.endpointId === null) where.push('endpoint_id IS NULL');
    else if (query.endpointId !== undefined) where.push(`endpoint_id = $${values.push(query.endpointId)}`);
    if (query.failed) where.push('NOT ok');
    if (query.eventId) where.push(`event_id = $${values.push(query.eventId)}`);
    const { rows } = await this.pool.query<AttemptRow>(
      `SELECT * FROM webhook_attempts WHERE ${where.join(' AND ')} ORDER BY created_at DESC LIMIT $2`,
      values,
    );
    return rows.map(toAttempt);
  }

  async getWebhookAttempt(projectId: string, id: string): Promise<WebhookAttempt | undefined> {
    const { rows } = await this.pool.query<AttemptRow>('SELECT * FROM webhook_attempts WHERE id = $1 AND project_id = $2', [id, projectId]);
    return rows[0] && toAttempt(rows[0]);
  }

  async webhookStats(projectId: string, since: Date): Promise<{ ok: number; failed: number }> {
    const { rows } = await this.pool.query<{ ok: string; failed: string }>(
      'SELECT count(*) FILTER (WHERE ok) AS ok, count(*) FILTER (WHERE NOT ok) AS failed FROM webhook_attempts WHERE project_id = $1 AND created_at >= $2',
      [projectId, since],
    );
    return { ok: Number(rows[0]?.ok ?? 0), failed: Number(rows[0]?.failed ?? 0) };
  }

  async stats(projectId: string, since: Date, mode: Mode = 'test'): Promise<ProjectStats> {
    const stats = emptyStats(since);
    const [messages, events, daily] = await Promise.all([
      this.pool.query<{ count: string }>('SELECT count(*) FROM messages WHERE project_id = $1 AND created_at >= $2 AND mode = $3', [
        projectId,
        since,
        mode,
      ]),
      this.pool.query<{ type: string; bounce_type: string | null; count: string }>(
        `SELECT e.type, e.body->>'bounceType' AS bounce_type, count(*) FROM events e
         JOIN messages m ON m.id = e.message_id AND m.mode = $3
         WHERE e.project_id = $1 AND e.occurred_at >= $2 GROUP BY 1, 2`,
        [projectId, since, mode],
      ),
      this.pool.query<{ day: string; type: string; count: string }>(
        `SELECT to_char(e.occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, e.type, count(*) FROM events e
         JOIN messages m ON m.id = e.message_id AND m.mode = $3
         WHERE e.project_id = $1 AND e.occurred_at >= $2 AND e.type IN ('delivered', 'bounced', 'deferred', 'complained')
         GROUP BY 1, 2`,
        [projectId, since, mode],
      ),
    ]);
    stats.messages = Number(messages.rows[0]?.count ?? 0);
    for (const row of events.rows) {
      const type = row.type as SimEvent['type'];
      stats.events[type] = (stats.events[type] ?? 0) + Number(row.count);
      if (type === 'bounced' && row.bounce_type) stats.bounces[row.bounce_type as keyof ProjectStats['bounces']] += Number(row.count);
    }
    const days = new Map(stats.daily.map((d) => [d.date, d]));
    for (const row of daily.rows) {
      const day = days.get(row.day);
      if (day) day[row.type as 'delivered' | 'bounced' | 'deferred' | 'complained'] += Number(row.count);
    }
    return stats;
  }

  async deliverability(
    projectId: string,
    query: { since: Date; mode: Mode; by: 'domain' | 'template' | 'tag'; limit: number },
  ): Promise<Array<{ key: string; counts: Partial<Record<SimEvent['type'], number>> }>> {
    const key = { domain: "split_part(lower(e.recipient), '@', 2)", template: 'm.template', tag: 't.tag' }[query.by];
    const tags = query.by === 'tag' ? "CROSS JOIN LATERAL jsonb_array_elements_text(COALESCE(m.tags, '[]'::jsonb)) AS t(tag)" : '';
    const channel = query.by === 'domain' ? "AND m.channel = 'email'" : '';
    // One count per recipient of a message and type: two opens of the same email are one.
    const { rows } = await this.pool.query<{ key: string; type: SimEvent['type']; count: number }>(
      `WITH ev AS (
         SELECT DISTINCT e.message_id, lower(e.recipient) AS recipient, e.type, ${key} AS key
         FROM events e JOIN messages m ON m.id = e.message_id ${tags}
         WHERE e.project_id = $1 AND m.project_id = $1 AND e.occurred_at >= $2 AND m.mode = $3 ${channel}
       ),
       top AS (
         SELECT key FROM ev WHERE key IS NOT NULL AND key <> '' GROUP BY key
         ORDER BY count(*) FILTER (WHERE type = 'accepted') DESC, key LIMIT $4
       )
       SELECT ev.key, ev.type, count(*)::int AS count FROM ev JOIN top ON top.key = ev.key GROUP BY ev.key, ev.type`,
      [projectId, query.since, query.mode, query.limit],
    );
    const groups = new Map<string, Partial<Record<SimEvent['type'], number>>>();
    for (const row of rows) groups.set(row.key, { ...groups.get(row.key), [row.type]: Number(row.count) });
    return [...groups].map(([k, counts]) => ({ key: k, counts })).sort((a, b) => (b.counts.accepted ?? 0) - (a.counts.accepted ?? 0));
  }

  async createConnection(c: Connection): Promise<void> {
    await this.pool.query(
      `INSERT INTO connections (id, project_id, name, channel, provider, settings, secrets, priority, inbound_token, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [c.id, c.projectId, c.name, c.channel, c.provider, JSON.stringify(c.settings), c.secrets, c.priority, c.inboundToken, c.createdAt],
    );
  }

  async listConnections(projectId: string, channel?: 'email' | 'sms'): Promise<Connection[]> {
    const { rows } = await this.pool.query<ConnectionRow>(
      'SELECT * FROM connections WHERE project_id = $1 AND ($2::text IS NULL OR channel = $2) ORDER BY priority, created_at',
      [projectId, channel ?? null],
    );
    return rows.map(toConnection);
  }

  async getConnection(projectId: string, id: string): Promise<Connection | undefined> {
    const { rows } = await this.pool.query<ConnectionRow>('SELECT * FROM connections WHERE id = $1 AND project_id = $2', [id, projectId]);
    return rows[0] && toConnection(rows[0]);
  }

  async findConnectionByInboundToken(token: string): Promise<Connection | undefined> {
    const { rows } = await this.pool.query<ConnectionRow>('SELECT * FROM connections WHERE inbound_token = $1', [token]);
    return rows[0] && toConnection(rows[0]);
  }

  async updateConnection(projectId: string, id: string, changes: Partial<Pick<Connection, 'name' | 'settings' | 'secrets' | 'priority'>>): Promise<void> {
    const sets: string[] = [];
    const values: unknown[] = [id, projectId];
    for (const key of ['name', 'settings', 'secrets', 'priority'] as const) {
      if (changes[key] === undefined) continue;
      values.push(key === 'settings' ? JSON.stringify(changes[key]) : changes[key]);
      sets.push(`${key} = $${values.length}`);
    }
    if (sets.length) await this.pool.query(`UPDATE connections SET ${sets.join(', ')} WHERE id = $1 AND project_id = $2`, values);
  }

  async deleteConnection(projectId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM connections WHERE id = $1 AND project_id = $2', [id, projectId]);
    return (rowCount ?? 0) > 0;
  }

  async suppress(projectId: string, address: string, reason: SuppressionReason): Promise<void> {
    await this.pool.query(
      'INSERT INTO suppressions (project_id, address, reason, created_at) VALUES ($1, $2, $3, now()) ON CONFLICT (project_id, address) DO NOTHING',
      [projectId, address.toLowerCase(), reason],
    );
  }

  async suppressed(projectId: string, addresses: string[]): Promise<Set<string>> {
    if (!addresses.length) return new Set();
    const { rows } = await this.pool.query<{ address: string }>(
      'SELECT address FROM suppressions WHERE project_id = $1 AND address = ANY($2::text[])',
      [projectId, addresses.map((a) => a.toLowerCase())],
    );
    return new Set(rows.map((r) => r.address));
  }

  async listSuppressions(projectId: string, limit: number): Promise<Suppression[]> {
    const { rows } = await this.pool.query<{ project_id: string; address: string; reason: SuppressionReason; created_at: Date }>(
      'SELECT * FROM suppressions WHERE project_id = $1 ORDER BY created_at DESC LIMIT $2',
      [projectId, limit],
    );
    return rows.map((r) => ({ projectId: r.project_id, address: r.address, reason: r.reason, createdAt: r.created_at }));
  }

  async unsuppress(projectId: string, address: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM suppressions WHERE project_id = $1 AND address = $2', [projectId, address.toLowerCase()]);
    return (rowCount ?? 0) > 0;
  }

  async createDomain(d: SendingDomain): Promise<void> {
    await this.pool.query(
      `INSERT INTO sending_domains (id, project_id, domain, selector, dkim_public_key, dkim_private_key, checks, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [d.id, d.projectId, d.domain, d.selector, d.dkimPublicKey, d.dkimPrivateKey, JSON.stringify(d.checks), d.createdAt],
    );
  }

  async listDomains(projectId: string): Promise<SendingDomain[]> {
    const { rows } = await this.pool.query<DomainRow>('SELECT * FROM sending_domains WHERE project_id = $1 ORDER BY domain', [projectId]);
    return rows.map(toDomain);
  }

  async getDomain(projectId: string, id: string): Promise<SendingDomain | undefined> {
    const { rows } = await this.pool.query<DomainRow>('SELECT * FROM sending_domains WHERE id = $1 AND project_id = $2', [id, projectId]);
    return rows[0] && toDomain(rows[0]);
  }

  async listSealed(): Promise<SealedValue[]> {
    const { rows } = await this.pool.query<{ kind: SealedValue['kind']; project_id: string; id: string; value: string }>(
      `SELECT 'connection' AS kind, project_id, id, secrets AS value FROM connections
       UNION ALL SELECT 'domain' AS kind, project_id, id, dkim_private_key AS value FROM sending_domains`,
    );
    return rows.map((r) => ({ kind: r.kind, projectId: r.project_id, id: r.id, value: r.value }));
  }

  async updateSealed(item: SealedValue, value: string): Promise<void> {
    const sql =
      item.kind === 'connection'
        ? 'UPDATE connections SET secrets = $3 WHERE id = $1 AND project_id = $2'
        : 'UPDATE sending_domains SET dkim_private_key = $3 WHERE id = $1 AND project_id = $2';
    await this.pool.query(sql, [item.id, item.projectId, value]);
  }

  async updateDomain(projectId: string, id: string, changes: Partial<Pick<SendingDomain, 'checks' | 'verifiedAt' | 'lastCheckedAt'>>): Promise<void> {
    await this.pool.query(
      `UPDATE sending_domains SET
         checks = COALESCE($3, checks),
         verified_at = CASE WHEN $4::boolean THEN $5 ELSE verified_at END,
         last_checked_at = COALESCE($6, last_checked_at)
       WHERE id = $1 AND project_id = $2`,
      [
        id,
        projectId,
        changes.checks ? JSON.stringify(changes.checks) : null,
        'verifiedAt' in changes,
        changes.verifiedAt ?? null,
        changes.lastCheckedAt ?? null,
      ],
    );
  }

  async deleteDomain(projectId: string, id: string): Promise<boolean> {
    const { rowCount } = await this.pool.query('DELETE FROM sending_domains WHERE id = $1 AND project_id = $2', [id, projectId]);
    return (rowCount ?? 0) > 0;
  }

  async findMessage(id: string): Promise<SimMessage | undefined> {
    const { rows } = await this.pool.query<MessageRow>('SELECT * FROM messages WHERE id = $1', [id]);
    return rows[0] && toMessage(rows[0]);
  }

  async setDelivery(projectId: string, messageId: string, delivery: NonNullable<SimMessage['delivery']>): Promise<void> {
    await this.pool.query('UPDATE messages SET delivery = $3 WHERE id = $1 AND project_id = $2', [messageId, projectId, JSON.stringify(delivery)]);
  }

  async createPasswordReset(reset: PasswordReset): Promise<void> {
    await this.pool.query('INSERT INTO password_resets (token_hash, user_id, expires_at, purpose) VALUES ($1, $2, $3, $4)', [
      reset.tokenHash,
      reset.userId,
      reset.expiresAt,
      reset.purpose ?? 'reset',
    ]);
  }

  async setTwoFactor(userId: string, state: TwoFactor | null): Promise<void> {
    await this.pool.query('UPDATE users SET two_factor = $2 WHERE id = $1', [userId, state ? JSON.stringify(state) : null]);
  }

  async usePasswordReset(tokenHash: string, purpose: TokenPurpose = 'reset'): Promise<string | undefined> {
    const { rows } = await this.pool.query<{ user_id: string; expires_at: Date }>(
      'DELETE FROM password_resets WHERE token_hash = $1 AND purpose = $2 RETURNING user_id, expires_at',
      [tokenHash, purpose],
    );
    return rows[0] && rows[0].expires_at > new Date() ? rows[0].user_id : undefined;
  }

  async incrementUsage(projectId: string, month: string): Promise<number> {
    const { rows } = await this.pool.query<{ messages: number }>(
      `INSERT INTO usage (project_id, month, messages) VALUES ($1, $2, 1)
       ON CONFLICT (project_id, month) DO UPDATE SET messages = usage.messages + 1
       RETURNING messages`,
      [projectId, month],
    );
    return rows[0]!.messages;
  }

  async getUsage(projectId: string, month: string): Promise<number> {
    const { rows } = await this.pool.query<{ messages: number }>('SELECT messages FROM usage WHERE project_id = $1 AND month = $2', [
      projectId,
      month,
    ]);
    return rows[0]?.messages ?? 0;
  }

  async purge(before: Date, keepProjects: string[] = []): Promise<{ messages: number }> {
    // Events and captured content go with their message (ON DELETE CASCADE).
    const deleted = await this.pool.query('DELETE FROM messages WHERE created_at < $1 AND NOT (project_id = ANY($2))', [before, keepProjects]);
    await this.pool.query('DELETE FROM webhook_attempts WHERE created_at < $1', [before]);
    await this.pool.query('DELETE FROM api_requests WHERE created_at < $1 AND NOT (project_id = ANY($2))', [before, keepProjects]);
    await this.pool.query('DELETE FROM inbound_emails WHERE created_at < $1 AND NOT (project_id = ANY($2))', [before, keepProjects]);
    await this.pool.query("DELETE FROM audit_log WHERE created_at < now() - interval '365 days'");
    await this.pool.query('DELETE FROM idempotency_keys WHERE expires_at <= now()');
    await this.pool.query('DELETE FROM project_invites WHERE expires_at <= now()');
    await this.pool.query("DELETE FROM scheduled_sends WHERE status IN ('sent', 'failed', 'canceled') AND updated_at < $1", [before]);
    await this.pool.query('DELETE FROM sessions WHERE expires_at <= now()');
    await this.pool.query('DELETE FROM password_resets WHERE expires_at <= now()');
    await this.pool.query('DELETE FROM smtp_attempts WHERE expires_at <= now()');
    return { messages: deleted.rowCount ?? 0 };
  }

  async purgeProject(projectId: string, before: Date): Promise<number> {
    const { rowCount } = await this.pool.query('DELETE FROM messages WHERE project_id = $1 AND created_at < $2', [projectId, before]);
    await this.pool.query('DELETE FROM api_requests WHERE project_id = $1 AND created_at < $2', [projectId, before]);
    await this.pool.query('DELETE FROM inbound_emails WHERE project_id = $1 AND created_at < $2', [projectId, before]);
    return rowCount ?? 0;
  }

  async nextAttempt(key: string, ttlMs: number): Promise<number> {
    const { rows } = await this.pool.query<{ count: number }>(
      `INSERT INTO smtp_attempts (key, count, expires_at) VALUES ($1, 1, now() + $2 * interval '1 millisecond')
       ON CONFLICT (key) DO UPDATE SET
         count = CASE WHEN smtp_attempts.expires_at > now() THEN smtp_attempts.count + 1 ELSE 1 END,
         expires_at = now() + $2 * interval '1 millisecond'
       RETURNING count`,
      [key, ttlMs],
    );
    return rows[0]!.count;
  }

  async close(): Promise<void> {
    await this.pool.end();
  }

  /** For tests: removes all data. */
  async truncate(): Promise<void> {
    await this.pool.query('TRUNCATE inbound_emails, webhook_endpoints, audit_log, api_requests, project_invites, project_members, scheduled_sends, templates, idempotency_keys, webhook_attempts, events, message_contents, messages, usage, password_resets, connections, suppressions, sending_domains, api_keys, projects, sessions, users, smtp_attempts');
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

interface MemberRow {
  project_id: string;
  user_id: string;
  role: ProjectMember['role'];
  created_at: Date;
}

const toMember = (row: MemberRow): ProjectMember => ({ projectId: row.project_id, userId: row.user_id, role: row.role, createdAt: row.created_at });

interface InviteRow {
  id: string;
  project_id: string;
  email: string;
  role: ProjectInvite['role'];
  token_hash: string;
  invited_by: string;
  expires_at: Date;
  created_at: Date;
}

const toInvite = (row: InviteRow): ProjectInvite => ({
  id: row.id,
  projectId: row.project_id,
  email: row.email,
  role: row.role,
  tokenHash: row.token_hash,
  invitedBy: row.invited_by,
  expiresAt: row.expires_at,
  createdAt: row.created_at,
});

interface ScheduledRow {
  id: string;
  project_id: string;
  mode: Mode;
  channel: 'email' | 'sms';
  request: Record<string, unknown>;
  send_at: Date;
  status: ScheduledSend['status'];
  summary: string;
  recipients: string[];
  message_id: string | null;
  error: string | null;
  created_at: Date;
  updated_at: Date;
}

function toScheduled(row: ScheduledRow): ScheduledSend {
  return {
    id: row.id,
    projectId: row.project_id,
    mode: row.mode,
    channel: row.channel,
    request: row.request,
    sendAt: row.send_at,
    status: row.status,
    summary: row.summary,
    recipients: row.recipients,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.message_id !== null && { messageId: row.message_id }),
    ...(row.error !== null && { error: row.error }),
  };
}

interface TemplateRow {
  id: string;
  project_id: string;
  alias: string;
  name: string;
  channel: 'email' | 'sms';
  subject: string | null;
  html: string | null;
  text: string | null;
  body: string | null;
  created_at: Date;
  updated_at: Date;
}

function toTemplate(row: TemplateRow): Template {
  return {
    id: row.id,
    projectId: row.project_id,
    alias: row.alias,
    name: row.name,
    channel: row.channel,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ...(row.subject !== null && { subject: row.subject }),
    ...(row.html !== null && { html: row.html }),
    ...(row.text !== null && { text: row.text }),
    ...(row.body !== null && { body: row.body }),
  };
}

interface InboundRow {
  id: string;
  project_id: string;
  body: Omit<InboundEmail, 'id' | 'projectId' | 'createdAt'>;
  created_at: Date;
}

function toInbound(row: InboundRow): InboundEmail {
  return { id: row.id, projectId: row.project_id, ...row.body, createdAt: row.created_at };
}

interface AuditRow {
  id: string;
  project_id: string;
  actor: AuditActor;
  action: string;
  params: Record<string, string> | null;
  details: Record<string, unknown> | null;
  ip: string | null;
  mode: Mode;
  created_at: Date;
}

interface RequestRow {
  id: string;
  project_id: string;
  key_id: string;
  key_name: string;
  mode: Mode;
  method: string;
  path: string;
  status: number;
  duration_ms: number;
  ip: string | null;
  error: string | null;
  created_at: Date;
}

interface AttemptRow {
  id: string;
  project_id: string;
  event_id: string;
  event_type: WebhookAttempt['eventType'];
  recipient: string;
  url: string;
  attempt: number;
  max_attempts: number;
  trigger: WebhookAttempt['trigger'];
  ok: boolean;
  status_code: number | null;
  error: string | null;
  response_body: string | null;
  duration_ms: number;
  will_retry: boolean;
  created_at: Date;
  endpoint_id: string | null;
}

interface EndpointRow {
  id: string;
  project_id: string;
  url: string;
  secret: string;
  description: string | null;
  events: NonNullable<WebhookEndpoint['events']> | null;
  mode: Mode | null;
  enabled: boolean;
  created_at: Date;
}

function toEndpoint(row: EndpointRow): WebhookEndpoint {
  return {
    id: row.id,
    projectId: row.project_id,
    url: row.url,
    secret: row.secret,
    enabled: row.enabled,
    createdAt: row.created_at,
    ...(row.description !== null && { description: row.description }),
    ...(row.events !== null && { events: row.events }),
    ...(row.mode !== null && { mode: row.mode }),
  };
}

function toAttempt(row: AttemptRow): WebhookAttempt {
  return {
    id: row.id,
    projectId: row.project_id,
    eventId: row.event_id,
    eventType: row.event_type,
    recipient: row.recipient,
    url: row.url,
    attempt: row.attempt,
    maxAttempts: row.max_attempts,
    trigger: row.trigger,
    ok: row.ok,
    durationMs: row.duration_ms,
    willRetry: row.will_retry,
    createdAt: row.created_at,
    ...(row.status_code !== null && { statusCode: row.status_code }),
    ...(row.error !== null && { error: row.error }),
    ...(row.response_body !== null && { responseBody: row.response_body }),
    ...(row.endpoint_id !== null && { endpointId: row.endpoint_id }),
  };
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    ...(row.email_verified_at && { emailVerifiedAt: row.email_verified_at }),
    ...(row.two_factor && {
      twoFactor: { ...row.two_factor, ...(row.two_factor.enabledAt && { enabledAt: new Date(row.two_factor.enabledAt) }) } as TwoFactor,
    }),
  };
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    webhookSecret: row.webhook_secret,
    createdAt: row.created_at,
    ...(row.owner_id && { ownerId: row.owner_id }),
    ...(row.webhook_url && { webhookUrl: row.webhook_url }),
    ...(row.reports_smtp_url && { reportsSmtpUrl: row.reports_smtp_url }),
    ...(row.managed_access && { managedAccess: row.managed_access }),
    ...(row.limits && { limits: row.limits }),
    ...(row.options && { options: row.options }),
    ...(row.inbound_token && { inboundToken: row.inbound_token }),
  };
}

interface DomainRow {
  id: string;
  project_id: string;
  domain: string;
  selector: string;
  dkim_public_key: string;
  dkim_private_key: string;
  checks: SendingDomain['checks'];
  verified_at: Date | null;
  last_checked_at: Date | null;
  created_at: Date;
}

function toDomain(row: DomainRow): SendingDomain {
  return {
    id: row.id,
    projectId: row.project_id,
    domain: row.domain,
    selector: row.selector,
    dkimPublicKey: row.dkim_public_key,
    dkimPrivateKey: row.dkim_private_key,
    checks: row.checks,
    createdAt: new Date(row.created_at),
    ...(row.verified_at && { verifiedAt: new Date(row.verified_at) }),
    ...(row.last_checked_at && { lastCheckedAt: new Date(row.last_checked_at) }),
  };
}

function toConnection(row: ConnectionRow): Connection {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    channel: row.channel,
    provider: row.provider,
    settings: row.settings,
    secrets: row.secrets,
    priority: row.priority,
    inboundToken: row.inbound_token,
    createdAt: new Date(row.created_at),
  };
}

function toKey(row: KeyRow): ApiKey {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    prefix: row.prefix,
    keyHash: row.key_hash,
    mode: row.mode === 'live' ? 'live' : 'test',
    permission: row.permission ?? 'full',
    ...(row.allowed_domains && { allowedDomains: row.allowed_domains }),
    createdAt: new Date(row.created_at),
    ...(row.last_used_at && { lastUsedAt: new Date(row.last_used_at) }),
    ...(row.revoked_at && { revokedAt: new Date(row.revoked_at) }),
  };
}

function toMessage(row: MessageRow): SimMessage {
  return {
    id: row.id,
    projectId: row.project_id,
    via: row.via,
    from: row.from_address,
    recipients: row.recipients,
    subject: row.subject,
    createdAt: row.created_at,
    ...(row.relayo_message_id && { relayoMessageId: row.relayo_message_id }),
    ...(row.metadata && { metadata: row.metadata }),
    ...(row.tags && { tags: row.tags }),
    ...(row.envelope_from && { envelopeFrom: row.envelope_from }),
    ...(row.headers && { headers: row.headers }),
    ...(row.size !== null && row.size !== undefined && { size: row.size }),
    ...(row.channel === 'sms' && { channel: 'sms' as const }),
    ...(row.body !== null && row.body !== undefined && { body: row.body }),
    ...(row.mode === 'live' && { mode: 'live' as const }),
    ...(row.delivery && { delivery: row.delivery }),
    ...(row.template && { template: row.template }),
  };
}

/** `host:port/database` of a connection string, without the credentials, for error messages. */
function describeTarget(connectionString: string): string {
  try {
    const url = new URL(connectionString);
    return `${url.hostname}:${url.port || 5432}${url.pathname}`;
  } catch {
    return 'the configured DATABASE_URL';
  }
}
