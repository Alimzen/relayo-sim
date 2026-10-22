import { ValidationError, type Driver, type EmailMessage, type SmsMessage } from '@alimzen/relayo';
import { mailgun } from '@alimzen/relayo-mailgun';
import { postmark } from '@alimzen/relayo-postmark';
import { resend } from '@alimzen/relayo-resend';
import { sendgrid } from '@alimzen/relayo-sendgrid';
import { ses } from '@alimzen/relayo-ses';
import { smtp } from '@alimzen/relayo-smtp';
import { twilio } from '@alimzen/relayo-twilio';
import type { Connection, ProviderName } from '../domain.js';

/** One field of a provider's connection form. Secret fields are encrypted and never sent back to the panel. */
export interface ProviderField {
  key: string;
  label: string;
  secret?: boolean;
  required?: boolean;
  placeholder?: string;
  options?: string[];
  help?: string;
}

export interface ProviderSpec {
  name: ProviderName;
  label: string;
  channel: 'email' | 'sms';
  fields: ProviderField[];
  /** Whether the provider can post delivery events to Relayo, and how to set it up. */
  webhooks: { supported: boolean; help: string };
}

/** Email providers a project can connect, with the library driver behind each one. */
export const PROVIDERS: readonly ProviderSpec[] = [
  {
    name: 'ses',
    label: 'Amazon SES',
    channel: 'email',
    fields: [
      { key: 'region', label: 'Región', required: true, placeholder: 'eu-west-1' },
      { key: 'accessKeyId', label: 'Access key ID', required: true, placeholder: 'AKIA…' },
      { key: 'secretAccessKey', label: 'Secret access key', required: true, secret: true },
      {
        key: 'configurationSetName',
        label: 'Configuration set',
        placeholder: 'relayo',
        help: 'Necesario para recibir eventos: el configuration set publica en el tema SNS suscrito a la URL de eventos.',
      },
    ],
    webhooks: {
      supported: true,
      help: 'En SNS, crea una suscripción HTTPS del tema de eventos del configuration set a la URL de eventos. Relayo la confirma solo.',
    },
  },
  {
    name: 'sendgrid',
    label: 'SendGrid',
    channel: 'email',
    fields: [
      { key: 'apiKey', label: 'API key', required: true, secret: true, placeholder: 'SG.…' },
      { key: 'region', label: 'Región', options: ['global', 'eu'] },
      { key: 'webhookPublicKey', label: 'Clave de verificación del Event Webhook', secret: true, help: 'Settings → Mail Settings → Event Webhook → Signature Verification.' },
    ],
    webhooks: { supported: true, help: 'En Event Webhook, pega la URL de eventos, activa la firma y copia aquí su clave pública.' },
  },
  {
    name: 'resend',
    label: 'Resend',
    channel: 'email',
    fields: [
      { key: 'apiKey', label: 'API key', required: true, secret: true, placeholder: 're_…' },
      { key: 'webhookSecret', label: 'Signing secret del webhook', secret: true, placeholder: 'whsec_…' },
    ],
    webhooks: { supported: true, help: 'En Webhooks, añade la URL de eventos con los eventos email.* y copia aquí su signing secret.' },
  },
  {
    name: 'postmark',
    label: 'Postmark',
    channel: 'email',
    fields: [
      { key: 'serverToken', label: 'Server API token', required: true, secret: true },
      { key: 'messageStream', label: 'Message stream', placeholder: 'outbound' },
    ],
    webhooks: { supported: true, help: 'En el servidor → Webhooks, añade la URL de eventos (Delivery, Bounce, Spam Complaint, Open, Click).' },
  },
  {
    name: 'mailgun',
    label: 'Mailgun',
    channel: 'email',
    fields: [
      { key: 'apiKey', label: 'API key', required: true, secret: true },
      { key: 'domain', label: 'Dominio de envío', required: true, placeholder: 'mg.tudominio.com' },
      { key: 'region', label: 'Región', options: ['us', 'eu'] },
      { key: 'webhookSigningKey', label: 'Webhook signing key', secret: true },
    ],
    webhooks: { supported: true, help: 'En Sending → Webhooks, añade la URL de eventos para cada tipo y copia aquí la signing key.' },
  },
  {
    name: 'smtp',
    label: 'SMTP',
    channel: 'email',
    fields: [
      { key: 'host', label: 'Servidor', required: true, placeholder: 'smtp.tudominio.com' },
      { key: 'port', label: 'Puerto', required: true, placeholder: '587' },
      { key: 'security', label: 'Seguridad', options: ['starttls', 'tls', 'none'] },
      { key: 'username', label: 'Usuario' },
      { key: 'password', label: 'Contraseña', secret: true },
    ],
    webhooks: { supported: false, help: 'SMTP no envía eventos: los rebotes llegan por correo al remitente (puedes leerlos con @alimzen/relayo-imap).' },
  },
  {
    name: 'twilio',
    label: 'Twilio (SMS)',
    channel: 'sms',
    fields: [
      { key: 'accountSid', label: 'Account SID', required: true, placeholder: 'AC…' },
      { key: 'authToken', label: 'Auth token', required: true, secret: true },
      { key: 'from', label: 'Número o remitente', placeholder: '+15550001111', help: 'El número de Twilio que envía, o un remitente alfanumérico.' },
      { key: 'messagingServiceSid', label: 'Messaging Service SID', placeholder: 'MG…', help: 'En lugar de un número: envía por un Messaging Service.' },
    ],
    webhooks: {
      supported: true,
      help: 'Relayo indica a Twilio esta URL en cada envío (StatusCallback). Para recibir las bajas (STOP), ponla también como webhook de mensajes entrantes de tu número.',
    },
  },
];

export const PROVIDERS_BY_NAME = new Map(PROVIDERS.map((p) => [p.name, p]));

/** Relayo's own relay: nothing to fill in, but the sender's domain must be verified in Dominios. */
export const MANAGED_PROVIDER: ProviderSpec = {
  name: 'managed',
  label: 'Envío de Relayo',
  channel: 'email',
  fields: [],
  webhooks: { supported: false, help: 'Relayo recibe los eventos de su propio envío: no hay nada que configurar.' },
};

/** Splits submitted values into plain settings and secrets, checking required fields and options. */
export function splitValues(
  spec: ProviderSpec,
  values: Record<string, unknown>,
  previous?: { settings: Record<string, string>; secrets: Record<string, string> },
): { settings: Record<string, string>; secrets: Record<string, string> } {
  const settings: Record<string, string> = {};
  const secrets: Record<string, string> = {};
  for (const field of spec.fields) {
    const given = values[field.key];
    let value = typeof given === 'string' ? given.trim() : '';
    // Secrets are never shown again: an empty field on an edit keeps the stored value.
    if (!value && previous) value = (field.secret ? previous.secrets : previous.settings)[field.key] ?? '';
    if (!value) {
      if (field.required) throw new ValidationError(`«${field.label}» es obligatorio`);
      continue;
    }
    if (field.options && !field.options.includes(value)) throw new ValidationError(`«${field.label}» debe ser ${field.options.join(', ')}`);
    (field.secret ? secrets : settings)[field.key] = value;
  }
  if (spec.name === 'smtp' && !/^\d{1,5}$/.test(settings.port ?? '')) throw new ValidationError('«Puerto» debe ser un número');
  return { settings, secrets };
}

/**
 * The library driver for a connection. Its name is the connection id, so a send result (or a failover
 * attempt) says exactly which connection delivered.
 */
export function buildDriver(
  connection: Connection,
  values: Record<string, string>,
  /** Public URL of the connection's inbound endpoint, for providers told per message (Twilio). */
  statusCallback?: string,
): Driver<EmailMessage> | Driver<SmsMessage> {
  const name = connection.id;
  switch (connection.provider) {
    case 'twilio':
      if (!values.from && !values.messagingServiceSid) throw new ValidationError('Indica el número de envío o un Messaging Service SID');
      return twilio({
        name,
        accountSid: values.accountSid!,
        authToken: values.authToken!,
        ...(values.from && { from: values.from }),
        ...(values.messagingServiceSid && { messagingServiceSid: values.messagingServiceSid }),
        ...(statusCallback && { statusCallback }),
      });
    case 'ses':
      return ses({
        name,
        region: values.region!,
        credentials: { accessKeyId: values.accessKeyId!, secretAccessKey: values.secretAccessKey! },
        ...(values.configurationSetName && { configurationSetName: values.configurationSetName }),
        webhook: { confirmSubscriptions: true },
      });
    case 'sendgrid':
      return sendgrid({
        name,
        apiKey: values.apiKey!,
        ...(values.region === 'eu' && { region: 'eu' as const }),
        webhook: values.webhookPublicKey ? { publicKey: values.webhookPublicKey } : { verifySignature: false },
      });
    case 'resend':
      return resend({
        name,
        apiKey: values.apiKey!,
        webhook: values.webhookSecret ? { secret: values.webhookSecret } : { verifySignature: false },
      });
    case 'postmark':
      // Postmark does not sign webhooks: the secret token in the inbound URL is what authenticates them.
      return postmark({
        name,
        serverToken: values.serverToken!,
        ...(values.messageStream && { messageStream: values.messageStream }),
        webhook: { authenticate: false },
      });
    case 'mailgun':
      return mailgun({
        name,
        apiKey: values.apiKey!,
        domain: values.domain!,
        ...(values.region === 'eu' && { region: 'eu' as const }),
        webhook: values.webhookSigningKey ? { signingKey: values.webhookSigningKey } : { verifySignature: false },
      });
    case 'smtp': {
      const security = values.security ?? 'starttls';
      return smtp(
        {
          host: values.host!,
          port: Number(values.port),
          secure: security === 'tls',
          ...(security === 'none' && { ignoreTLS: true }),
          ...(security === 'starttls' && { requireTLS: true }),
          ...(values.username && { auth: { user: values.username, pass: values.password ?? '' } }),
          connectionTimeout: 15_000,
        },
        { name },
      );
    }
    default:
      throw new ValidationError(`Provider "${connection.provider}" is not available for live delivery`);
  }
}
