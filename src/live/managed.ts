import { generateKeyPairSync, randomUUID } from 'node:crypto';
import { promises as dns } from 'node:dns';
import { ProviderUnavailableError, RateLimitError, ValidationError, type Driver, type EmailMessage } from '@alimzen/relayo';
import { smtp } from '@alimzen/relayo-smtp';
import type { SimConfig } from '../config.js';
import type { Connection, Project, SendingDomain } from '../domain.js';
import type { SimStore } from '../store/store.js';
import type { RelayIdentities } from './relay-identities.js';
import type { SecretBox } from './secrets.js';

export type ManagedConfig = NonNullable<SimConfig['managed']>;
export type ResolveTxt = (host: string) => Promise<string[][]>;

const SELECTOR = 'relayo';
const DOMAIN = /^(?=.{4,253}$)([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/;

/** A DNS record the customer has to publish, as the panel shows it. */
export interface DnsRecord {
  purpose: 'dkim' | 'spf' | 'dmarc';
  type: 'TXT';
  host: string;
  value: string;
  required: boolean;
  ok: boolean;
}

/**
 * Relayo's managed sending: the platform's own relay, for projects without a provider of their own. Mail is
 * DKIM-signed for the sender's domain, which must be verified first, and each project has a daily limit and
 * is paused when its bounces or complaints show it is hurting the shared reputation.
 */
export class ManagedSending {
  constructor(
    private readonly store: SimStore,
    private readonly box: SecretBox,
    readonly config: ManagedConfig,
    private readonly resolveTxt: ResolveTxt = (host) => dns.resolveTxt(host),
    /** The relay's own list of senders, when it keeps one (Amazon SES). */
    readonly identities?: RelayIdentities,
  ) {}

  async addDomain(project: Project, input: unknown): Promise<SendingDomain> {
    const domain = typeof input === 'string' ? input.trim().toLowerCase().replace(/\.$/, '') : '';
    if (!DOMAIN.test(domain)) throw new ValidationError('Introduce un dominio válido, como empresa.com');
    if ((await this.store.listDomains(project.id)).some((d) => d.domain === domain)) {
      throw new ValidationError(`${domain} ya está añadido`);
    }
    const { publicKey, privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
    const record: SendingDomain = {
      id: `dom_${randomUUID()}`,
      projectId: project.id,
      domain,
      selector: SELECTOR,
      dkimPublicKey: publicKey.export({ type: 'spki', format: 'der' }).toString('base64'),
      dkimPrivateKey: this.box.seal(privateKey.export({ type: 'pkcs8', format: 'pem' }).toString()),
      checks: { dkim: false, spf: false, dmarc: false, ...(this.identities && { relay: false }) },
      createdAt: new Date(),
    };
    if (this.identities) {
      try {
        await this.identities.create(domain, SELECTOR, privateKey.export({ type: 'pkcs8', format: 'pem' }).toString());
      } catch (error) {
        throw new ValidationError(`No se pudo registrar ${domain} en el relay (${this.identities.name}). Inténtalo de nuevo en unos minutos.`, {
          provider: 'managed',
          cause: error,
        });
      }
    }
    await this.store.createDomain(record);
    return record;
  }

  records(domain: SendingDomain): DnsRecord[] {
    const records: DnsRecord[] = [
      {
        purpose: 'dkim',
        type: 'TXT',
        host: `${domain.selector}._domainkey.${domain.domain}`,
        value: `v=DKIM1; k=rsa; p=${domain.dkimPublicKey}`,
        required: true,
        ok: domain.checks.dkim,
      },
    ];
    if (this.config.spfInclude) {
      records.push({
        purpose: 'spf',
        type: 'TXT',
        host: domain.domain,
        value: `v=spf1 include:${this.config.spfInclude} ~all`,
        required: true,
        ok: domain.checks.spf,
      });
    }
    records.push({ purpose: 'dmarc', type: 'TXT', host: `_dmarc.${domain.domain}`, value: 'v=DMARC1; p=none;', required: false, ok: domain.checks.dmarc });
    return records;
  }

  /** Looks the records up in DNS, and marks the domain verified once the required ones are there. */
  async verify(project: Project, id: string): Promise<SendingDomain> {
    const domain = await this.store.getDomain(project.id, id);
    if (!domain) throw new ValidationError('Dominio no encontrado');
    const txt = async (host: string) => (await this.resolveTxt(host).catch(() => [] as string[][])).map((parts) => parts.join(''));
    const [dkim, root, dmarc] = await Promise.all([
      txt(`${domain.selector}._domainkey.${domain.domain}`),
      txt(domain.domain),
      txt(`_dmarc.${domain.domain}`),
    ]);
    const dkimOk = dkim.some((r) => r.replace(/\s+/g, '').includes(`p=${domain.dkimPublicKey}`));
    // Added before the relay kept a list of senders: register it there now.
    if (this.identities && domain.checks.relay === undefined) {
      await this.identities.create(domain.domain, domain.selector, this.box.open<string>(domain.dkimPrivateKey)).catch(() => undefined);
    }
    // The relay checks the same DKIM record on its own schedule: ask it once ours is in DNS. Once it
    // accepts the domain it keeps accepting it.
    const relay = this.identities && (domain.checks.relay === true || (dkimOk && (await this.identities.verified(domain.domain).catch(() => false))));
    const checks = {
      dkim: dkimOk,
      spf: !this.config.spfInclude || root.some((r) => /^v=spf1\b/i.test(r) && r.includes(`include:${this.config.spfInclude}`)),
      dmarc: dmarc.some((r) => /^v=DMARC1\b/i.test(r)),
      ...(relay !== undefined && { relay }),
    };
    const verified = checks.dkim && checks.spf && checks.relay !== false;
    await this.store.updateDomain(project.id, id, {
      checks,
      lastCheckedAt: new Date(),
      ...(verified ? { verifiedAt: domain.verifiedAt ?? new Date() } : { verifiedAt: undefined }),
    } as Parameters<SimStore['updateDomain']>[2]);
    return (await this.store.getDomain(project.id, id))!;
  }

  /**
   * The driver of a project's managed connection: the platform relay, signing each message with the DKIM
   * key of the sender's verified domain. Refusals are errors the failover understands: a missing domain is
   * final; the daily limit and a pause let the next connection try.
   */
  driver(connection: Connection): Driver<EmailMessage> {
    const relay = smtp(this.config.smtpUrl, { name: connection.id });
    return {
      ...relay,
      send: async (message, context) => {
        const domain = await this.domainFor(connection.projectId, message.from.address);
        await this.checkStanding(connection);
        const privateKey = this.box.open<string>(domain.dkimPrivateKey);
        return relay.send(
          { ...message, providerOptions: { ...message.providerOptions, dkim: { domainName: domain.domain, keySelector: domain.selector, privateKey } } },
          context,
        );
      },
    };
  }

  private async domainFor(projectId: string, from: string): Promise<SendingDomain> {
    const name = from.slice(from.lastIndexOf('@') + 1).toLowerCase();
    const domain = (await this.store.listDomains(projectId)).find((d) => d.domain === name);
    if (!domain?.verifiedAt) {
      throw new ValidationError(`El envío de Relayo solo acepta remitentes de dominios verificados: verifica ${name} en Dominios`, { provider: 'managed' });
    }
    return domain;
  }

  private async checkStanding(connection: Connection): Promise<void> {
    const day = new Date().toISOString().slice(0, 10);
    const sent = await this.store.nextAttempt(`managed|${connection.projectId}|${day}`, 2 * 86_400_000);
    if (sent > this.config.dailyLimit) {
      throw new RateLimitError(`Límite diario del envío de Relayo alcanzado (${this.config.dailyLimit} mensajes)`, { provider: 'managed' });
    }
    const since = new Date(Date.now() - 7 * 86_400_000);
    const stats = await this.store.stats(connection.projectId, since, 'live');
    // Shared reputation: past a small sample, too many hard bounces or complaints pause the project.
    if (stats.messages >= 50) {
      const bounceRate = stats.bounces.hard / stats.messages;
      const complaintRate = (stats.events.complained ?? 0) / stats.messages;
      if (bounceRate > 0.05 || complaintRate > 0.003) {
        throw new ProviderUnavailableError(
          'El envío de Relayo está en pausa para este proyecto: demasiados rebotes duros o quejas en los últimos 7 días. Limpia tu lista y escríbenos.',
          { provider: 'managed' },
        );
      }
    }
  }
}
