# Relayo Sim

Simulador de escenarios de entrega de correo (producto de pago de Relayo). La app envía al simulador —por
SMTP o por la API HTTP— y este responde como el mundo real: rebotes, greylisting, bloqueos, buzón lleno,
quejas, retrasos… y emite los eventos correspondientes como webhooks firmados con el formato de Relayo.

Repositorio privado. La librería y el driver `@alimzen/simulator` son open source: https://github.com/Alimzen/relayo

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
  `classifyBounce` de `@alimzen/core`, así el simulador coincide con lo que reportan los drivers.
- `src/smtp/`: servidor SMTP (`smtp-server`). Autenticación con la API key del proyecto. Responde en
  `RCPT TO` (dirección) o tras `DATA` (contenido, cabecera de escenario). `timeout` deja la conexión colgada
  hasta `SMTP_MAX_HANG_MS`.
- `src/simulation/`: `SimulationService`, que une escenarios, almacenamiento, planificación y webhooks.
- `src/store/`, `src/scheduler/`, `src/webhooks/`, `src/queues/`: interfaces con implementación en memoria
  (tests, local) y de producción (PostgreSQL, BullMQ).
- `src/api/`: API HTTP.

## API

| Método y ruta | Auth | |
| --- | --- | --- |
| `GET /health` | — | |
| `GET /v1/scenarios` | — | Catálogo |
| `POST /v1/messages` | API key | Envío (202, `{ id, status: 'queued' }`) |
| `GET /v1/messages?limit=&before=` | API key | Últimos mensajes |
| `GET /v1/messages/:id` | API key | Mensaje con su línea de tiempo |
| `GET /v1/messages/:id/events/:eventId/report` | API key | DSN o ARF del evento (`message/rfc822`) |
| `GET`, `PATCH /v1/project` | API key | Proyecto, `webhookUrl` y `reportsSmtpUrl` |
| `POST /v1/admin/projects` | `ADMIN_TOKEN` | Crea un proyecto sin dueño (scripts); devuelve `apiKey` y `webhookSecret` una sola vez |

Webhooks: `POST` con un evento Relayo en JSON y `Relayo-Signature: t=<unix>,v1=<hex HMAC-SHA256 de "t.cuerpo">`
(secreto del proyecto). 8 reintentos con backoff exponencial.

## Informes por correo (DSN y ARF)

Como un servidor de correo real, el simulador avisa por correo al remitente del sobre (`MAIL FROM`, o `from` en
la API): un **DSN** (RFC 3464, `multipart/report`) por cada rebote (`Action: failed`) o aplazamiento
(`Action: delayed`), y un **informe ARF** (RFC 5965) por cada queja. Se envían con remitente nulo (`MAIL FROM:<>`)
a través del servidor SMTP que el proyecto configure en `reportsSmtpUrl` (`PATCH /v1/project`; `null` o `""` lo
quita; la API lo devuelve sin contraseña). Citan las cabeceras originales (`Message-ID`, `X-Relayo-Message-ID`,
`X-Relayo-Metadata`), así que `@alimzen/bounces` / `@alimzen/imap` los convierten en el evento con el
`messageId` y la `metadata` del envío: está probado así, de punta a punta.

- Por SMTP, los escenarios de rechazo responden al momento. Con `+async` (`hard-bounce+async@`, `blocked+async@`…)
  el simulador **acepta** y rebota después, como un relay: así se prueba la lectura del buzón de rebotes.
- `GET /v1/messages/:id/events/:eventId/report` devuelve el informe de un evento (`message/rfc822`), sin necesidad
  de servidor SMTP. El panel lo muestra con «Ver DSN» / «Ver ARF».

## Panel

Angular 21 (`panel/`): entrar con la API key del proyecto, lista de mensajes (se actualiza sola), línea de tiempo
por destinatario con códigos SMTP y JSON de cada evento, catálogo de escenarios con envío de prueba, y ajustes
del proyecto (URL del webhook, datos de conexión). Claro y oscuro, adaptado a móvil.

```sh
cd panel && pnpm install
pnpm start          # http://localhost:4200, con proxy de /v1 a :3000
pnpm build          # el servidor sirve panel/dist en / (PANEL_DIR para otra ruta)
```

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
| `ADMIN_TOKEN` | — | Sin él no se pueden crear proyectos |
| `TIME_SCALE` | 1 | Multiplica los retrasos; `0` = todo al instante |
| `SMTP_MAX_HANG_MS` | 120000 | Límite del escenario `timeout` |
| `TLS_KEY` / `TLS_CERT` | — | PEM para STARTTLS |

Mientras `@alimzen/core` 0.2.1 / `@alimzen/smtp` 0.2.1 y `@alimzen/simulator` no estén publicados, `package.json`
enlaza los paquetes locales de `../relayo` (`pnpm.overrides`). Quitar los overrides tras publicarlos.

## Pendiente (fase 2)

- ~~PostgreSQL y BullMQ~~: probados (`test/store.test.ts`, `test/bullmq.test.ts`) contra `DATABASE_URL` y `REDIS_URL` del `.env`, con esquema y prefijo de colas temporales.
- ~~Informes por correo~~: hechos (ver «Informes por correo»).
- ~~Panel Angular~~: hecho (`panel/`).
