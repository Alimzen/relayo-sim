import { createPrivateKey } from 'node:crypto';
import { CreateEmailIdentityCommand, GetEmailIdentityCommand, SESv2Client } from '@aws-sdk/client-sesv2';

/**
 * The relay's own list of sender domains. Amazon SES only sends from identities verified in its account, so
 * each domain a project adds is registered there too, with the same DKIM key and selector (Bring Your Own
 * DKIM): the record the customer already publishes verifies it in SES as well, with nothing else to add.
 */
export interface RelayIdentities {
  /** Shown in the panel next to the DNS checks. */
  readonly name: string;
  create(domain: string, selector: string, privateKeyPem: string): Promise<void>;
  /** Whether the relay accepts the domain as a sender yet. */
  verified(domain: string): Promise<boolean>;
}

/** Credentials come from the usual AWS chain (AWS_ACCESS_KEY_ID / AWS_SECRET_ACCESS_KEY, a role...). */
export class SesIdentities implements RelayIdentities {
  readonly name = 'Amazon SES';
  private readonly client: SESv2Client;

  constructor(region: string, client?: SESv2Client) {
    this.client = client ?? new SESv2Client({ region });
  }

  async create(domain: string, selector: string, privateKeyPem: string): Promise<void> {
    // SES wants the RSA key as base64 DER, without the PEM armor.
    const key = createPrivateKey(privateKeyPem).export({ type: 'pkcs1', format: 'der' }).toString('base64');
    try {
      await this.client.send(
        new CreateEmailIdentityCommand({ EmailIdentity: domain, DkimSigningAttributes: { DomainSigningSelector: selector, DomainSigningPrivateKey: key } }),
      );
    } catch (error) {
      // Registered before (by this project, removed and added again, or another one): SES keeps the first key.
      if ((error as Error).name !== 'AlreadyExistsException') throw error;
    }
  }

  async verified(domain: string): Promise<boolean> {
    try {
      const identity = await this.client.send(new GetEmailIdentityCommand({ EmailIdentity: domain }));
      return identity.VerifiedForSendingStatus === true;
    } catch (error) {
      if ((error as Error).name === 'NotFoundException') return false;
      throw error;
    }
  }
}
