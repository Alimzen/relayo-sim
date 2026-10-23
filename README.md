# Relayo Sim

Simulador de escenarios de entrega de correo (producto de pago de Relayo). La app envía al simulador —por
SMTP o por la API HTTP— y este responde como el mundo real: rebotes, greylisting, bloqueos, buzón lleno,
quejas, retrasos… y emite los eventos correspondientes como webhooks firmados con el formato de Relayo.

Repositorio privado. La librería y el driver `@alimzen/relayo-simulator` son open source: https://github.com/Alimzen/relayo

## Arquitectura

```
App ──SMTP :2525──▶ SmtpSimServer ─┐
App ──HTTP /v1────▶ API (NestJS) ──┼─▶ SimulationService ──▶ escenario (catálogo)
                                   │        │
                                   │        ├─▶ SimStore (PostgreSQL | memoria)
                                   │        └─▶ EventScheduler (BullMQ | timers) ─▶ evento ─▶ WebhookDispatcher (BullMQ | timers) ─▶ webhook firmado
```

- `src/scenarios/`: catálogo de escenarios y selección (dirección mágica o cabecera `X-Sim-Scenario`). Cada
  escenario define la respuesta SMTP en vivo y la línea de tiempo de eventos; los rebotes se clasifican con
  `classifyBounce` de `@alimzen/relayo`, así el simulador coincide con lo que reportan los drivers.
- `src/smtp/`: servidor SMTP (`smtp-server`). Autenticación con la API key del proyecto. Responde en
  `RCPT TO` (dirección) o tras `DATA` (contenido, cabecera de escenario). `timeout` deja la conexión colgada
  hasta `SMTP_MAX_HANG_MS`.
- `src/simulation/`: `SimulationService`, que une escenarios, almacenamiento, planificación y webhooks.
- `src/store/`, `src/scheduler/`, `src/webhooks/`, `src/queues/`: interfaces con implementación en memoria
  (tests, local) y de producción (PostgreSQL, BullMQ).
- `src/api/`: API HTTP.

## Cuentas

Usuarios con correo y contraseña (scrypt), sesión en una cookie `relayo_session` (HttpOnly, SameSite=Lax, 30 días;
el servidor guarda solo su SHA-256). Cada usuario tiene proyectos y cada proyecto sus claves de API (se muestran una
sola vez y se pueden revocar). Al registrarse se crea «Mi primer proyecto».

- Con sesión, el proyecto se elige con la cabecera `X-Relayo-Project`, y toda petición que cambie algo debe llevar
  `X-Relayo-Client` (protección CSRF). Las claves y el secreto del webhook solo se gestionan con sesión.
- Login limitado a 10 fallos por correo y 50 por IP cada 15 minutos.
- Los proyectos creados antes de las cuentas (o con `ADMIN_TOKEN`) no tienen dueño: se vinculan a una cuenta con
  `POST /v1/projects/claim` y una de sus claves («Vincular proyecto existente» en el panel).

## API

«API key» = `Authorization: Bearer <clave>`, o sesión del panel con `X-Relayo-Project`.

Los envíos (`POST /v1/messages`, `POST /v1/sms`) aceptan `Idempotency-Key`: repetir la petición con la misma clave en 24 h devuelve la primera respuesta (con `Idempotent-Replayed: true`) sin enviar otra vez; la misma clave con otro cuerpo da 422, y mientras la primera sigue en curso, 409. Los drivers `@alimzen/relayo-simulator` y `@alimzen/relayo-cloud` la mandan solos con el id del mensaje.

| Método y ruta | Auth | |
| --- | --- | --- |
| `GET /health` | — | 200 si PostgreSQL y Redis responden, 503 si no (`checks` dice cuál); para monitores de disponibilidad |
| `GET /health/live` | — | El proceso responde: para el health check del contenedor |
| `GET /v1/auth/config` | — | `{ signup, minPassword }` |
| `POST /v1/auth/signup`, `/login`, `/logout` | — | Abre o cierra la sesión |
| `GET`, `PATCH /v1/auth/me` · `POST /v1/auth/password` | Sesión | Perfil y contraseña (cierra las otras sesiones) |
| `POST /v1/auth/verify` · `/verify/resend` | — · Sesión | Confirma el email con el token del enlace, o reenvía el enlace |
| `POST /v1/project/managed-access` | Sesión | Solicita el envío de Relayo para el proyecto |
| `GET /v1/admin/managed` · `POST /v1/admin/managed/:projectId` | Admin | Solicitudes del envío de Relayo; `{ decision: 'approved' \| 'denied' }` |
| `GET`, `POST /v1/projects` · `POST /v1/projects/claim` | Sesión | Proyectos del usuario |
| `GET /v1/scenarios` | — | Catálogo |
| `POST /v1/messages` | API key | Envío de email (202, `{ id, status: 'queued' }`) |
| `GET`, `POST /v1/project/templates` · `GET`, `PATCH`, `DELETE /:ref` · `POST /:ref/preview` | API key | Plantillas (por id o alias). Los envíos aceptan `{ template, variables }`: `{{nombre}}`, `{{cliente.nombre}}`, y `{{{html}}}` sin escapar; si falta una variable, 422 |
| `GET /v1/scheduled?status=` · `GET`, `DELETE /v1/scheduled/:id` | API key | Envíos con `sendAt` (ISO, hasta 30 días): se validan al llegar, salen a su hora (cada 15 s se revisan) y se pueden cancelar mientras están pendientes |
| `GET /v1/project/webhook/deliveries` · `/deliveries/:id` · `/stats` | API key | Registro de entregas del webhook (`status=failed`, `before`): respuesta, error, intento, y el evento enviado |
| `POST /v1/project/webhook/deliveries/:id/redeliver` · `/webhook/test` | API key | Reenvía un evento ahora, o envía uno de prueba (cabecera `Relayo-Test: true`) |
| `POST /v1/sms` | API key | Envío de SMS o WhatsApp: `{ from?, to, body, metadata?, relayoMessageId?, scenario?, whatsapp? }` (202). WhatsApp con destinatarios `whatsapp:+…` (sin mezclar con SMS), desde el remitente de WhatsApp de la conexión de Twilio; `whatsapp: { contentSid, contentVariables }` para plantillas aprobadas |
| `GET /v1/messages?limit=&before=&q=&status=` | API key | Últimos mensajes, con búsqueda y filtro por tipo de evento |
| `GET /v1/messages/:id` | API key | Mensaje con su línea de tiempo |
| `GET /v1/messages/:id/content` | API key | Correo capturado: cuerpos, cabeceras y adjuntos (imágenes `cid:` incrustadas) |
| `GET /v1/messages/:id/raw` · `/attachments/:index` | API key | Original (`.eml`) y adjuntos, como descarga |
| `GET /v1/messages/:id/events/:eventId/report` | API key | DSN o ARF del evento (`message/rfc822`) |
| `GET`, `PATCH /v1/project` | API key | Proyecto, `name`, `webhookUrl` y `reportsSmtpUrl` |
| `GET /v1/project/stats?days=` | API key | Totales y serie diaria (1–90 días) |
| `GET`, `POST /v1/project/keys` · `DELETE /v1/project/keys/:id` | Sesión | Claves de API |
| `GET /v1/project/webhook-secret` · `POST …/rotate` | Sesión | Secreto de firma |
| `POST /v1/admin/projects` | `ADMIN_TOKEN` | Crea un proyecto sin dueño (scripts); devuelve `apiKey` y `webhookSecret` una sola vez |

Webhooks: `POST` con un evento Relayo en JSON y `Relayo-Signature: t=<unix>,v1=<hex HMAC-SHA256 de "t.cuerpo">`
(secreto del proyecto). 8 reintentos con backoff exponencial.

## SMS

`POST /v1/sms` acepta SMS como la API de un proveedor (`to` en E.164, `body` de hasta 1600 caracteres, `from` un número
o un remitente alfanumérico de hasta 11). Cada número sigue su escenario y los eventos llegan por el mismo webhook
firmado que el email, con `channel: "sms"`. Los números son ficticios (555-01XX): ningún teléfono real los recibe.

| Número | Escenario | Eventos |
| --- | --- | --- |
| `+12015550100` (o cualquier otro) | `delivered` | accepted → delivered |
| `+12015550101` | `invalid-number` | bounced hard / `user_unknown` (error 30005) |
| `+12015550102` | `landline` | bounced hard: un fijo no recibe SMS (30006) |
| `+12015550103` | `unreachable` | deferred ×2 → bounced soft / `temporary_failure` (30003) |
| `+12015550104` | `carrier-filtered` | bounced block / `content_rejected`: filtrado como spam (30007) |
| `+12015550105` | `opt-out` | delivered → unsubscribed (responde STOP) |
| `+12015550106` | `suppressed` | rejected / `suppressed`: ya había respondido STOP |
| `+12015550107` | `delay` | deferred → delivered a los 30 s |

El campo `scenario` elige el escenario para todos los destinatarios. En la librería, `simulatorSms()` y
`scenarioNumber()` de `@alimzen/relayo-simulator`. El panel muestra los SMS junto a los correos (filtro por canal) y
tiene su pestaña en Escenarios para enviar pruebas.

## Modo en vivo

Relayo también es un proveedor: el mismo proyecto tiene claves de prueba (`rly_test_…`, simulan) y en vivo
(`rly_live_…`, entregan de verdad), por la API, por SMTP y con `@alimzen/relayo-cloud`. El panel cambia entre los
dos modos con el selector de la barra (cabecera `X-Relayo-Mode`); cada clave lleva el suyo.

- **Conexiones**: las cuentas de proveedor del proyecto. Email: SES, SendGrid, Resend, Postmark, Mailgun o SMTP;
  SMS: Twilio. Cada canal entrega por la primera conexión y, si falla, prueba la siguiente (orden editable). Las
  credenciales se guardan cifradas (AES-256-GCM con `SECRETS_KEY`).
- **Eventos**: cada conexión tiene su URL de eventos (`/v1/inbound/<token>`) para configurarla en el proveedor. Los
  eventos se normalizan, llevan el `messageId` y la `metadata` del envío y llegan al webhook del proyecto como los
  simulados. Con Twilio, Relayo pone esa URL como `StatusCallback` en cada SMS (por eso necesita `PUBLIC_URL`);
  para recibir las bajas (STOP), configúrala también como webhook de mensajes entrantes del número.
- **Supresiones**: los rebotes duros, las quejas y las bajas añaden la dirección o el número a la lista del
  proyecto, y los envíos siguientes a ella se rechazan (`rejected` / `suppressed`) sin llegar al proveedor.
- **Envío de Relayo** (opcional, `MANAGED_SMTP_URL`): Relayo entrega por su propio relay, firmando con DKIM el
  dominio del remitente, que se verifica en Dominios (registros DKIM y SPF). Cada proyecto lo solicita y un
  administrador (`ADMIN_EMAILS`) lo aprueba en Administración; al dueño le llega la respuesta por correo
  (`MANAGED_APPROVAL=auto` aprueba sin revisión). Límite diario por proyecto, y pausa si los rebotes duros pasan
  del 5 % o las quejas del 0,3 %.
- **Email confirmado**: con `MAIL_URL`, las cuentas nuevas confirman su email (enlace de 24 h) antes de crear
  claves en vivo, conexiones o pedir el envío de Relayo. Sin `MAIL_URL` nacen confirmadas.
- **Límites**: los envíos reales tienen su propio límite mensual (`LIVE_MONTHLY_MESSAGE_LIMIT`), aparte del de
  mensajes simulados; el ritmo por minuto cuenta ambos.
- **Conexiones que fallan**: tras tres errores transitorios seguidos (proveedor caído, tiempo agotado, límite), una
  conexión pasa al final durante un minuto; el panel la muestra «En pausa».
- **Enviar**: el panel tiene una página para escribir un correo o un SMS a mano, en el modo que esté activo.

## Bandeja de captura

El simulador guarda cada correo completo (el MIME tal cual llega por SMTP; por la API, el que habría enviado un
proveedor, con `html`, `text`, `replyTo`, `headers` y `attachments: [{ filename, content (base64), contentType?, cid? }]`).
El panel lo muestra en pestañas: vista previa (escritorio o móvil), texto, HTML y cabeceras, con los adjuntos y la
descarga del original. La vista previa corre en un iframe sin scripts y con origen opaco, y los adjuntos se sirven
siempre como descarga: el contenido capturado no se ejecuta nunca en el origen del simulador.

## Informes por correo (DSN y ARF)

Como un servidor de correo real, el simulador avisa por correo al remitente del sobre (`MAIL FROM`, o `from` en
la API): un **DSN** (RFC 3464, `multipart/report`) por cada rebote (`Action: failed`) o aplazamiento
(`Action: delayed`), y un **informe ARF** (RFC 5965) por cada queja. Se envían con remitente nulo (`MAIL FROM:<>`)
a través del servidor SMTP que el proyecto configure en `reportsSmtpUrl` (`PATCH /v1/project`; `null` o `""` lo
quita; la API lo devuelve sin contraseña). Citan las cabeceras originales (`Message-ID`, `X-Relayo-Message-ID`,
`X-Relayo-Metadata`), así que `@alimzen/relayo-bounces` / `@alimzen/relayo-imap` los convierten en el evento con el
`messageId` y la `metadata` del envío: está probado así, de punta a punta.

- Por SMTP, los escenarios de rechazo responden al momento. Con `+async` (`hard-bounce+async@`, `blocked+async@`…)
  el simulador **acepta** y rebota después, como un relay: así se prueba la lectura del buzón de rebotes.
- `GET /v1/messages/:id/events/:eventId/report` devuelve el informe de un evento (`message/rfc822`), sin necesidad
  de servidor SMTP. El panel lo muestra con «Ver DSN» / «Ver ARF».

## Panel

Angular 21 (`panel/`), en español: registro y entrada, selector de proyectos, resumen con indicadores y gráfico de
eventos por día, mensajes con búsqueda y filtro por estado, línea de tiempo por destinatario con códigos SMTP y
DSN/ARF, escenarios con envío de prueba, claves de API, webhooks (URL, secreto, informes por correo), ajustes y
cuenta. Claro y oscuro, adaptado a móvil.

```sh
cd panel && pnpm install
pnpm start          # http://localhost:4200, con proxy de /v1 a :3000
pnpm build          # el servidor sirve panel/dist (PANEL_DIR para otra ruta)
```

La landing (`landing/index.html`, HTML estático) se sirve en `/` exactamente, con sus recursos en `/site/`
(`LANDING_DIR` para otra ruta); el panel atiende el resto de rutas (`/login`, `/overview`…).

Angular 22 pide Node ≥ 22.22; se usa la 21 porque el entorno tiene Node 22.17. Subir de versión al actualizar Node.

## Desarrollo

```sh
pnpm install
pnpm test                      # en memoria; con DATABASE_URL en .env también contra PostgreSQL (esquema temporal)
pnpm smoke                     # contra una instancia en marcha (TIME_SCALE=0): crea un proyecto y envía escenarios por SMTP
docker compose up -d           # PostgreSQL (5433) y Redis (6379)
ADMIN_TOKEN=dev DATABASE_URL=postgres://relayo:relayo@localhost:5433/relayo_sim REDIS_URL=redis://localhost:6379 pnpm dev
```

| Variable | Por defecto | |
| --- | --- | --- |
| `PORT` / `SMTP_PORT` | 3000 / 2525 | `SMTP_PORT=off` desactiva SMTP |
| `DATABASE_URL` | — | Sin ella, memoria |
| `REDIS_URL` | — | Sin ella, timers en proceso |
| `ADMIN_TOKEN` | — | Para `/v1/admin/projects` (scripts y smoke) |
| `SIGNUP` | abierto | `closed` cierra el registro |
| `COOKIE_SECURE` | — | Cookie `Secure`; activa siempre con `NODE_ENV=production` |
| `TRUST_PROXY` | — | Detrás de un proxy, para leer la IP real (límite de login) |
| `TIME_SCALE` | 1 | Multiplica los retrasos; `0` = todo al instante |
| `SMTP_MAX_HANG_MS` | 120000 | Límite del escenario `timeout` |
| `TLS_KEY` / `TLS_CERT` | — | PEM para STARTTLS |
| `TLS_KEY_FILE` / `TLS_CERT_FILE` | — | Rutas a los PEM; se releen dos veces al día (certificados que se renuevan) |
| `RETENTION_DAYS` | 7 | Días que se guardan los mensajes y su contenido; se purgan cada hora. `0` = siempre |
| `MONTHLY_MESSAGE_LIMIT` / `MESSAGES_PER_MINUTE` | 0 / 0 | Límites por proyecto (`0` = sin límite). Al pasarlos: HTTP 429; SMTP 452 (mes) o 421 (ritmo) |
| `LIVE_MONTHLY_MESSAGE_LIMIT` | 0 | Envíos reales por proyecto y mes, contados aparte de los simulados (`0` = sin límite) |
| `ADMIN_EMAILS` | — | Emails (separados por comas) de quienes revisan el envío de Relayo en el panel; deben estar confirmados |
| `PUBLIC_URL` | `http://localhost:PORT` | Dirección pública, para el enlace del correo de recuperación de contraseña |
| `MAIL_URL` / `MAIL_FROM` | — | SMTP para los correos de la plataforma (confirmar email, recuperar contraseña, respuestas a solicitudes). Sin él, los enlaces salen en el log y no se pide confirmar el email |
| `SECRETS_KEY` | — | Clave para cifrar las credenciales de las conexiones. Sin ella no se pueden crear (en desarrollo, una clave fija) |
| `SECRETS_KEY_PREVIOUS` | — | Para cambiar `SECRETS_KEY`: la clave anterior (o varias, separadas por comas). Al arrancar se vuelve a cifrar todo con la nueva y el log dice cuándo se puede quitar |
| `MANAGED_SMTP_URL` | — | Relay del envío de Relayo (p. ej. SMTP de Amazon SES). Sin él, la opción no aparece |
| `MANAGED_SPF_INCLUDE` / `MANAGED_DAILY_LIMIT` | — / 200 | `include:` del SPF que se pide publicar, y envíos al día por proyecto |
| `MANAGED_EVENTS_TOKEN` | — | Token de `/v1/inbound/managed/<token>`, donde SNS publica los eventos del relay |
| `MANAGED_SES_REGION` | — | Si el relay es Amazon SES: cada dominio se registra en SES con la misma clave DKIM (BYODKIM), sin registros extra. Credenciales con `AWS_ACCESS_KEY_ID` / `AWS_SECRET_ACCESS_KEY` (permisos `ses:CreateEmailIdentity` y `ses:GetEmailIdentity`) |
| `MANAGED_APPROVAL` | `manual` | `auto` deja usar el envío de Relayo a todos los proyectos sin revisión |

## Despliegue

Una imagen (`Dockerfile`) con API, SMTP, panel y landing. `deploy/` trae lo necesario para un servidor propio
(cualquier VPS con Docker):

- **Caddy** delante: HTTPS con Let's Encrypt, obtenido y renovado solo.
- **SMTP en 587 y 2525** (los puertos de envío que los proveedores de CI dejan abiertos; el 25 no hace falta), con
  STARTTLS usando el mismo certificado. El servicio `certs` lo copia con permisos legibles para el simulador, que
  corre sin privilegios.
- **PostgreSQL y Redis** con volúmenes persistentes.
- **Copia diaria** de la base de datos (03:00 UTC) en `deploy/backups/`, con las 14 últimas.

Producción: **relayo.alimzen.com**.

1. **DNS**: registro `A` de `relayo.alimzen.com` a la IP del servidor (y `AAAA` si tiene IPv6).
2. **Cortafuegos**: abrir 80 y 443 (web y certificado) y 587 y 2525 (SMTP del simulador).
3. **Correo del simulador** (recuperar contraseña): credenciales SMTP de un proveedor (SES, Resend, Postmark,
   Brevo…) con el dominio del remitente verificado (SPF y DKIM de `alimzen.com`).
4. En el servidor (Docker y el plugin compose instalados):

```sh
git clone https://github.com/Alimzen/relayo-sim.git && cd relayo-sim/deploy
cp .env.example .env            # rellenar: POSTGRES_PASSWORD, ADMIN_TOKEN, MAIL_URL, MAIL_FROM
docker compose up -d --build
docker compose logs -f sim      # la primera vez reinicia hasta que Caddy tiene el certificado (1–2 min)
```

5. Comprobar: `https://relayo.alimzen.com` (landing), crear cuenta, "¿La olvidaste?" (debe llegar el correo), y un
   envío por SMTP con STARTTLS a `relayo.alimzen.com:587`.

### Con Dokploy (CI/CD)

`.github/workflows/ci-cd.yml`: en cada push y pull request ejecuta los tests (servidor contra PostgreSQL y Redis
reales, y panel). En `main`, si pasan, construye la imagen, la sube a `ghcr.io/alimzen/relayo-sim` (`latest` y
`sha-<commit>`), avisa a Dokploy (secreto `DOKPLOY_DEPLOY_URL`) y espera a que `https://relayo.alimzen.com/health`
devuelva el commit nuevo.

En Dokploy la aplicación usa la imagen `ghcr.io/alimzen/relayo-sim:latest` (con credenciales del registro si el
paquete es privado), Traefik pone el HTTPS y hay que configurar:

- Variables: `DATABASE_URL`, `REDIS_URL`, `PUBLIC_URL=https://relayo.alimzen.com`, `TRUST_PROXY=1`, `ADMIN_TOKEN`,
  `MONTHLY_MESSAGE_LIMIT`, `MESSAGES_PER_MINUTE`, `LIVE_MONTHLY_MESSAGE_LIMIT`, `RETENTION_DAYS`, `MAIL_URL`, `MAIL_FROM`,
  `SECRETS_KEY`, `ADMIN_EMAILS` y, para el envío de Relayo, `MANAGED_*` (ver `deploy/.env.example`).
- Un monitor de disponibilidad (UptimeRobot, Better Stack…) sobre `https://relayo.alimzen.com/health`: avisa si
  cae la web, PostgreSQL o Redis.
- Dominio `relayo.alimzen.com` al puerto 3000 del contenedor.
- Puertos publicados 587 y 2525 → 2525 del contenedor (SMTP). Sin `TLS_KEY_FILE`/`TLS_CERT_FILE` el SMTP no ofrece
  STARTTLS (los certificados de Traefik no son accesibles desde el contenedor).
- PostgreSQL y Redis como servicios de Dokploy, con sus copias de seguridad. En `DATABASE_URL` y `REDIS_URL` va la
  **Internal Connection URL** de cada servicio (host = nombre del servicio, puertos 5432 y 6379), no la IP pública con
  el puerto externo: desde el contenedor esa ruta suele estar cortada y la conexión caduca.

Para actualizar: `git pull && docker compose up -d --build`. Las migraciones de PostgreSQL se aplican solas al
arrancar. Restaurar una copia: `gunzip -c backups/<fichero>.sql.gz | docker compose exec -T postgres psql -U relayo relayo_sim`.
Las copias están en el mismo servidor: sácalas también fuera (otro servidor, S3…).

Las direcciones de escenario (`@sim.relayo.dev`) no necesitan DNS: los correos llegan al SMTP del simulador porque
la aplicación lo usa como servidor de salida, no por MX.

## Pendiente (fase 2)

- ~~PostgreSQL y BullMQ~~: probados (`test/store.test.ts`, `test/bullmq.test.ts`) contra `DATABASE_URL` y `REDIS_URL` del `.env`, con esquema y prefijo de colas temporales.
- ~~Informes por correo~~: hechos (ver «Informes por correo»).
- ~~Panel Angular~~: hecho (`panel/`).
