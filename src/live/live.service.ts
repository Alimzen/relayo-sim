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
  type SmsMessage,
  type WebhookRequest,
} from '@alimzen/relayo';
import type { Connection, ManagedAccess, Project, SimEvent, SimMessage, SuppressionReason } from '../domain.js';
import type { SimStore } from '../store/store.js';
import { webhookTargets, type WebhookDispatcher } from '../webhooks/webhooks.js';
import { ses } from '@alimzen/relayo-ses';
import { timingSafeEqual } from 'node:crypto';
import type { SendingDomain } from '../domain.js';
import { CircuitBreaker } from './breaker.js';
import type { ManagedSending } from './managed.js';
import { buildDriver, canSendSms, MANAGED_PROVIDER, PROVIDERS, PROVIDERS_BY_NAME, splitValues, type ProviderSpec } from './providers.js';
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
  /** Set while the connection is skipped for failing repeatedly: sends try it last until then. */
  pausedUntil: Date | null;
  createdAt: Date;
}

/**
 * Live mode: real delivery through the project's own provider connections, with Relayo's library drivers,
 * failover in priority order, a suppression list, and the same events and webhook as test mode.
 */
export class LiveService {
  private readonly breaker = new CircuitBreaker();

  constructor(
    private readonly store: SimStore,
    private readonly webhooks: WebhookDispatcher,
    private readonly box: SecretBox | undefined,
    /** Relayo's own relay, when the platform offers it. */
    readonly managed?: ManagedSending,
    /** Public address of this server, for the status callbacks of providers told per message (Twilio). */
    private readonly publicUrl?: string,
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

  /**
   * Seals every stored secret with the current SECRETS_KEY, after a key change (the old key in
   * SECRETS_KEY_PREVIOUS). Values that no key opens are counted and left as they are.
   */
  async resealSecrets(): Promise<{ resealed: number; unreadable: number }> {
    if (!this.box) return { resealed: 0, unreadable: 0 };
    let resealed = 0;
    let unreadable = 0;
    for (const item of await this.store.listSealed()) {
      let fresh: string | undefined;
      try {
        fresh = this.box.reseal(item.value);
      } catch {
        unreadable++;
        continue;
      }
      if (fresh) {
        await this.store.updateSealed(item, fresh);
        resealed++;
      }
    }
    return { resealed, unreadable };
  }

  /** Live mode needs the owner's email verified. Projects without an owner were created by an operator. */
  async assertCanGoLive(project: Project): Promise<void> {
    if (!project.ownerId) return;
    const owner = await this.store.getUser(project.ownerId);
    if (!owner?.emailVerifiedAt) {
      throw new LiveError('Confirma tu email para usar el modo en vivo: revisa tu bandeja de entrada o pide otro enlace desde el panel.', 403);
    }
  }

  /** Asks for Relayo's own sending. Approved at once when the platform does not review requests. */
  async requestManagedAccess(project: Project): Promise<ManagedAccess> {
    if (!this.managed) throw new LiveError('El envío de Relayo no está disponible en este servidor', 400);
    await this.assertCanGoLive(project);
    if (project.managedAccess === 'denied') {
      throw new LiveError('La solicitud del envío de Relayo fue rechazada. Puedes seguir usando tus propias conexiones.', 403);
    }
    if (project.managedAccess) return project.managedAccess;
    const access: ManagedAccess = this.managed.config.approval === 'auto' ? 'approved' : 'requested';
    await this.store.updateProject(project.id, { managedAccess: access });
    return access;
  }

  /** An admin's answer to a request; `denied` also stops a project that was already sending. */
  async decideManagedAccess(projectId: string, decision: unknown): Promise<Project> {
    if (decision !== 'approved' && decision !== 'denied') throw new LiveError('"decision" must be approved or denied', 400);
    const project = await this.store.getProject(projectId);
    if (!project) throw new LiveError('Proyecto no encontrado', 404);
    await this.store.updateProject(projectId, { managedAccess: decision });
    return { ...project, managedAccess: decision };
  }

  async createConnection(project: Project, input: { name?: unknown; provider?: unknown; values?: unknown }): Promise<Connection> {
    const box = this.requireBox();
    await this.assertCanGoLive(project);
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
    // A Twilio connection with only a WhatsApp sender is checked as the WhatsApp driver it will be.
    const combined = { ...settings, ...secrets };
    this.validate(() => buildDriver(connection, combined, undefined, connection.provider === 'twilio' && !canSendSms(combined)));
    await this.store.createConnection(connection);
    return connection;
  }

  private async createManagedConnection(project: Project, name: unknown): Promise<Connection> {
    if (!this.managed) throw new LiveError('El envío de Relayo no está disponible en este servidor', 400);
    if (project.managedAccess !== 'approved') {
      throw new LiveError(
        project.managedAccess === 'requested'
          ? 'Tu solicitud del envío de Relayo está pendiente de revisión.'
          : 'Solicita el envío de Relayo antes de activarlo.',
        403,
      );
    }
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
      relay: this.managed?.identities && domain.checks.relay !== undefined ? { name: this.managed.identities.name, verified: domain.checks.relay } : null,
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
      pausedUntil: this.breaker.pausedUntil(connection.id) ?? null,
      createdAt: connection.createdAt,
    };
  }

  private driverFor(connection: Connection): Driver<EmailMessage> {
    return this.anyDriver(connection) as Driver<EmailMessage>;
  }

  private smsDriverFor(connection: Connection, whatsapp = false): Driver<SmsMessage> {
    return this.anyDriver(connection, whatsapp) as Driver<SmsMessage>;
  }

  private anyDriver(connection: Connection, whatsapp = false): Driver<EmailMessage> | Driver<SmsMessage> {
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
    const statusCallback = this.publicUrl ? `${this.publicUrl}/v1/inbound/${connection.inboundToken}` : undefined;
    const values = { ...connection.settings, ...secrets };
    // A Twilio connection with only a WhatsApp sender is always its WhatsApp driver (its webhooks too).
    const variant = whatsapp || (connection.provider === 'twilio' && !canSendSms(values));
    return buildDriver(connection, values, statusCallback, variant);
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
    const all = only ? [only] : await this.store.listConnections(project.id, 'email');
    // Relayo's relay only for projects an admin approved (or that were not stopped since).
    const connections = all.filter((c) => c.provider !== 'managed' || project.managedAccess === 'approved');
    if (!connections.length) {
      throw new LiveError(
        all.length
          ? 'El envío de Relayo no está aprobado para este proyecto: espera la revisión o añade una conexión propia.'
          : 'Este proyecto no tiene conexiones de email para el modo en vivo: añade una en Conexiones.',
        all.length ? 403 : 400,
      );
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

    // A connection that keeps failing goes last for a while (all of them still get tried).
    const drivers = this.breaker.order(connections).map((c) => this.breaker.watch(c.id, this.driverFor(c))) as [Driver<EmailMessage>, ...Driver<EmailMessage>[]];
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

  /**
   * Delivers an SMS through the project's SMS connections, like `sendEmail`: priority order with failover,
   * suppressed numbers dropped with a `rejected` event.
   */
  async sendSms(
    project: Project,
    input: {
      from?: string;
      to: string[];
      body: string;
      relayoMessageId?: string;
      metadata?: Record<string, string>;
      tags?: string[];
      /** WhatsApp's approved template (Twilio). */
      whatsapp?: { contentSid?: string; contentVariables?: Record<string, string> };
    },
    only?: Connection,
  ): Promise<SimMessage> {
    // WhatsApp (whatsapp:+… recipients) goes through the connections that have a WhatsApp sender.
    const whatsapp = input.to.length > 0 && input.to.every((n) => n.startsWith('whatsapp:'));
    const all = only ? [only] : await this.store.listConnections(project.id, 'sms');
    const connections = all.filter((c) => (whatsapp ? c.settings.whatsappFrom : c.provider !== 'twilio' || canSendSms(c.settings)));
    if (!connections.length) {
      throw new LiveError(
        whatsapp
          ? 'Ninguna conexión tiene remitente de WhatsApp: añádelo en tu conexión de Twilio.'
          : 'Este proyecto no tiene conexiones de SMS para el modo en vivo: añade una (Twilio) en Conexiones.',
        400,
      );
    }
    const everyone = unique(input.to);
    const blocked = await this.store.suppressed(project.id, everyone);
    const stored: SimMessage = {
      id: `sim_${randomUUID()}`,
      projectId: project.id,
      mode: 'live',
      channel: 'sms',
      via: 'api',
      from: input.from ?? '',
      body: input.body,
      recipients: everyone.map((address) => ({ address, scenario: { name: 'live', source: 'default' } })),
      subject: '',
      createdAt: new Date(),
      ...(input.relayoMessageId && { relayoMessageId: input.relayoMessageId }),
      ...(input.metadata && { metadata: input.metadata }),
      ...(input.tags?.length && { tags: input.tags }),
    };
    await this.store.saveMessage(stored);

    const events: SimEvent[] = everyone
      .filter((n) => blocked.has(n.toLowerCase()))
      .map((n) => this.event(stored, n, 'rejected', 'suppressed', { reason: 'suppressed', diagnostic: 'The number is on the project suppression list' }));
    const sendable = everyone.filter((n) => !blocked.has(n.toLowerCase()));
    if (!sendable.length) {
      await this.record(project, events);
      return stored;
    }

    const drivers = this.breaker.order(connections).map((c) => this.breaker.watch(c.id, this.smsDriverFor(c, whatsapp))) as [Driver<SmsMessage>, ...Driver<SmsMessage>[]];
    const driver = drivers.length === 1 ? drivers[0] : failover(drivers, { name: 'relayo' });
    try {
      // The request was checked by the API already: straight to the driver, with our id (as the core would).
      const result = await driver.send(
        {
          to: sendable.map((address) => ({ address })),
          body: input.body,
          ...(input.from && { from: input.from }),
          ...(input.metadata && { metadata: input.metadata }),
          ...(input.whatsapp && { providerOptions: { twilio: input.whatsapp } }),
        },
        { messageId: stored.id },
      );
      const connection = connections.find((c) => c.id === result.provider) ?? connections[0]!;
      const delivery = { connectionId: connection.id, provider: connection.provider, ...(result.providerMessageId && { providerMessageId: result.providerMessageId }) };
      await this.store.setDelivery(project.id, stored.id, delivery);
      stored.delivery = delivery;
      const refused = new Set((result.rejectedRecipients ?? []).map((a) => a.toLowerCase()));
      for (const number of sendable) {
        events.push(
          refused.has(number.toLowerCase())
            ? this.event(stored, number, 'rejected', 'refused', { reason: 'invalid_recipient', diagnostic: 'Refused by the provider' })
            : this.event(stored, number, 'accepted', 'accepted', {}, { delivery }),
        );
      }
      await this.record(project, events);
      return stored;
    } catch (error) {
      const text = error instanceof Error ? error.message : String(error);
      for (const number of sendable) events.push(this.event(stored, number, 'failed', 'failed', { diagnostic: text }));
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
    if (connection.channel === 'sms') {
      if (!/^(whatsapp:)?\+[1-9]\d{6,14}$/.test(to)) {
        throw new LiveError('Introduce un número en formato internacional (+34600111222, o whatsapp:+34600111222) como destinatario de la prueba', 400);
      }
      return this.sendSms(project, { to: [to], body: 'Prueba de Relayo: la conexión funciona.', ...(from && { from }) }, connection);
    }
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
    const driver = this.anyDriver(connection);
    if (!driver.parseWebhook) throw new LiveError('This provider does not send webhooks', 400);
    if (driver.verifyWebhook && !(await driver.verifyWebhook(req))) throw new LiveError('Invalid webhook signature', 401);

    const parsed = await driver.parseWebhook(req);
    const events: SimEvent[] = [];
    for (const upstream of parsed) {
      // Drivers report our message id (we attached it when sending); events of other mail are ignored.
      const message = upstream.messageId ? await this.store.getMessage(project.id, upstream.messageId) : undefined;
      // An opt-out reply (SMS STOP) belongs to no message, but still suppresses the number.
      if (!message && upstream.type === 'unsubscribed' && upstream.recipient) {
        await this.applySuppression(project, upstream);
        continue;
      }
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
      for (const target of await webhookTargets(this.store, project, event, 'live')) await this.webhooks.dispatch(event, target);
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
