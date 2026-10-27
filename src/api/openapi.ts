/**
 * The public API, as OpenAPI 3.1: served at /openapi.json and rendered at /docs. Written by hand (the API takes
 * plain objects, not decorated DTOs); test/openapi.test.ts checks that every route is either documented here
 * or deliberately left out (panel-only endpoints).
 */

const GUIDE = `
API de Relayo: envía correos y SMS (también WhatsApp) simulados o reales, y recibe sus eventos normalizados.

## Autenticación

Todas las peticiones llevan una clave del proyecto: \`Authorization: Bearer rly_test_…\`. Las claves se crean en el
panel (**Claves de API**) y solo se muestran una vez.

Una clave puede tener permisos completos, **solo enviar** (\`POST /v1/messages\` y \`/v1/sms\`, y opcionalmente solo desde
ciertos dominios de remitente) o **solo consultar** (peticiones \`GET\`). Lo que una clave no puede hacer responde 403.

## Prueba y en vivo

La clave decide qué pasa con cada envío; tu código es el mismo.

| Clave | Qué hace |
| --- | --- |
| \`rly_test_…\` | Simula: las direcciones de escenario (\`hard-bounce@sim.relayo.dev\`…) y los números de escenario producen rebotes, quejas, aplazamientos… No sale nada. |
| \`rly_live_…\` | Entrega de verdad por las conexiones del proyecto (SES, SendGrid, Resend, Postmark, Mailgun, SMTP, Twilio), en orden y con failover. |

Las consultas (mensajes, estadísticas, programados…) devuelven los datos del modo de la clave.

## Errores

Los errores responden con \`{ "statusCode": 400, "message": "…" }\`.

| Código | Significa |
| --- | --- |
| 400 | La petición no es válida: el mensaje lo explica. |
| 401 | Falta la clave o no es válida. |
| 403 | La clave no puede hacer esto (solo desde el panel), o falta confirmar el email para el modo en vivo. |
| 404 | No existe en este proyecto. |
| 409 | Conflicto: una \`Idempotency-Key\` en curso, un envío ya enviado… |
| 422 | Una plantilla con variables sin valor, o una \`Idempotency-Key\` usada con otra petición. |
| 429 | Límite del plan (por minuto o por mes). Reintenta más tarde. |
| 502 / 503 | El proveedor del modo en vivo falló o no responde; el mensaje dice cuál. |

## Idempotencia

Los envíos aceptan \`Idempotency-Key\`. Repetir la petición con la misma clave en 24 horas devuelve la primera respuesta
(con \`Idempotent-Replayed: true\`) y no envía otra vez. Úsala al reintentar tras un timeout.

## Plantillas y envíos programados

En lugar de escribir el contenido, envía \`template\` (alias o id de una plantilla del proyecto) y \`variables\`. Con
\`sendAt\` el envío sale más tarde (hasta 30 días); se puede consultar y cancelar en \`/v1/scheduled\`.

## Webhooks

Cada evento llega a la URL del webhook del proyecto como un \`POST\` JSON (el esquema **Event**), firmado con el secreto
del webhook en la cabecera \`Relayo-Signature: t=<unix>,v1=<hex>\`: \`v1\` es el HMAC-SHA256 de \`<t>.<cuerpo>\`.
Responde con un 2xx; si no, se reintenta hasta 8 veces con espera exponencial (10 s, 30 s, 1,5 min…). Cada intento
queda en \`/v1/project/webhook/deliveries\`.

\`\`\`js
import { createHmac, timingSafeEqual } from 'node:crypto';

function verify(rawBody, header, secret) {
  const { t, v1 } = Object.fromEntries(header.split(',').map((p) => p.split('=')));
  if (Math.abs(Date.now() / 1000 - Number(t)) > 300) return false; // más de 5 minutos: rechazar
  const expected = createHmac('sha256', secret).update(\`\${t}.\${rawBody}\`).digest();
  const given = Buffer.from(v1, 'hex');
  return given.length === expected.length && timingSafeEqual(given, expected);
}
\`\`\`

Con la librería no hace falta: \`@alimzen/relayo-cloud\` envía y verifica los webhooks por ti.

\`\`\`ts
import { createRelayo } from '@alimzen/relayo';
import { relayoCloud } from '@alimzen/relayo-cloud';

const relayo = createRelayo({ email: relayoCloud({ apiKey: process.env.RELAYO_API_KEY!, webhook: { secret: process.env.RELAYO_WEBHOOK_SECRET! } }) });
await relayo.email.send({ from: { address: 'hola@tuapp.com' }, to: { address: 'ana@ejemplo.com' }, template: { id: 'bienvenida', variables: { nombre: 'Ana' } } });
relayo.on('bounced', (event) => marcarInvalido(event.recipient));
\`\`\`
`;

const ref = (name: string) => ({ $ref: `#/components/schemas/${name}` });
const json = (schema: unknown, example?: unknown) => ({ 'application/json': { schema, ...(example !== undefined && { example }) } });
const ok = (description: string, schema: unknown, example?: unknown) => ({ description, content: json(schema, example) });
const error = (description: string) => ({ description, content: json(ref('Error')) });
const list = (item: string) => ({ type: 'object', required: ['data'], properties: { data: { type: 'array', items: ref(item) } } });
const id = (name: string, description: string) => ({ name, in: 'path', required: true, description, schema: { type: 'string' } });
const query = (name: string, description: string, schema: unknown = { type: 'string' }) => ({ name, in: 'query', required: false, description, schema });
const body = (schema: unknown, example?: unknown) => ({ required: true, content: json(schema, example) });

const notFound = error('No existe en este proyecto.');
const badRequest = error('La petición no es válida.');
const idempotencyKey = {
  name: 'Idempotency-Key',
  in: 'header',
  required: false,
  description: 'Repetir la petición con la misma clave en 24 h devuelve la primera respuesta sin volver a enviar.',
  schema: { type: 'string', maxLength: 255 },
};

const EVENT_TYPES = ['accepted', 'delivered', 'deferred', 'bounced', 'complained', 'rejected', 'opened', 'clicked', 'unsubscribed', 'failed'];

const schemas = {
  Error: {
    type: 'object',
    required: ['statusCode', 'message'],
    properties: { statusCode: { type: 'integer' }, message: { type: 'string' } },
    example: { statusCode: 400, message: '"to" must contain email addresses' },
  },
  Address: {
    description: 'Una dirección, o dirección y nombre.',
    oneOf: [
      { type: 'string', format: 'email', example: 'ana@ejemplo.com' },
      { type: 'object', required: ['address'], properties: { address: { type: 'string', format: 'email' }, name: { type: 'string' } } },
    ],
  },
  Attachment: {
    type: 'object',
    required: ['filename', 'content'],
    properties: {
      filename: { type: 'string' },
      content: { type: 'string', contentEncoding: 'base64', description: 'Contenido en base64.' },
      contentType: { type: 'string' },
      cid: { type: 'string', description: 'Content-ID para imágenes incrustadas en el HTML (`cid:`).' },
    },
  },
  EmailRequest: {
    type: 'object',
    required: ['from', 'to'],
    description: '`subject` y `html` o `text` son obligatorios salvo que los dé una plantilla (`template`).',
    properties: {
      from: ref('Address'),
      to: { oneOf: [ref('Address'), { type: 'array', items: ref('Address') }] },
      cc: { type: 'array', items: ref('Address') },
      bcc: { type: 'array', items: ref('Address') },
      replyTo: ref('Address'),
      subject: { type: 'string' },
      html: { type: 'string' },
      text: { type: 'string' },
      headers: { type: 'object', additionalProperties: { type: 'string' }, description: 'Con una clave de prueba, `X-Sim-Scenario` elige el escenario de todos los destinatarios.' },
      attachments: { type: 'array', items: ref('Attachment') },
      metadata: { type: 'object', additionalProperties: { type: 'string' }, description: 'Viaja en cada evento del mensaje.' },
      tags: { type: 'array', items: { type: 'string' } },
      relayoMessageId: { type: 'string', description: 'Tu id del mensaje: los eventos lo llevan como `messageId`.' },
      template: { type: 'string', description: 'Alias o id de una plantilla de email del proyecto. Los campos de la petición ganan a los de la plantilla.' },
      variables: { type: 'object', description: 'Valores de las variables de la plantilla.' },
      sendAt: { type: 'string', format: 'date-time', description: 'Enviar más tarde (hasta 30 días). La respuesta es entonces un envío programado.' },
    },
  },
  SmsRequest: {
    type: 'object',
    required: ['to'],
    description: '`body` es obligatorio salvo que lo dé una plantilla (`template`).',
    properties: {
      to: {
        oneOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
        description: 'Números en E.164 (`+34600111222`), o `whatsapp:+34600111222` para WhatsApp (sin mezclar ambos en un envío).',
      },
      body: { type: 'string', maxLength: 1600 },
      from: { type: 'string', description: 'Número (E.164) o remitente alfanumérico de hasta 11 caracteres. En vivo, por defecto el de la conexión.' },
      scenario: { type: 'string', description: 'Solo con clave de prueba: escenario para todos los números.' },
      metadata: { type: 'object', additionalProperties: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      relayoMessageId: { type: 'string' },
      template: { type: 'string', description: 'Alias o id de una plantilla de SMS del proyecto.' },
      variables: { type: 'object' },
      sendAt: { type: 'string', format: 'date-time' },
      whatsapp: {
        type: 'object',
        description: 'Plantilla aprobada de WhatsApp (Twilio Content API), necesaria fuera de la ventana de 24 h.',
        properties: { contentSid: { type: 'string' }, contentVariables: { type: 'object', additionalProperties: { type: 'string' } } },
      },
    },
  },
  SendAnswer: {
    type: 'object',
    required: ['id', 'status'],
    properties: {
      id: { type: 'string', description: '`sim_…` para un mensaje; `sch_…` para un envío programado.' },
      status: { type: 'string', enum: ['queued', 'scheduled'] },
      recipients: { type: 'array', items: ref('Recipient') },
      sendAt: { type: 'string', format: 'date-time' },
    },
    example: { id: 'sim_8c1f2d7e-0b6a-4f0e-9c2b-1a2b3c4d5e6f', status: 'queued', recipients: [{ address: 'ana@ejemplo.com', scenario: { name: 'delivered', source: 'default' } }] },
  },
  Recipient: {
    type: 'object',
    required: ['address', 'scenario'],
    properties: {
      address: { type: 'string' },
      scenario: {
        type: 'object',
        description: 'El escenario que sigue (en vivo, `live`).',
        properties: { name: { type: 'string' }, param: { type: 'string' }, source: { type: 'string', enum: ['address', 'header', 'field', 'number', 'default'] } },
      },
    },
  },
  Message: {
    type: 'object',
    required: ['id', 'via', 'from', 'recipients', 'subject', 'createdAt'],
    properties: {
      id: { type: 'string' },
      mode: { type: 'string', enum: ['test', 'live'] },
      channel: { type: 'string', enum: ['email', 'sms'] },
      via: { type: 'string', enum: ['api', 'smtp'] },
      from: { type: 'string' },
      recipients: { type: 'array', items: ref('Recipient') },
      subject: { type: 'string' },
      body: { type: 'string', description: 'Texto del SMS.' },
      relayoMessageId: { type: 'string' },
      metadata: { type: 'object', additionalProperties: { type: 'string' } },
      tags: { type: 'array', items: { type: 'string' } },
      delivery: {
        type: 'object',
        description: 'En vivo: la conexión que lo entregó y el id del proveedor.',
        properties: { connectionId: { type: 'string' }, provider: { type: 'string' }, providerMessageId: { type: 'string' } },
      },
      size: { type: 'integer', description: 'Bytes del correo capturado.' },
      latest: {
        type: 'object',
        description: 'En listados: el último evento del primer destinatario.',
        properties: { type: { type: 'string', enum: EVENT_TYPES }, bounceType: { type: 'string', enum: ['hard', 'soft', 'block'] } },
      },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  MessageDetail: { allOf: [ref('Message'), { type: 'object', properties: { events: { type: 'array', items: ref('Event') } } }] },
  Event: {
    type: 'object',
    description: 'Un evento normalizado: lo mismo llega a tu webhook. Los rebotes llevan `bounceType` y `reason`; los rechazos, `reason`.',
    required: ['id', 'type', 'channel', 'provider', 'messageId', 'recipient', 'timestamp', 'raw'],
    properties: {
      id: { type: 'string' },
      type: { type: 'string', enum: EVENT_TYPES },
      channel: { type: 'string', enum: ['email', 'sms'] },
      provider: { type: 'string' },
      messageId: { type: 'string', description: 'Tu `relayoMessageId`, o el id del mensaje.' },
      providerMessageId: { type: 'string' },
      recipient: { type: 'string' },
      timestamp: { type: 'string', format: 'date-time' },
      metadata: { type: 'object', additionalProperties: { type: 'string' } },
      bounceType: { type: 'string', enum: ['hard', 'soft', 'block'], description: '`hard`: la dirección no sirve. `soft`: temporal. `block`: política o reputación (revisa tu envío, no el contacto).' },
      reason: { type: 'string', description: 'Motivo del rebote (`user_unknown`, `mailbox_full`…) o del rechazo (`suppressed`, `invalid_recipient`…).' },
      smtpCode: { type: 'integer' },
      enhancedCode: { type: 'string' },
      diagnostic: { type: 'string' },
      url: { type: 'string', description: 'Clics: el enlace.' },
      raw: { description: 'El dato original (del escenario o del proveedor).' },
    },
    example: {
      id: 'sim_8c1f:hard-bounce@sim.relayo.dev:001',
      type: 'bounced',
      channel: 'email',
      provider: 'simulator',
      messageId: 'pedido-1042',
      providerMessageId: 'sim_8c1f',
      recipient: 'hard-bounce@sim.relayo.dev',
      timestamp: '2026-10-26T10:00:02.000Z',
      metadata: { pedido: '1042' },
      bounceType: 'hard',
      reason: 'user_unknown',
      smtpCode: 550,
      enhancedCode: '5.1.1',
      raw: { scenario: { name: 'hard-bounce' } },
    },
  },
  Content: {
    type: 'object',
    properties: {
      subject: { type: 'string' },
      from: { type: 'string' },
      to: { type: 'string' },
      cc: { type: 'string' },
      replyTo: { type: 'string' },
      date: { type: 'string' },
      messageId: { type: 'string' },
      text: { type: 'string' },
      html: { type: 'string', description: 'Con las imágenes `cid:` incrustadas.' },
      headers: { type: 'array', items: { type: 'object', properties: { name: { type: 'string' }, value: { type: 'string' } } } },
      attachments: {
        type: 'array',
        items: {
          type: 'object',
          properties: { index: { type: 'integer' }, filename: { type: 'string' }, contentType: { type: 'string' }, size: { type: 'integer' }, inline: { type: 'boolean' } },
        },
      },
      size: { type: 'integer' },
    },
  },
  Scenario: {
    type: 'object',
    properties: {
      name: { type: 'string' },
      description: { type: 'string' },
      example: { type: 'string', description: 'Dirección o número que lo selecciona.' },
      channel: { type: 'string', enum: ['email', 'sms'] },
    },
  },
  Scheduled: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      mode: { type: 'string', enum: ['test', 'live'] },
      channel: { type: 'string', enum: ['email', 'sms'] },
      sendAt: { type: 'string', format: 'date-time' },
      status: { type: 'string', enum: ['pending', 'sending', 'sent', 'failed', 'canceled'] },
      summary: { type: 'string', description: 'Asunto, o inicio del SMS.' },
      recipients: { type: 'array', items: { type: 'string' } },
      messageId: { type: 'string', description: 'Una vez enviado: el mensaje en que se convirtió.' },
      error: { type: 'string', description: 'Por qué no se pudo enviar.' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  Template: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      alias: { type: 'string', description: 'Con el que la envías: minúsculas, números, `-` y `_`.' },
      name: { type: 'string' },
      channel: { type: 'string', enum: ['email', 'sms'] },
      subject: { type: 'string' },
      html: { type: 'string' },
      text: { type: 'string' },
      body: { type: 'string', description: 'Texto del SMS.' },
      variables: { type: 'array', items: { type: 'string' }, description: 'Las variables que usa su contenido.' },
      createdAt: { type: 'string', format: 'date-time' },
      updatedAt: { type: 'string', format: 'date-time' },
    },
  },
  TemplateInput: {
    type: 'object',
    description: '`{{nombre}}` y `{{cliente.nombre}}`; en HTML se escapan salvo `{{{html}}}`. Email: `subject` y `html` o `text`. SMS: `body`.',
    properties: {
      alias: { type: 'string' },
      name: { type: 'string' },
      channel: { type: 'string', enum: ['email', 'sms'], default: 'email' },
      subject: { type: 'string' },
      html: { type: 'string' },
      text: { type: 'string' },
      body: { type: 'string' },
    },
    example: { alias: 'pedido-enviado', subject: 'Tu pedido {{pedido}} ha salido', html: '<p>Hola, {{nombre}}: tu pedido {{pedido}} va de camino.</p>' },
  },
  WebhookDelivery: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      eventId: { type: 'string' },
      eventType: { type: 'string', enum: EVENT_TYPES },
      recipient: { type: 'string' },
      url: { type: 'string' },
      endpointId: { type: 'string', description: 'El endpoint adicional al que fue; sin él, la URL principal.' },
      attempt: { type: 'integer' },
      maxAttempts: { type: 'integer' },
      trigger: { type: 'string', enum: ['auto', 'redeliver', 'test'] },
      ok: { type: 'boolean' },
      statusCode: { type: 'integer' },
      error: { type: 'string', description: 'Sin respuesta: tiempo agotado, conexión rechazada…' },
      responseBody: { type: 'string', description: 'Inicio (2 KB) de lo que respondió tu endpoint.' },
      durationMs: { type: 'integer' },
      willRetry: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  ApiRequest: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      keyId: { type: 'string' },
      keyName: { type: 'string' },
      mode: { type: 'string', enum: ['test', 'live'] },
      method: { type: 'string' },
      path: { type: 'string' },
      status: { type: 'integer' },
      durationMs: { type: 'integer' },
      ip: { type: 'string' },
      error: { type: 'string', description: 'El mensaje de error, si la respuesta fue 400 o más.' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  AuditEntry: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      actor: {
        type: 'object',
        description: 'Una persona del panel (`user`), una clave de API (`key`) o un administrador de la plataforma (`admin`).',
        properties: { kind: { type: 'string', enum: ['user', 'key', 'admin'] }, id: { type: 'string' }, email: { type: 'string' }, name: { type: 'string' } },
      },
      action: { type: 'string', description: 'Método y ruta: `POST /v1/project/keys`.' },
      params: { type: 'object', additionalProperties: { type: 'string' } },
      details: { type: 'object', description: 'Los campos inofensivos de la petición (nombres, roles…); nunca secretos.' },
      ip: { type: 'string' },
      mode: { type: 'string', enum: ['test', 'live'] },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  WebhookEndpoint: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      url: { type: 'string' },
      description: { type: ['string', 'null'] },
      events: { type: ['array', 'null'], items: { type: 'string', enum: EVENT_TYPES }, description: 'Los tipos que recibe; `null`: todos.' },
      mode: { type: ['string', 'null'], enum: ['test', 'live', null], description: 'Solo los eventos de un modo; `null`: los dos.' },
      enabled: { type: 'boolean' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  WebhookEndpointInput: {
    type: 'object',
    properties: {
      url: { type: 'string', format: 'uri' },
      description: { type: ['string', 'null'] },
      events: { type: ['array', 'null'], items: { type: 'string', enum: EVENT_TYPES } },
      mode: { type: ['string', 'null'], enum: ['test', 'live', null] },
      enabled: { type: 'boolean' },
    },
  },
  Suppression: {
    type: 'object',
    properties: {
      address: { type: 'string' },
      reason: { type: 'string', enum: ['hard_bounce', 'complaint', 'unsubscribe', 'manual'] },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  Project: {
    type: 'object',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      webhookUrl: { type: ['string', 'null'] },
      reportsSmtpUrl: { type: ['string', 'null'], description: 'Sin contraseña.' },
      managedAccess: { type: ['string', 'null'], enum: ['requested', 'approved', 'denied', null] },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  Usage: {
    type: 'object',
    properties: {
      month: { type: 'string', example: '2026-10' },
      messages: { type: 'integer', description: 'Simulados este mes.' },
      live: { type: 'integer', description: 'Reales este mes.' },
      limits: {
        type: 'object',
        description: '0 = sin límite.',
        properties: { monthlyMessages: { type: 'integer' }, messagesPerMinute: { type: 'integer' }, liveMonthlyMessages: { type: 'integer' } },
      },
      retentionDays: { type: 'integer', description: '0 = siempre.' },
    },
  },
  Stats: {
    type: 'object',
    properties: {
      since: { type: 'string', format: 'date-time' },
      messages: { type: 'integer' },
      events: { type: 'object', additionalProperties: { type: 'integer' } },
      bounces: { type: 'object', properties: { hard: { type: 'integer' }, soft: { type: 'integer' }, block: { type: 'integer' } } },
      daily: {
        type: 'array',
        items: {
          type: 'object',
          properties: { date: { type: 'string' }, delivered: { type: 'integer' }, bounced: { type: 'integer' }, deferred: { type: 'integer' }, complained: { type: 'integer' } },
        },
      },
    },
  },
  Connection: {
    type: 'object',
    description: 'Una cuenta de proveedor del proyecto, sin sus credenciales.',
    properties: {
      id: { type: 'string' },
      name: { type: 'string' },
      channel: { type: 'string', enum: ['email', 'sms'] },
      provider: { type: 'string' },
      providerLabel: { type: 'string' },
      settings: { type: 'object', additionalProperties: { type: 'string' } },
      secretsSet: { type: 'array', items: { type: 'string' } },
      priority: { type: 'integer' },
      inboundPath: { type: 'string', description: 'Dónde configurar los eventos del proveedor.' },
      pausedUntil: { type: ['string', 'null'], format: 'date-time', description: 'Apartada tras fallos seguidos: se prueba la última hasta entonces.' },
      createdAt: { type: 'string', format: 'date-time' },
    },
  },
  Domain: {
    type: 'object',
    description: 'Un dominio para el envío de Relayo, con sus registros DNS.',
    properties: {
      id: { type: 'string' },
      domain: { type: 'string' },
      verified: { type: 'boolean' },
      records: {
        type: 'array',
        items: {
          type: 'object',
          properties: {
            purpose: { type: 'string', enum: ['dkim', 'spf', 'dmarc'] },
            type: { type: 'string' },
            host: { type: 'string' },
            value: { type: 'string' },
            required: { type: 'boolean' },
            ok: { type: 'boolean' },
          },
        },
      },
    },
  },
};

const tags = [
  { name: 'Envíos', description: 'Correos, SMS y WhatsApp, ahora o programados.' },
  { name: 'Mensajes', description: 'Lo enviado y la línea de tiempo de cada destinatario.' },
  { name: 'Programados', description: 'Envíos con `sendAt`.' },
  { name: 'Plantillas', description: 'Contenido guardado con variables.' },
  { name: 'Webhooks', description: 'Registro de entregas a tu endpoint.' },
  { name: 'Proyecto', description: 'Ajustes, uso y estadísticas.' },
  { name: 'Supresiones', description: 'Direcciones y números a los que no se envía.' },
  { name: 'Modo en vivo', description: 'Conexiones y dominios (se gestionan en el panel).' },
  { name: 'Escenarios', description: 'Catálogo de escenarios del modo de prueba.' },
  { name: 'Eventos de proveedores', description: 'Donde tus proveedores publican sus eventos.' },
  { name: 'Operadores', description: 'Para quien administra la instalación.' },
];

const paths = {
  '/v1/messages': {
    post: {
      tags: ['Envíos'],
      summary: 'Enviar un correo',
      operationId: 'sendEmail',
      parameters: [idempotencyKey],
      requestBody: body(ref('EmailRequest'), {
        from: { address: 'facturas@empresa.com', name: 'Empresa' },
        to: ['ana@ejemplo.com'],
        subject: 'Tu factura de octubre',
        html: '<p>Hola, Ana: adjuntamos tu factura.</p>',
        metadata: { facturaId: '1042' },
      }),
      responses: {
        202: ok('Aceptado (o programado, con `sendAt`).', ref('SendAnswer')),
        400: badRequest,
        403: error('En vivo: falta confirmar el email del dueño del proyecto.'),
        409: error('La misma `Idempotency-Key` sigue en curso.'),
        422: error('Faltan variables de la plantilla, o la `Idempotency-Key` se usó con otra petición.'),
        429: error('Límite del plan.'),
        502: error('En vivo: el proveedor falló.'),
      },
    },
    get: {
      tags: ['Mensajes'],
      summary: 'Listar mensajes',
      operationId: 'listMessages',
      description: 'Los más recientes primero, del modo de la clave.',
      parameters: [
        query('limit', 'Entre 1 y 100 (25 por defecto).', { type: 'integer' }),
        query('before', 'Fecha ISO: mensajes anteriores (paginación).', { type: 'string', format: 'date-time' }),
        query('q', 'Busca en asunto, remitente y destinatarios.'),
        query('status', 'Solo mensajes con un evento de este tipo.', { type: 'string', enum: EVENT_TYPES }),
        query('channel', 'Email o SMS.', { type: 'string', enum: ['email', 'sms'] }),
      ],
      responses: { 200: ok('Mensajes.', list('Message')), 400: badRequest },
    },
  },
  '/v1/sms': {
    post: {
      tags: ['Envíos'],
      summary: 'Enviar un SMS o un WhatsApp',
      operationId: 'sendSms',
      parameters: [idempotencyKey],
      requestBody: body(ref('SmsRequest'), { to: ['+34600111222'], body: 'Tu código es 482913' }),
      responses: {
        202: ok('Aceptado (o programado, con `sendAt`).', ref('SendAnswer')),
        400: badRequest,
        422: error('Faltan variables de la plantilla.'),
        429: error('Límite del plan.'),
        502: error('En vivo: el proveedor falló.'),
      },
    },
  },
  '/v1/messages/{id}': {
    get: {
      tags: ['Mensajes'],
      summary: 'Un mensaje con sus eventos',
      operationId: 'getMessage',
      parameters: [id('id', 'Id del mensaje (`sim_…`).')],
      responses: { 200: ok('El mensaje y la línea de tiempo de cada destinatario.', ref('MessageDetail')), 404: notFound },
    },
  },
  '/v1/messages/{id}/content': {
    get: {
      tags: ['Mensajes'],
      summary: 'Contenido del correo',
      operationId: 'getMessageContent',
      description: 'El correo tal como salió: asunto, cuerpos, cabeceras y adjuntos.',
      parameters: [id('id', 'Id del mensaje.')],
      responses: { 200: ok('Contenido.', ref('Content')), 404: notFound },
    },
  },
  '/v1/messages/{id}/raw': {
    get: {
      tags: ['Mensajes'],
      summary: 'Original (.eml)',
      operationId: 'getMessageRaw',
      parameters: [id('id', 'Id del mensaje.')],
      responses: { 200: { description: 'El MIME original.', content: { 'message/rfc822': { schema: { type: 'string' } } } }, 404: notFound },
    },
  },
  '/v1/messages/{id}/attachments/{index}': {
    get: {
      tags: ['Mensajes'],
      summary: 'Descargar un adjunto',
      operationId: 'getAttachment',
      parameters: [id('id', 'Id del mensaje.'), id('index', 'Posición del adjunto (`attachments[].index` del contenido).')],
      responses: { 200: { description: 'El adjunto, como descarga.', content: { 'application/octet-stream': { schema: { type: 'string', format: 'binary' } } } }, 404: notFound },
    },
  },
  '/v1/messages/{id}/events/{eventId}/report': {
    get: {
      tags: ['Mensajes'],
      summary: 'Informe DSN o ARF de un evento',
      operationId: 'getEventReport',
      description: 'Modo de prueba: el informe de rebote (DSN) o de queja (ARF) que generó el evento.',
      parameters: [id('id', 'Id del mensaje.'), id('eventId', 'Id del evento.')],
      responses: { 200: { description: 'El informe como correo.', content: { 'message/rfc822': { schema: { type: 'string' } } } }, 404: notFound },
    },
  },
  '/v1/scheduled': {
    get: {
      tags: ['Programados'],
      summary: 'Listar envíos programados',
      operationId: 'listScheduled',
      parameters: [
        query('status', 'Pendientes (los más próximos primero) o con otro estado.', { type: 'string', enum: ['pending', 'sending', 'sent', 'failed', 'canceled'] }),
        query('limit', 'Hasta 200 (100 por defecto).', { type: 'integer' }),
      ],
      responses: { 200: ok('Envíos programados.', list('Scheduled')), 400: badRequest },
    },
  },
  '/v1/scheduled/{id}': {
    get: {
      tags: ['Programados'],
      summary: 'Un envío programado',
      operationId: 'getScheduled',
      parameters: [id('id', 'Id (`sch_…`).')],
      responses: {
        200: ok('El envío, con la petición tal como llegó.', { allOf: [ref('Scheduled'), { type: 'object', properties: { request: { type: 'object' } } }] }),
        404: notFound,
      },
    },
    delete: {
      tags: ['Programados'],
      summary: 'Cancelar un envío pendiente',
      operationId: 'cancelScheduled',
      parameters: [id('id', 'Id (`sch_…`).')],
      responses: { 204: { description: 'Cancelado.' }, 404: notFound, 409: error('Ya se envió, se está enviando o ya estaba cancelado.') },
    },
  },
  '/v1/project/templates': {
    get: {
      tags: ['Plantillas'],
      summary: 'Listar plantillas',
      operationId: 'listTemplates',
      responses: { 200: ok('Plantillas, por alias.', list('Template')) },
    },
    post: {
      tags: ['Plantillas'],
      summary: 'Crear una plantilla',
      operationId: 'createTemplate',
      requestBody: body(ref('TemplateInput')),
      responses: { 201: ok('Creada.', ref('Template')), 400: badRequest, 409: error('Ya hay una plantilla con ese alias.') },
    },
  },
  '/v1/project/templates/{ref}': {
    get: {
      tags: ['Plantillas'],
      summary: 'Una plantilla',
      operationId: 'getTemplate',
      parameters: [id('ref', 'Alias o id.')],
      responses: { 200: ok('La plantilla.', ref('Template')), 404: notFound },
    },
    patch: {
      tags: ['Plantillas'],
      summary: 'Cambiar una plantilla',
      operationId: 'updateTemplate',
      description: 'Los campos que faltan se quedan como están; los vacíos se borran.',
      parameters: [id('ref', 'Alias o id.')],
      requestBody: body(ref('TemplateInput')),
      responses: { 200: ok('Guardada.', ref('Template')), 400: badRequest, 404: notFound, 409: error('El nuevo alias ya existe.') },
    },
    delete: {
      tags: ['Plantillas'],
      summary: 'Borrar una plantilla',
      operationId: 'deleteTemplate',
      parameters: [id('ref', 'Alias o id.')],
      responses: { 204: { description: 'Borrada.' }, 404: notFound },
    },
  },
  '/v1/project/templates/{ref}/preview': {
    post: {
      tags: ['Plantillas'],
      summary: 'Previsualizar con variables',
      operationId: 'previewTemplate',
      description: 'Rellena la plantilla hasta donde llegan las variables y dice cuáles faltan.',
      parameters: [id('ref', 'Alias o id.')],
      requestBody: body({ type: 'object', properties: { variables: { type: 'object' } } }, { variables: { nombre: 'Ana' } }),
      responses: {
        200: ok('Resultado.', {
          type: 'object',
          properties: {
            rendered: { type: 'object', properties: { subject: { type: 'string' }, html: { type: 'string' }, text: { type: 'string' }, body: { type: 'string' } } },
            missing: { type: 'array', items: { type: 'string' } },
          },
        }),
        404: notFound,
      },
    },
  },
  '/v1/project/webhook/deliveries': {
    get: {
      tags: ['Webhooks'],
      summary: 'Registro de entregas',
      operationId: 'listWebhookDeliveries',
      description: 'Cada intento de enviar un evento a tu URL, el más reciente primero.',
      parameters: [
        query('status', 'Solo los que no recibieron un 2xx.', { type: 'string', enum: ['failed'] }),
        query('endpoint', 'Solo los de un endpoint (su id), o `main` para la URL principal.', { type: 'string' }),
        query('before', 'Fecha ISO: anteriores (paginación).', { type: 'string', format: 'date-time' }),
        query('limit', 'Hasta 200 (50 por defecto).', { type: 'integer' }),
      ],
      responses: { 200: ok('Intentos.', list('WebhookDelivery')) },
    },
  },
  '/v1/project/webhook/redeliver': {
    post: {
      tags: ['Webhooks'],
      summary: 'Reenviar los fallidos',
      operationId: 'redeliverFailedWebhooks',
      description:
        'Vuelve a enviar, en segundo plano, cada evento que no se pudo entregar en un periodo (su último intento falló y no le quedan reintentos), al endpoint al que iba. Hasta 1000 eventos.',
      requestBody: body({
        type: 'object',
        required: ['since'],
        properties: {
          since: { type: 'string', format: 'date-time' },
          until: { type: 'string', format: 'date-time' },
          endpoint: { type: 'string', description: 'Solo los de un endpoint (su id), o `main` para la URL principal.' },
        },
      }),
      responses: { 202: ok('Cuántos eventos se reenvían.', { type: 'object', properties: { events: { type: 'integer' } } }), 400: badRequest },
    },
  },
  '/v1/project/webhook/endpoints': {
    get: {
      tags: ['Webhooks'],
      summary: 'Endpoints adicionales',
      operationId: 'listWebhookEndpoints',
      description: 'Más URLs que reciben los eventos, además de la principal (`webhookUrl`), cada una con su secreto y sus filtros.',
      responses: { 200: ok('Endpoints.', list('WebhookEndpoint')) },
    },
    post: {
      tags: ['Webhooks'],
      summary: 'Añadir un endpoint',
      operationId: 'createWebhookEndpoint',
      description: 'Hasta 10 por proyecto. La respuesta trae su secreto de firma (`secret`).',
      requestBody: body({ allOf: [ref('WebhookEndpointInput'), { required: ['url'] }] }, { url: 'https://crm.empresa.com/relayo', events: ['bounced', 'complained'], mode: 'live' }),
      responses: {
        201: ok('El endpoint, con su secreto.', { allOf: [ref('WebhookEndpoint'), { type: 'object', properties: { secret: { type: 'string' } } }] }),
        400: badRequest,
      },
    },
  },
  '/v1/project/webhook/endpoints/{id}': {
    patch: {
      tags: ['Webhooks'],
      summary: 'Cambiar un endpoint',
      operationId: 'updateWebhookEndpoint',
      description: '`null` borra `description`, `events` (todos) o `mode` (los dos).',
      parameters: [id('id', 'Id del endpoint (`whe_…`).')],
      requestBody: body(ref('WebhookEndpointInput')),
      responses: { 200: ok('El endpoint.', ref('WebhookEndpoint')), 400: badRequest, 404: notFound },
    },
    delete: {
      tags: ['Webhooks'],
      summary: 'Borrar un endpoint',
      operationId: 'deleteWebhookEndpoint',
      parameters: [id('id', 'Id del endpoint.')],
      responses: { 204: { description: 'Borrado.' }, 404: notFound },
    },
  },
  '/v1/project/webhook/deliveries/{id}': {
    get: {
      tags: ['Webhooks'],
      summary: 'Un intento, con el evento enviado',
      operationId: 'getWebhookDelivery',
      parameters: [id('id', 'Id del intento (`wha_…`).')],
      responses: {
        200: ok('El intento.', { allOf: [ref('WebhookDelivery'), { type: 'object', properties: { event: { oneOf: [ref('Event'), { type: 'null' }] } } }] }),
        404: notFound,
      },
    },
  },
  '/v1/project/webhook/deliveries/{id}/redeliver': {
    post: {
      tags: ['Webhooks'],
      summary: 'Reenviar un evento',
      operationId: 'redeliverWebhook',
      description: 'Envía otra vez, ahora, el evento de un intento a la URL actual del endpoint al que fue.',
      parameters: [id('id', 'Id del intento.')],
      responses: { 200: ok('El nuevo intento.', ref('WebhookDelivery')), 400: error('Sin URL de webhook, o el evento ya se borró por retención.'), 404: notFound },
    },
  },
  '/v1/project/requests': {
    get: {
      tags: ['Proyecto'],
      summary: 'Registro de peticiones',
      operationId: 'listApiRequests',
      description: 'Cada petición hecha con una clave de API del proyecto, con su respuesta; la más reciente primero. Se guardan lo mismo que los mensajes.',
      parameters: [
        query('status', 'Solo las que respondieron 400 o más.', { type: 'string', enum: ['failed'] }),
        query('key', 'Solo las de una clave (su id).', { type: 'string' }),
        query('before', 'Fecha ISO: anteriores (paginación).', { type: 'string', format: 'date-time' }),
        query('limit', 'Hasta 200 (50 por defecto).', { type: 'integer' }),
      ],
      responses: { 200: ok('Peticiones.', list('ApiRequest')) },
    },
  },
  '/v1/project/audit': {
    get: {
      tags: ['Proyecto'],
      summary: 'Registro de auditoría',
      operationId: 'listAudit',
      description: 'Quién cambió qué en el proyecto (claves, equipo, ajustes, plantillas, conexiones…), lo más reciente primero. Los envíos no aparecen: tienen el registro de mensajes. Se guarda un año.',
      parameters: [
        query('before', 'Fecha ISO: anteriores (paginación).', { type: 'string', format: 'date-time' }),
        query('limit', 'Hasta 200 (50 por defecto).', { type: 'integer' }),
      ],
      responses: { 200: ok('Cambios.', list('AuditEntry')) },
    },
  },
  '/v1/project/webhook/test': {
    post: {
      tags: ['Webhooks'],
      summary: 'Enviar un evento de prueba',
      operationId: 'testWebhook',
      description: 'Un evento `delivered` inventado, con la cabecera `Relayo-Test: true` y `metadata.relayoTest`, para probar tu endpoint y su comprobación de la firma.',
      requestBody: { required: false, content: json({ type: 'object', properties: { endpoint: { type: 'string', description: 'Id de un endpoint adicional; sin él, la URL principal.' } } }) },
      responses: { 200: ok('El intento.', ref('WebhookDelivery')), 400: error('El proyecto no tiene URL de webhook, o el endpoint no existe.') },
    },
  },
  '/v1/project/webhook/stats': {
    get: {
      tags: ['Webhooks'],
      summary: 'Entregas de las últimas 24 horas',
      operationId: 'webhookStats',
      responses: {
        200: ok('Aceptadas y fallidas, y el último intento.', {
          type: 'object',
          properties: { since: { type: 'string', format: 'date-time' }, ok: { type: 'integer' }, failed: { type: 'integer' }, latest: { oneOf: [ref('WebhookDelivery'), { type: 'null' }] } },
        }),
      },
    },
  },
  '/v1/project': {
    get: { tags: ['Proyecto'], summary: 'El proyecto', operationId: 'getProject', responses: { 200: ok('El proyecto de la clave.', ref('Project')) } },
    patch: {
      tags: ['Proyecto'],
      summary: 'Cambiar el proyecto',
      operationId: 'updateProject',
      description: '`null` o `""` borra `webhookUrl` / `reportsSmtpUrl`; lo que falta no cambia.',
      requestBody: body({
        type: 'object',
        properties: {
          name: { type: 'string', maxLength: 80 },
          webhookUrl: { type: ['string', 'null'], format: 'uri' },
          reportsSmtpUrl: { type: ['string', 'null'], description: 'Modo de prueba: SMTP que recibe los informes DSN y ARF (`smtp://usuario:clave@host:587/buzon@ejemplo.com`).' },
        },
      }),
      responses: { 200: ok('Guardado.', ref('Project')), 400: badRequest },
    },
  },
  '/v1/project/usage': {
    get: { tags: ['Proyecto'], summary: 'Uso del mes y límites', operationId: 'getUsage', responses: { 200: ok('Uso.', ref('Usage')) } },
  },
  '/v1/project/stats': {
    get: {
      tags: ['Proyecto'],
      summary: 'Estadísticas',
      operationId: 'getStats',
      parameters: [query('days', 'Días hacia atrás, de 1 a 90 (7 por defecto).', { type: 'integer' })],
      responses: { 200: ok('Totales y serie diaria.', ref('Stats')) },
    },
  },
  '/v1/project/suppressions': {
    get: {
      tags: ['Supresiones'],
      summary: 'Listar supresiones',
      operationId: 'listSuppressions',
      description: 'Rebotes duros, quejas y bajas (y las añadidas a mano): los envíos a ellas se rechazan sin intentarse.',
      parameters: [query('limit', 'Hasta 1000 (200 por defecto).', { type: 'integer' })],
      responses: { 200: ok('Supresiones.', list('Suppression')) },
    },
    post: {
      tags: ['Supresiones'],
      summary: 'Añadir una supresión',
      operationId: 'addSuppression',
      requestBody: body({ type: 'object', required: ['address'], properties: { address: { type: 'string' } } }, { address: 'ana@ejemplo.com' }),
      responses: { 204: { description: 'Añadida.' }, 400: badRequest },
    },
  },
  '/v1/project/suppressions/{address}': {
    delete: {
      tags: ['Supresiones'],
      summary: 'Quitar una supresión',
      operationId: 'removeSuppression',
      parameters: [id('address', 'La dirección o el número (codificado en la URL).')],
      responses: { 204: { description: 'Quitada: se le vuelve a enviar.' }, 404: notFound },
    },
  },
  '/v1/project/providers': {
    get: {
      tags: ['Modo en vivo'],
      summary: 'Proveedores disponibles',
      operationId: 'listProviders',
      responses: { 200: ok('Los proveedores que se pueden conectar, con sus campos.', { type: 'object', properties: { data: { type: 'array', items: { type: 'object' } } } }) },
    },
  },
  '/v1/project/connections': {
    get: {
      tags: ['Modo en vivo'],
      summary: 'Conexiones del proyecto',
      operationId: 'listConnections',
      description: 'En orden de prioridad. Se crean y cambian en el panel.',
      responses: { 200: ok('Conexiones.', list('Connection')) },
    },
  },
  '/v1/project/domains': {
    get: {
      tags: ['Modo en vivo'],
      summary: 'Dominios del envío de Relayo',
      operationId: 'listDomains',
      responses: {
        200: ok('Dominios y su estado.', {
          type: 'object',
          properties: {
            available: { type: 'boolean', description: 'Si la instalación ofrece el envío de Relayo.' },
            access: { type: ['string', 'null'], enum: ['requested', 'approved', 'denied', null] },
            data: { type: 'array', items: ref('Domain') },
          },
        }),
      },
    },
  },
  '/v1/scenarios': {
    get: {
      tags: ['Escenarios'],
      summary: 'Catálogo de escenarios',
      operationId: 'listScenarios',
      security: [],
      responses: { 200: ok('Escenarios de email (por dirección) y de SMS (por número).', list('Scenario')) },
    },
  },
  '/v1/inbound/{token}': {
    post: {
      tags: ['Eventos de proveedores'],
      summary: 'Eventos de un proveedor',
      operationId: 'providerEvents',
      description:
        'La URL que se configura en el proveedor de una conexión (en el panel, «URL de eventos»). Recibe sus eventos en su propio formato, comprueba su firma, y los convierte en eventos de Relayo para tu webhook. No se llama directamente.',
      security: [],
      parameters: [id('token', 'Token secreto de la conexión.')],
      requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' } }, 'application/x-www-form-urlencoded': { schema: { type: 'object' } } } },
      responses: { 200: ok('Eventos recibidos.', { type: 'object', properties: { received: { type: 'integer' } } }), 401: error('Firma no válida.'), 404: notFound },
    },
  },
  '/v1/admin/projects': {
    post: {
      tags: ['Operadores'],
      summary: 'Crear un proyecto sin cuenta',
      operationId: 'adminCreateProject',
      description: 'Con el token de administración (`ADMIN_TOKEN`): para scripts y CI. La clave y el secreto del webhook solo aparecen en esta respuesta.',
      security: [{ adminToken: [] }],
      requestBody: body({ type: 'object', required: ['name'], properties: { name: { type: 'string' }, webhookUrl: { type: 'string' } } }),
      responses: {
        201: ok('Creado.', { allOf: [ref('Project'), { type: 'object', properties: { apiKey: { type: 'string' }, webhookSecret: { type: 'string' } } }] }),
        401: error('Falta el token de administración.'),
      },
    },
  },
  '/v1/admin/managed': {
    get: {
      tags: ['Operadores'],
      summary: 'Solicitudes del envío de Relayo',
      operationId: 'adminListManaged',
      security: [{ adminToken: [] }],
      responses: { 200: ok('Proyectos que lo pidieron, con dueño, dominios y envíos reales del mes; pendientes primero.', { type: 'object' }) },
    },
  },
  '/v1/admin/managed/{projectId}': {
    post: {
      tags: ['Operadores'],
      summary: 'Aprobar o rechazar el envío de Relayo',
      operationId: 'adminDecideManaged',
      security: [{ adminToken: [] }],
      parameters: [id('projectId', 'Id del proyecto.')],
      requestBody: body({ type: 'object', required: ['decision'], properties: { decision: { type: 'string', enum: ['approved', 'denied'] } } }),
      responses: { 200: ok('El proyecto.', ref('Project')), 404: notFound },
    },
  },
  '/health': {
    get: {
      tags: ['Operadores'],
      summary: 'Salud',
      operationId: 'health',
      description: '200 si PostgreSQL y Redis responden, 503 si no (`checks` dice cuál). Para monitores de disponibilidad.',
      security: [],
      responses: {
        200: ok('Todo responde.', { type: 'object', properties: { ok: { type: 'boolean' }, checks: { type: 'object' }, commit: { type: 'string' } } }),
        503: { description: 'Alguna dependencia no responde.' },
      },
    },
  },
  '/health/live': {
    get: {
      tags: ['Operadores'],
      summary: 'El proceso responde',
      operationId: 'healthLive',
      description: 'Para el health check del contenedor: no depende de la base de datos.',
      security: [],
      responses: { 200: ok('Vivo.', { type: 'object', properties: { ok: { type: 'boolean' } } }) },
    },
  },
};

/** Every operation that needs a key can answer 401: added here rather than repeated in each one. */
function withUnauthorized(spec: typeof paths): typeof paths {
  return Object.fromEntries(
    Object.entries(spec).map(([path, operations]) => [
      path,
      Object.fromEntries(
        Object.entries(operations).map(([method, operation]) => {
          const op = operation as { security?: unknown[]; responses: Record<string, unknown> };
          const open = Array.isArray(op.security) && op.security.length === 0;
          return [method, open || op.responses[401] ? op : { ...op, responses: { ...op.responses, 401: error('Falta la clave o no es válida.') } }];
        }),
      ),
    ]),
  ) as typeof paths;
}

export function openApi(serverUrl?: string) {
  return {
    openapi: '3.1.0',
    info: { title: 'Relayo API', version: '1', description: GUIDE.trim() },
    ...(serverUrl && { servers: [{ url: serverUrl }] }),
    security: [{ apiKey: [] }],
    tags,
    paths: withUnauthorized(paths),
    components: {
      securitySchemes: {
        apiKey: { type: 'http', scheme: 'bearer', description: 'Una clave del proyecto: `rly_test_…` (simula) o `rly_live_…` (entrega).' },
        adminToken: { type: 'http', scheme: 'bearer', description: 'El `ADMIN_TOKEN` de la instalación.' },
      },
      schemas,
    },
  };
}

/**
 * Routes left out of the reference on purpose: the panel's own (accounts, sessions, keys, credentials, team) and
 * the relay's internal events endpoint. Keys can't use most of them anyway.
 */
export const UNDOCUMENTED = [
  'GET /v1/auth/config', 'POST /v1/auth/signup', 'POST /v1/auth/login', 'POST /v1/auth/logout', 'GET /v1/auth/me', 'PATCH /v1/auth/me',
  'POST /v1/auth/verify', 'POST /v1/auth/verify/resend', 'POST /v1/auth/forgot', 'POST /v1/auth/reset', 'POST /v1/auth/password',
  'GET /v1/auth/me/export', 'DELETE /v1/auth/me', 'DELETE /v1/project',
  'POST /v1/auth/login/2fa', 'POST /v1/auth/2fa/setup', 'POST /v1/auth/2fa/enable', 'POST /v1/auth/2fa/disable',
  'GET /v1/projects', 'POST /v1/projects/claim', 'POST /v1/projects',
  'GET /v1/project/keys', 'POST /v1/project/keys', 'DELETE /v1/project/keys/:id',
  'GET /v1/project/webhook-secret', 'POST /v1/project/webhook-secret/rotate',
  'GET /v1/project/team', 'POST /v1/project/team/invites', 'DELETE /v1/project/team/invites/:id',
  'PATCH /v1/project/team/members/:userId', 'DELETE /v1/project/team/members/:userId',
  'GET /v1/invites/:token', 'POST /v1/invites/accept',
  'POST /v1/project/managed-access', 'POST /v1/project/domains', 'POST /v1/project/domains/:id/verify', 'DELETE /v1/project/domains/:id',
  'POST /v1/project/connections', 'POST /v1/project/connections/order', 'PATCH /v1/project/connections/:id',
  'DELETE /v1/project/connections/:id', 'POST /v1/project/connections/:id/test',
  'POST /v1/inbound/managed/:token',
  'GET /v1/admin/plans', 'PATCH /v1/admin/plans/:projectId',
  'GET /v1/project/webhook/endpoints/:id/secret', 'POST /v1/project/webhook/endpoints/:id/secret/rotate',
  'GET /openapi.json',
];
