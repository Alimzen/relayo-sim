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

| Método y ruta | Auth | |
| --- | --- | --- |
| `GET /health` | — | |
| `GET /v1/auth/config` | — | `{ signup, minPassword }` |
| `POST /v1/auth/signup`, `/login`, `/logout` | — | Abre o cierra la sesión |
| `GET`, `PATCH /v1/auth/me` · `POST /v1/auth/password` | Sesión | Perfil y contraseña (cierra las otras sesiones) |
| `GET`, `POST /v1/projects` · `POST /v1/projects/claim` | Sesión | Proyectos del usuario |
| `GET /v1/scenarios` | — | Catálogo |
| `POST /v1/messages` | API key | Envío (202, `{ id, status: 'queued' }`) |
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
`X-Relayo-Metadata`), así que `@alimzen/bounces` / `@alimzen/imap` los convierten en el evento con el
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
| `PUBLIC_URL` | `http://localhost:PORT` | Dirección pública, para el enlace del correo de recuperación de contraseña |
| `MAIL_URL` / `MAIL_FROM` | — | SMTP para los correos del propio simulador (recuperar contraseña). Sin él, el enlace sale en el log |

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
  `MONTHLY_MESSAGE_LIMIT`, `MESSAGES_PER_MINUTE`, `RETENTION_DAYS`, `MAIL_URL`, `MAIL_FROM` (ver `deploy/.env.example`).
- Dominio `relayo.alimzen.com` al puerto 3000 del contenedor.
- Puertos publicados 587 y 2525 → 2525 del contenedor (SMTP). Sin `TLS_KEY_FILE`/`TLS_CERT_FILE` el SMTP no ofrece
  STARTTLS (los certificados de Traefik no son accesibles desde el contenedor).
- PostgreSQL y Redis como servicios de Dokploy, con sus copias de seguridad.

Para actualizar: `git pull && docker compose up -d --build`. Las migraciones de PostgreSQL se aplican solas al
arrancar. Restaurar una copia: `gunzip -c backups/<fichero>.sql.gz | docker compose exec -T postgres psql -U relayo relayo_sim`.
Las copias están en el mismo servidor: sácalas también fuera (otro servidor, S3…).

Las direcciones de escenario (`@sim.relayo.dev`) no necesitan DNS: los correos llegan al SMTP del simulador porque
la aplicación lo usa como servidor de salida, no por MX.

## Pendiente (fase 2)

- ~~PostgreSQL y BullMQ~~: probados (`test/store.test.ts`, `test/bullmq.test.ts`) contra `DATABASE_URL` y `REDIS_URL` del `.env`, con esquema y prefijo de colas temporales.
- ~~Informes por correo~~: hechos (ver «Informes por correo»).
- ~~Panel Angular~~: hecho (`panel/`).
