# Sitio web propio (opcional)

La plataforma no trae sitio web: sin él, `/` abre el panel. Una instalación puede poner aquí el suyo antes de
construir la imagen (o montarlo con `SITE_DIR`):

- `index.html` se sirve en `/`.
- Cada `<página>.html` en `/<página>` (por ejemplo `terminos.html` en `/terminos`).
- Todo lo demás (CSS, fuentes, imágenes) en `/site/<fichero>`.

Las páginas legales se enlazan desde el registro con `TERMS_URL` y `PRIVACY_URL`, estén aquí o en otro sitio.

El contenido de esta carpeta no se sube al repositorio (`.gitignore`), salvo este README.

En relayo.alimzen.com, el CI copia aquí el repositorio privado `Alimzen/relayo-site` (secreto `SITE_REPO_TOKEN`) antes de
construir la imagen: para publicar un cambio de la landing, vuelve a desplegar relayo-sim.
