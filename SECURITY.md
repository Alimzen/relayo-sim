# Seguridad

## Cómo avisar de una vulnerabilidad

No abras un issue público. Usa el aviso privado de GitHub: pestaña **Security** del repositorio →
**Report a vulnerability**. Solo lo ven las personas que mantienen el proyecto.

Cuéntanos qué componente es (API, SMTP, panel, webhooks…), cómo reproducirlo y qué impacto crees que tiene. Te
responderemos en unos días; cuando esté corregido, publicaremos un aviso y, si quieres, te lo atribuiremos.

## Qué versión se corrige

Solo la rama `main`, la que despliega relayo.alimzen.com. Si te alojas Relayo Sim, actualiza a menudo: las migraciones
de la base de datos se aplican solas al arrancar.

## Para quien se lo aloja

- Define `SECRETS_KEY` (cifra las credenciales de los proveedores) y guárdala: sin ella el modo en vivo no funciona, y
  si se pierde no se pueden leer las credenciales guardadas.
- Usa `NODE_ENV=production` (cookie `Secure`) y HTTPS delante, y `TRUST_PROXY` si hay un proxy.
- `ADMIN_TOKEN` da acceso a crear proyectos sin dueño y a los planes: déjalo vacío si no lo usas.
