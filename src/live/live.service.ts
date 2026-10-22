import { randomBytes, randomUUID } from 'node:crypto';
import {
  AuthenticationError,
  createRelayo,
  failover,
  isRelayoError,
  RateLimitError,
  ValidationError,
  type Driver,
  type EmailMessage,
  type Recipient,
  type RelayoEvent,
  type WebhookRequest,
} from '@alimzen/relayo';
import type { Connection, Project, SimEvent, SimMessage, SuppressionReason } from '../domain.js';
import type { SimStore } from '../store/store.js';
import type { WebhookDispatcher } from '../webhooks/webhooks.js';
import { ses } from '@alimzen/relayo-ses';
import { timingSafeEqual } from 'node:crypto';
import type { SendingDomain } from '../domain.js';
import type { ManagedSending } from './managed.js';
import { buildDriver, MANAGED_PROVIDER, PROVIDERS, PROVIDERS_BY_NAME, splitValues, type ProviderSpec } from './providers.js';
import type { SecretBox } from './secrets.js';

/** A live send that could not be delivered, with the HTTP status the API answers with. */
export class LiveError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = 'LiveError';
  }
}

export interface LiveEmail {
  message: EmailMessage;
  via: SimMessage['via'];
  /** The Relayo message id of the sender's library, so events come back with it. */
  relayoMessageId?: string;
  /** The captured MIME source, for the panel's inbox. */
  raw?: Buffer;
  /** Original headers, shown in the panel. */
  headers?: Record<string, string>;
}

/** What the panel shows of a connection: never its secrets. */
export interface PublicConnection {
  id: string;
  name: string;
  channel: 'email' | 'sms';
  provider: string;
  providerLabel: string;
  settings: Record<string, string>;
  /** Names of the secret fields that are set. */
  secretsSet: string[];
  priority: number;
  inboundPath: string;
  webhooks: { supported: boolean; help: string };
  createdAt: Date;
}

/**
 * Live mode: real delivery through the project's own provider connections, with Relayo's library drivers,
 * failover in priority order, a suppression list, and the same events and webhook as test mode.
 */
export class LiveService {
  constructor(
    private readonly store: SimStore,
    private readonly webhooks: WebhookDispatcher,
    private readonly box: SecretBox | undefined,
    /** Relayo's own relay, when the platform offers it. */
    readonly managed?: ManagedSending,
  ) {}

  /** The providers a project can connect here, Relayo's own sending first when it is offered. */
  providers(): ProviderSpec[] {
    return this.managed ? [MANAGED_PROVIDER, ...PROVIDERS] : [...PROVIDERS];
  }

  // --- Connections ------------------------------------------------------------------------------

  private requireBox(): SecretBox {
    if (!this.box) throw new LiveError('El servidor no tiene SECRETS_KEY: no puede guardar credenciales de proveedores.', 503);
    return this.box;
  }

  async createConnection(project: Project, input: { name?: unknown; provider?: unknown; values?: unknown }): Promise<Connection> {
    const box = this.requireBox();
    if (input.provider === 'managed') return this.createManagedConnection(project, input.name);
    const spec = typeof input.provider === 'string' ? PROVIDERS_BY_NAME.get(input.provider as never) : undefined;
    if (!spec) throw new LiveError('Proveedor desconocido', 400);
    const values = (input.values && typeof input.values === 'object' ? input.values : {}) as Record<string, unknown>;
    const { settings, secrets } = this.validate(() => splitValues(spec, values));
    const existing = await this.store.listConnections(project.id, spec.channel);
    const connection: Connection = {
      id: `con_${randomUUID()}`,
      projectId: project.id,
      name: (typeof input.name === 'string' && input.name.trim().slice(0, 80)) || spec.label,
      channel: spec.channel,
      provider: spec.name,
      settings,
      secrets: box.seal(secrets),
      priority: existing.length ? Math.max(...existing.map((c) => c.priority)) + 1 : 0,
      inboundToken: randomBytes(24).toString('base64url'),
      createdAt: new Date(),
    };
    // Build it once now, so a bad combination of settings fails here and not on the first send.
    this.validate(() => buildDriver(connection, { ...settings, ...secrets }));
    await this.store.createConnection(connection);
    return connection;
  }

  private async createManagedConnection(project: Project, name: unknown): Promise<Connection> {
    if (!this.managed) throw new LiveError('El envío de Relayo no está disponible en este servidor', 400);
    const existing = await this.store.listConnections(project.id, 'email');
    if (existing.some((c) => c.provider === 'managed')) throw new LiveError('El envío de Relayo ya está activado en este proyecto', 409);
    const connection: Connection = {
      id: `con_${randomUUID()}`,
      projectId: project.id,
      name: (typeof name === 'string' && name.trim().slice(0, 80)) || MANAGED_PROVIDER.label,
      channel: 'email',
      provider: 'managed',
      settings: {},
      secrets: this.requireBox().seal({}),
      priority: existing.length ? Math.max(...existing.map((c) => c.priority)) + 1 : 0,
      inboundToken: randomBytes(24).toString('base64url'),
      createdAt: new Date(),
    };
    await this.store.createConnection(connection);
    return connection;
  }

  // --- Domains (Relayo's managed sending) -------------------------------------------------------

  private requireManaged(): ManagedSending {
    if (!this.managed) throw new LiveError('El envío de Relayo no está disponible en este servidor', 400);
    return this.managed;
  }

  async addDomain(project: Project, domain: unknown): Promise<SendingDomain> {
    const managed = this.requireManaged();
    return this.validateAsync(() => managed.addDomain(project, domain));
  }

  async verifyDomain(project: Project, id: string): Promise<SendingDomain> {
    const managed = this.requireManaged();
    return this.validateAsync(() => managed.verify(project, id));
  }

  /** What the panel shows of a domain: its records and their status, never the private key. */
  publicDomain(domain: SendingDomain) {
    return {
      id: domain.id,
      domain: domain.domain,
      verified: Boolean(domain.verifiedAt),
      verifiedAt: domain.verifiedAt ?? null,
      lastCheckedAt: domain.lastCheckedAt ?? null,
      records: this.managed ? this.managed.records(domain) : [],
      createdAt: domain.createdAt,
    };
  }

  private async validateAsync<T>(fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (error) {
      if (error instanceof ValidationError) throw new LiveError(error.message, 400);
      throw error;
    }
  }

  async updateConnection(project: Project, id: string, input: { name?: unknown; values?: unknown }): Promise<Connection> {
    const box = this.requireBox();
    const connection = await this.store.getConnection(project.id, id);
    if (!connection) throw new LiveError('Conexión no encontrada', 404);
    const spec = PROVIDERS_BY_NAME.get(connection.provider as never);
    const changes: Partial<Pick<Connection, 'name' | 'settings' | 'secrets'>> = {};
    if (typeof input.name === 'string' && input.name.trim()) changes.name = input.name.trim().slice(0, 80);
    if (spec && input.values && typeof input.values === 'object') {
      const previous = { settings: connection.settings, secrets: box.open<Record<string, string>>(connection.secrets) };
      const { settings, secrets } = this.validate(() => splitValues(spec, input.values as Record<string, unknown>, previous));
      changes.settings = settings;
      changes.secrets = box.seal(secrets);
    }
    await this.store.updateConnection(project.id, id, changes);
    return (await this.store.getConnection(project.id, id))!;
  }

  /** Puts the connections in this order: the first one sends, the rest are failover. */
  async reorder(project: Project, ids: string[]): Promise<void> {
    const connections = await this.store.listConnections(project.id);
    const known = new Set(connections.map((c) => c.id));
    if (ids.some((id) => !known.has(id))) throw new LiveError('Conexión no encontrada', 404);
    for (const [priority, id] of ids.entries()) await this.store.updateConnection(project.id, id, { priority });
  }

  publicConnection(connection: Connection): PublicConnection {
    const spec = connection.provider === 'managed' ? MANAGED_PROVIDER : PROVIDERS_BY_NAME.get(connection.provider as never);
    let secretsSet: string[] = [];
    try {
      secretsSet = this.box ? Object.keys(this.box.open<Record<string, string>>(connection.secrets)) : [];
    } catch {
      // A key change makes old secrets unreadable: the panel shows them as missing so they can be re-entered.
    }
    return {
      id: connection.id,
      name: connection.name,
      channel: connection.channel,
      provider: connection.provider,
      providerLabel: spec?.label ?? connection.provider,
      settings: connection.settings,
      secretsSet,
      priority: connection.priority,
      inboundPath: `/v1/inbound/${connection.inboundToken}`,
      webhooks: spec?.webhooks ?? { supported: false, help: '' },
      createdAt: connection.createdAt,
    };
  }

  private driverFor(connection: Connection): Driver<EmailMessage> {
    if (connection.provider === 'managed') {
      if (!this.managed) throw new LiveError('El envío de Relayo no está disponible en este servidor', 503);
      return this.managed.driver(connection);
    }
    let secrets: Record<string, string>;
    try {
      secrets = this.requireBox().open<Record<string, string>>(connection.secrets);
    } catch (error) {
      if (error instanceof LiveError) throw error;
      throw new LiveError(`No se pueden leer las credenciales de «${connection.name}»: vuelve a introducirlas.`, 500);
    }
    return buildDriver(connection, { ...connection.settings, ...secrets });
  }

  private validate<T>(fn: () => T): T {
    try {
      return fn();
    } catch (error) {
      if (error instanceof ValidationError) throw new LiveError(error.message, 400);
      throw error;
    }
  }

  // --- Sending ----------------------------------------------------------------------------------

  /**
   * Delivers an email through the project's connections, in priority order with failover (or through one
   * connection, to test it). Suppressed recipients are dropped with a `rejected` event. Returns the stored
   * message; throws a `LiveError` when no connection could deliver it.
   */
  async sendEmail(project: Project, input: LiveEmail, only?: Connection): Promise<SimMessage> {
    const connections = only ? [only] : await this.store.listConnections(project.id, 'email');
    if (!connections.length) {
      throw new LiveError('Este proyecto no tiene conexiones de email para el modo en vivo: añade una en Conexiones.', 400);
    }

    const { message } = input;
    const lists = { to: asList(message.to), cc: message.cc ?? [], bcc: message.bcc ?? [] };
    const everyone = unique([...lists.to, ...lists.cc, ...lists.bcc].map((r) => r.address));
    const blocked = await this.store.suppressed(project.id, everyone);
    const allowed = (list: Recipient[]) => list.filter((r) => !blocked.has(r.address.toLowerCase()));

    const stored: SimMessage = {
      id: `sim_${randomUUID()}`,
      projectId: project.id,
      mode: 'live',
      via: input.via,
      from: message.from.address,
      recipients: everyone.map((address) => ({ address, scenario: { name: 'live', source: 'default' } })),
      subject: message.subject,
      createdAt: new Date(),
      ...(input.relayoMessageId && { relayoMessageId: input.relayoMessageId }),
      ...(message.metadata && { metadata: message.metadata }),
      ...(message.tags?.length && { tags: message.tags }),
      ...(input.headers && Object.keys(input.headers).length && { headers: input.headers }),
      ...(input.raw && { size: input.raw.length }),
    };
    await this.store.saveMessage(stored, input.raw);

    const events: SimEvent[] = [];
    for (const address of everyone.filter((a) => blocked.has(a.toLowerCase()))) {
      events.push(this.event(stored, address, 'rejected', 'suppressed', { reason: 'suppressed', diagnostic: 'The address is on the project suppression list' }));
    }

    const to = allowed(lists.to);
    const cc = allowed(lists.cc);
    const bcc = allowed(lists.bcc);
    const sendable = [...to, ...cc, ...bcc];
    if (!sendable.length) {
      await this.record(project, events);
      return stored;
    }

    const drivers = connections.map((c) => this.driverFor(c)) as [Driver<EmailMessage>, ...Driver<EmailMessage>[]];
    const driver = drivers.length === 1 ? drivers[0] : failover(drivers, { name: 'relayo' });
    // The provider message carries our id (the drivers attach it), so its webhooks map back to this message.
    const relayo = createRelayo({ email: driver, generateId: () => stored.id });

    try {
      const result = await relayo.email.send({
        ...message,
        to: to.length ? to : (cc[0] ?? bcc[0])!,
        ...(cc.length ? { cc } : { cc: undefined }),
        ...(bcc.length ? { bcc } : { bcc: undefined }),
      } as EmailMessage);
      const connection = connections.find((c) => c.id === result.provider) ?? connections[0]!;
      const delivery = {
        connectionId: connection.id,
        provider: connection.provider,
        ...(result.providerMessageId && { providerMessageId: result.providerMessageId }),
      };
      await this.store.setDelivery(project.id, stored.id, delivery);
      stored.delivery = delivery;
      const refused = new Set((result.rejectedRecipients ?? []).map((a) => a.toLowerCase()));
      for (const recipient of sendable) {
        events.push(
          refused.has(recipient.address.toLowerCase())
            ? this.event(stored, recipient.address, 'rejected', 'refused', { reason: 'invalid_recipient', diagnostic: 'Refused by the provider' })
            : this.event(stored, recipient.address, 'accepted', 'accepted', {}, { delivery }),
        );
      }
      await this.record(project, events);
      return stored;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      for (const recipient of sendable) {
        events.push(this.event(stored, recipient.address, 'failed', 'failed', { diagnostic: text }));
      }
      await this.record(project, events);
      throw toLiveError(error);
    }
  }

  /** Sends a short real email through one connection, to check its credentials. */
  async testConnection(project: Project, id: string, input: { to?: unknown; from?: unknown }): Promise<SimMessage> {
    const connection = await this.store.getConnection(project.id, id);
    if (!connection) throw new LiveError('Conexión no encontrada', 404);
    const email = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    const to = typeof input.to === 'string' ? input.to.trim() : '';
    const from = typeof input.from === 'string' ? input.from.trim() : '';
    if (!email.test(to)) throw new LiveError('Introduce un email válido como destinatario de la prueba', 400);
    // The sender must be one the provider accepts (a verified domain or address there).
    if (!email.test(from)) throw new LiveError('Introduce un remitente válido, de un dominio verificado en el proveedor', 400);
    return this.sendEmail(
      project,
      {
        via: 'api',
        message: {
          from: { address: from, name: 'Relayo' },
          to: { address: to },
          subject: `Prueba de la conexión «${connection.name}»`,
          text: `Si lees esto, la conexión «${connection.name}» (${connection.provider}) de Relayo funciona.`,
        },
      },
      connection,
    );
  }

  // --- Provider webhooks -------------------------------------------------------------------------

  /**
   * A webhook from a connection's provider: verified and normalized by the library driver, then stored on
   * the message it belongs to, applied to the suppression list, and forwarded to the project's webhook.
   * Returns how many events were recorded.
   */
  async handleInbound(token: string, req: WebhookRequest): Promise<number> {
    const connection = await this.store.findConnectionByInboundToken(token);
    if (!connection) throw new LiveError('Not found', 404);
    const project = await this.store.getProject(connection.projectId);
    if (!project) throw new LiveError('Not found', 404);
    const driver = this.driverFor(connection);
    if (!driver.parseWebhook) throw new LiveError('This provider does not send webhooks', 400);
    if (driver.verifyWebhook && !(await driver.verifyWebhook(req))) throw new LiveError('Invalid webhook signature', 401);

    const parsed = await driver.parseWebhook(req);
    const events: SimEvent[] = [];
    for (const upstream of parsed) {
      // Drivers report our message id (we attached it when sending); events of other mail are ignored.
      const message = await this.store.getMessage(project.id, upstream.messageId);
      if (!message || message.mode !== 'live') continue;
      events.push(this.fromUpstream(message, upstream, connection));
      await this.applySuppression(project, upstream);
    }
    await this.record(project, events);
    return events.length;
  }

  /**
   * Events of Relayo's own relay (Amazon SES through SNS): one endpoint for every project, each event
   * finding its message by the Relayo id the relay carried.
   */
  async handleManagedInbound(token: string, req: WebhookRequest): Promise<number> {
    const expected = this.managed?.config.eventsToken;
    if (!expected || !safeEqual(token, expected)) throw new LiveError('Not found', 404);
    const driver = ses({ name: 'managed', region: 'us-east-1', webhook: { confirmSubscriptions: true } });
    if (!(await driver.verifyWebhook!(req))) throw new LiveError('Invalid webhook signature', 401);

    let recorded = 0;
    for (const upstream of await driver.parseWebhook!(req)) {
      const message = await this.store.findMessage(upstream.messageId);
      if (!message || message.mode !== 'live' || message.delivery?.provider !== 'managed') continue;
      const project = await this.store.getProject(message.projectId);
      if (!project) continue;
      const connection = (await this.store.getConnection(project.id, message.delivery.connectionId)) ?? {
        id: message.delivery.connectionId,
        provider: 'managed',
      };
      await this.applySuppression(project, upstream);
      await this.record(project, [this.fromUpstream(message, upstream, connection as Connection)]);
      recorded++;
    }
    return recorded;
  }

  private fromUpstream(message: SimMessage, upstream: RelayoEvent, connection: Connection): SimEvent {
    const { id: _id, messageId: _m, providerMessageId, provider: _p, raw, timestamp, ...rest } = upstream;
    return {
      ...rest,
      id: `${message.id}:${connection.id}:${upstream.id}`,
      provider: 'relayo',
      messageId: message.relayoMessageId ?? message.id,
      providerMessageId: message.id,
      timestamp: new Date(timestamp),
      ...(message.metadata && { metadata: message.metadata }),
      raw: { upstream: { provider: connection.provider, connectionId: connection.id, providerMessageId, raw } },
      projectId: message.projectId,
    } as SimEvent;
  }

  private async applySuppression(project: Project, event: RelayoEvent): Promise<void> {
    const reason: SuppressionReason | undefined =
      event.type === 'bounced' && (event as { bounceType?: string }).bounceType === 'hard'
        ? 'hard_bounce'
        : event.type === 'complained'
          ? 'complaint'
          : event.type === 'unsubscribed'
            ? 'unsubscribe'
            : undefined;
    if (reason) await this.store.suppress(project.id, event.recipient, reason);
  }

  // --- Events -----------------------------------------------------------------------------------

  private event(
    message: SimMessage,
    recipient: string,
    type: SimEvent['type'],
    suffix: string,
    extra: Record<string, unknown>,
    raw: Record<string, unknown> = {},
  ): SimEvent {
    return {
      id: `${message.id}:${recipient}:${suffix}`,
      type,
      channel: message.channel ?? 'email',
      provider: 'relayo',
      messageId: message.relayoMessageId ?? message.id,
      providerMessageId: message.id,
      recipient,
      timestamp: new Date(),
      ...(message.metadata && { metadata: message.metadata }),
      raw: { mode: 'live', ...raw },
      ...extra,
      projectId: message.projectId,
    } as SimEvent;
  }

  /** Stores events and forwards them to the project's webhook, like simulated ones. */
  private async record(project: Project, events: SimEvent[]): Promise<void> {
    for (const event of events) {
      await this.store.addEvent(event);
      if (project.webhookUrl) await this.webhooks.dispatch(event, { url: project.webhookUrl, secret: project.webhookSecret });
    }
  }
}

function asList(value: Recipient | Recipient[]): Recipient[] {
  return Array.isArray(value) ? value : [value];
}

function unique(addresses: string[]): string[] {
  const seen = new Set<string>();
  return addresses.filter((a) => (seen.has(a.toLowerCase()) ? false : (seen.add(a.toLowerCase()), true)));
}

/** The API answer for a failed live send, keeping the provider's reason. */
function toLiveError(error: unknown): LiveError {
  if (error instanceof LiveError) return error;
  const text = error instanceof Error ? error.message : String(error);
  if (error instanceof AuthenticationError) return new LiveError(`El proveedor rechazó las credenciales de la conexión: ${text}`, 502);
  if (error instanceof RateLimitError) return new LiveError(`El proveedor limita los envíos: ${text}`, 429);
  if (error instanceof ValidationError) return new LiveError(text, 422);
  if (isRelayoError(error)) return new LiveError(text, error.retryable ? 503 : 422);
  return new LiveError(`No se pudo entregar: ${text}`, 502);
}

function safeEqual(a: string, b: string): boolean {
  const x = Buffer.from(a);
  const y = Buffer.from(b);
  return x.length === y.length && timingSafeEqual(x, y);
}
