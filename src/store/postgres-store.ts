import pg from 'pg';
import type { ApiKey, MessageListItem, MessageWithEvents, Project, ProjectStats, Session, SimEvent, SimMessage, User } from '../domain.js';
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
  created_at: Date;
}

interface ProjectRow {
  id: string;
  name: string;
  owner_id: string | null;
  webhook_url: string | null;
  webhook_secret: string;
  reports_smtp_url: string | null;
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
    const pool = new pg.Pool({ connectionString, max: 10, ...(options.schema && { options: `-c search_path=${options.schema}` }) });
    if (options.schema) await pool.query(`CREATE SCHEMA IF NOT EXISTS ${options.schema}`);
    await pool.query(SCHEMA);
    return new PostgresStore(pool);
  }

  /** Drops a schema created with `connect(..., { schema })`. */
  async dropSchema(schema: string): Promise<void> {
    if (!/^[a-z_][a-z0-9_]*$/.test(schema)) throw new Error(`Invalid schema name: ${schema}`);
    await this.pool.query(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  }

  // --- Accounts ---------------------------------------------------------------------------------

  async createUser(u: User): Promise<void> {
    await this.pool.query('INSERT INTO users (id, email, name, password_hash, created_at) VALUES ($1, $2, $3, $4, $5)', [
      u.id,
      u.email.toLowerCase(),
      u.name,
      u.passwordHash,
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

  async updateUser(id: string, changes: Partial<Pick<User, 'name' | 'passwordHash'>>): Promise<void> {
    await this.pool.query('UPDATE users SET name = COALESCE($2, name), password_hash = COALESCE($3, password_hash) WHERE id = $1', [
      id,
      changes.name ?? null,
      changes.passwordHash ?? null,
    ]);
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
      'INSERT INTO projects (id, name, owner_id, webhook_url, webhook_secret, reports_smtp_url, created_at) VALUES ($1, $2, $3, $4, $5, $6, $7)',
      [p.id, p.name, p.ownerId ?? null, p.webhookUrl ?? null, p.webhookSecret, p.reportsSmtpUrl ?? null, p.createdAt],
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

  async updateProject(id: string, changes: ProjectChanges): Promise<void> {
    const columns = { name: 'name', webhookUrl: 'webhook_url', reportsSmtpUrl: 'reports_smtp_url', webhookSecret: 'webhook_secret', ownerId: 'owner_id' } as const;
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
      'INSERT INTO api_keys (id, project_id, name, prefix, key_hash, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [k.id, k.projectId, k.name, k.prefix, k.keyHash, k.createdAt],
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
      `INSERT INTO messages (id, project_id, via, relayo_message_id, from_address, recipients, subject, metadata, tags, envelope_from, headers, created_at, size)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13) ON CONFLICT (id) DO NOTHING`,
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

  async listMessages(projectId: string, { limit, before, search, status }: MessageQuery): Promise<MessageListItem[]> {
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
         AND ($3::text IS NULL OR m.subject ILIKE $3 OR m.from_address ILIKE $3 OR m.recipients::text ILIKE $3)
         AND ($4::text IS NULL OR EXISTS (SELECT 1 FROM events s WHERE s.message_id = m.id AND s.type = $4))
       ORDER BY m.created_at DESC LIMIT $5`,
      [projectId, before ?? null, search?.trim() ? `%${escapeLike(search.trim())}%` : null, status ?? null, limit],
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

  async stats(projectId: string, since: Date): Promise<ProjectStats> {
    const stats = emptyStats(since);
    const [messages, events, daily] = await Promise.all([
      this.pool.query<{ count: string }>('SELECT count(*) FROM messages WHERE project_id = $1 AND created_at >= $2', [projectId, since]),
      this.pool.query<{ type: string; bounce_type: string | null; count: string }>(
        `SELECT type, body->>'bounceType' AS bounce_type, count(*) FROM events
         WHERE project_id = $1 AND occurred_at >= $2 GROUP BY 1, 2`,
        [projectId, since],
      ),
      this.pool.query<{ day: string; type: string; count: string }>(
        `SELECT to_char(occurred_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS day, type, count(*) FROM events
         WHERE project_id = $1 AND occurred_at >= $2 AND type IN ('delivered', 'bounced', 'deferred', 'complained')
         GROUP BY 1, 2`,
        [projectId, since],
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
    await this.pool.query('TRUNCATE events, message_contents, messages, api_keys, projects, sessions, users, smtp_attempts');
  }
}

function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, '\\$&');
}

function toUser(row: UserRow): User {
  return { id: row.id, email: row.email, name: row.name, passwordHash: row.password_hash, createdAt: row.created_at };
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
  };
}

function toKey(row: KeyRow): ApiKey {
  return {
    id: row.id,
    projectId: row.project_id,
    name: row.name,
    prefix: row.prefix,
    keyHash: row.key_hash,
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
  };
}
