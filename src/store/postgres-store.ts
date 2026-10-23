import pg from 'pg';
import type { ManagedAccess, ApiKey, MessageListItem, MessageWithEvents, Project, ProjectStats, Session, SimEvent, SimMessage, User, PasswordReset, Connection, Mode, Suppression, SuppressionReason, SendingDomain } from '../domain.js';
import { emptyStats } from './stats.js';
import type { MessageQuery, ProjectChanges, SimStore } from './store.js';

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
-- Accounts created before email verification existed count as verified (the default fills them once).
ALTER TABLE users ADD COLUMN IF NOT EXISTS email_verified_at timestamptz DEFAULT now();
ALTER TABLE users ALTER COLUMN email_verified_at DROP DEFAULT;
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

  async listManagedAccess(): Promise<Project[]> {
    const { rows } = await this.pool.query<ProjectRow>('SELECT * FROM projects WHERE managed_access IS NOT NULL ORDER BY created_at DESC');
    return rows.map(toProject);
  }

  async updateProject(id: string, changes: ProjectChanges): Promise<void> {
    const columns = { name: 'name', webhookUrl: 'webhook_url', reportsSmtpUrl: 'reports_smtp_url', webhookSecret: 'webhook_secret', ownerId: 'owner_id', managedAccess: 'managed_access' } as const;
    const sets: string[] = [];
    const values: unknown[] = [id];
    for (const [key, column] of Object.entries(columns) as Array<[keyof ProjectChanges, string]>) {
      if (changes[key] === undefined) continue;
      values.push(changes[key]);
      sets.push(`${column} = $${values.length}`);
    }
    if (sets.length) await this.pool.query(`UPDATE projects SET ${sets.join(', ')} WHERE id = $1`, values);
  }

  async createApiKey(k: ApiKey): Promise<void> {
    await this.pool.query(
      'INSERT INTO api_keys (id, project_id, name, prefix, key_hash, created_at, mode) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [k.id, k.projectId, k.name, k.prefix, k.keyHash, k.createdAt, k.mode],
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
      `INSERT INTO messages (id, project_id, via, relayo_message_id, from_address, recipients, subject, metadata, tags, envelope_from, headers, created_at, size, channel, body, mode, delivery)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17) ON CONFLICT (id) DO NOTHING`,
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

  async usePasswordReset(tokenHash: string, purpose: 'reset' | 'verify' = 'reset'): Promise<string | undefined> {
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

  async purge(before: Date): Promise<{ messages: number }> {
    // Events and captured content go with their message (ON DELETE CASCADE).
    const deleted = await this.pool.query('DELETE FROM messages WHERE created_at < $1', [before]);
    await this.pool.query('DELETE FROM sessions WHERE expires_at <= now()');
    await this.pool.query('DELETE FROM password_resets WHERE expires_at <= now()');
    await this.pool.query('DELETE FROM smtp_attempts WHERE expires_at <= now()');
    return { messages: deleted.rowCount ?? 0 };
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
    await this.pool.query('TRUNCATE events, message_contents, messages, usage, password_resets, connections, suppressions, sending_domains, api_keys, projects, sessions, users, smtp_attempts');
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function toUser(row: UserRow): User {
  return {
    id: row.id,
    email: row.email,
    name: row.name,
    passwordHash: row.password_hash,
    createdAt: row.created_at,
    ...(row.email_verified_at && { emailVerifiedAt: row.email_verified_at }),
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
