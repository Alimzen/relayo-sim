import pg from 'pg';
import type { MessageWithEvents, Project, SimEvent, SimMessage } from '../domain.js';
import type { SimStore } from './store.js';

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id text PRIMARY KEY,
  name text NOT NULL,
  api_key_hash text NOT NULL UNIQUE,
  webhook_url text,
  webhook_secret text NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);
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
CREATE TABLE IF NOT EXISTS smtp_attempts (
  key text PRIMARY KEY,
  count integer NOT NULL,
  expires_at timestamptz NOT NULL
);
`;

interface ProjectRow {
  id: string;
  name: string;
  api_key_hash: string;
  webhook_url: string | null;
  webhook_secret: string;
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
  created_at: Date;
}

export class PostgresStore implements SimStore {
  private constructor(private readonly pool: pg.Pool) {}

  /** Connects and creates the tables if they do not exist yet. */
  static async connect(connectionString: string): Promise<PostgresStore> {
    const pool = new pg.Pool({ connectionString, max: 10 });
    await pool.query(SCHEMA);
    return new PostgresStore(pool);
  }

  async createProject(p: Project): Promise<void> {
    await this.pool.query(
      'INSERT INTO projects (id, name, api_key_hash, webhook_url, webhook_secret, created_at) VALUES ($1, $2, $3, $4, $5, $6)',
      [p.id, p.name, p.apiKeyHash, p.webhookUrl ?? null, p.webhookSecret, p.createdAt],
    );
  }

  async findProjectByApiKeyHash(hash: string): Promise<Project | undefined> {
    const { rows } = await this.pool.query<ProjectRow>('SELECT * FROM projects WHERE api_key_hash = $1', [hash]);
    return rows[0] && toProject(rows[0]);
  }

  async getProject(id: string): Promise<Project | undefined> {
    const { rows } = await this.pool.query<ProjectRow>('SELECT * FROM projects WHERE id = $1', [id]);
    return rows[0] && toProject(rows[0]);
  }

  async updateProject(id: string, changes: Partial<Pick<Project, 'name' | 'webhookUrl'>>): Promise<void> {
    await this.pool.query(
      'UPDATE projects SET name = COALESCE($2, name), webhook_url = COALESCE($3, webhook_url) WHERE id = $1',
      [id, changes.name ?? null, changes.webhookUrl ?? null],
    );
  }

  async saveMessage(m: SimMessage): Promise<void> {
    await this.pool.query(
      `INSERT INTO messages (id, project_id, via, relayo_message_id, from_address, recipients, subject, metadata, tags, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) ON CONFLICT (id) DO NOTHING`,
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
        m.createdAt,
      ],
    );
  }

  async getMessage(projectId: string, id: string): Promise<MessageWithEvents | undefined> {
    const { rows } = await this.pool.query<MessageRow>('SELECT * FROM messages WHERE id = $1 AND project_id = $2', [id, projectId]);
    if (!rows[0]) return undefined;
    const events = await this.pool.query<{ body: SimEvent }>(
      'SELECT body FROM events WHERE message_id = $1 ORDER BY occurred_at, id',
      [id],
    );
    return {
      ...toMessage(rows[0]),
      events: events.rows.map(({ body }) => ({ ...body, timestamp: new Date(body.timestamp) })),
    };
  }

  async listMessages(projectId: string, { limit, before }: { limit: number; before?: Date }): Promise<SimMessage[]> {
    const { rows } = await this.pool.query<MessageRow>(
      `SELECT * FROM messages WHERE project_id = $1 AND ($2::timestamptz IS NULL OR created_at < $2)
       ORDER BY created_at DESC LIMIT $3`,
      [projectId, before ?? null, limit],
    );
    return rows.map(toMessage);
  }

  async addEvent(event: SimEvent): Promise<void> {
    // Idempotent: a retried job must not record the same event twice.
    await this.pool.query(
      `INSERT INTO events (id, message_id, project_id, type, recipient, occurred_at, body)
       VALUES ($1, $2, $3, $4, $5, $6, $7) ON CONFLICT (id) DO NOTHING`,
      [event.id, event.providerMessageId, event.projectId, event.type, event.recipient, event.timestamp, JSON.stringify(event)],
    );
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
    await this.pool.query('TRUNCATE events, messages, projects, smtp_attempts');
  }
}

function toProject(row: ProjectRow): Project {
  return {
    id: row.id,
    name: row.name,
    apiKeyHash: row.api_key_hash,
    webhookSecret: row.webhook_secret,
    createdAt: row.created_at,
    ...(row.webhook_url && { webhookUrl: row.webhook_url }),
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
  };
}
