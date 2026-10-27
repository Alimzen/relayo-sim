# Contribuir a Relayo Sim

Gracias por querer mejorar Relayo Sim. Este repositorio es la plataforma (API, SMTP, simulador, modo en vivo y panel);
la librería y los drivers (`@alimzen/relayo`, `@alimzen/relayo-*`) están en [Alimzen/relayo](https://github.com/Alimzen/relayo).

## Antes de empezar

- Para un error, abre un issue con lo que hiciste, lo que esperabas y lo que pasó (versión o commit, y el log si lo hay).
- Para algo nuevo, abre primero un issue y cuéntalo: así acordamos el enfoque antes de que inviertas tiempo.
- Los fallos de seguridad **no** van en issues públicos: mira [SECURITY.md](SECURITY.md).

## Entorno

Node 22 y pnpm (la versión está en `packageManager`).

```sh
pnpm install
pnpm test                      # en memoria; sin PostgreSQL ni Redis
pnpm typecheck
cd panel && pnpm install && pnpm start   # panel en :4200, con proxy de /v1 a :3000
```

Para probar también contra PostgreSQL y Redis reales: `docker compose up -d` y `TEST_DATABASE_URL` / `TEST_REDIS_URL`
(los tests usan un esquema y un prefijo de colas temporales). El CI los ejecuta siempre así.

## Cómo está hecho

- TypeScript estricto (`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`), imports relativos con `.js`.
- NestJS con `@Inject(token)` explícito en cada dependencia (el código se compila sin metadata de decoradores).
- Todo lo que se guarda pasa por `SimStore`, con dos implementaciones que deben comportarse igual: `MemoryStore` y
  `PostgresStore`. Un método nuevo lleva su test en `test/store.test.ts`, que corre contra las dos.
- Cada ruta nueva de la API se documenta en `src/api/openapi.ts` (o se añade a `UNDOCUMENTED` si es solo del panel);
  `test/openapi.test.ts` falla si no.
- Código, identificadores y comentarios en inglés; documentación y textos del panel en español.

## Pull requests

- Una PR por cambio, con tests que lo cubran. `pnpm typecheck`, `pnpm test` y el build del panel deben pasar.
- Mensajes de commit en inglés, en presente y explicando el porqué cuando no es obvio.
- Al contribuir aceptas que tu aportación se publique bajo la licencia del proyecto, la
  [GNU AGPL-3.0](LICENSE).

## Código de conducta

Este proyecto sigue el [código de conducta](CODE_OF_CONDUCT.md). Al participar te comprometes a respetarlo.
