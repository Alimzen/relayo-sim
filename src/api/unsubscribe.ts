import { Body, Controller, Get, HttpCode, Inject, Param, Post, Res } from '@nestjs/common';
import type { Response } from 'express';
import { LiveService } from '../live/live.service.js';

/**
 * The hosted unsubscribe page of live emails, and the one-click unsubscribe of RFC 8058: mail clients POST
 * `List-Unsubscribe=One-Click` to the address in the `List-Unsubscribe` header.
 */
@Controller('u')
export class UnsubscribeController {
  constructor(@Inject(LiveService) private readonly live: LiveService) {}

  @Get(':token')
  async page(@Param('token') token: string, @Res() res: Response) {
    const found = await this.live.unsubscribeTarget(token);
    if (!found) return send(res, 404, page('Enlace no válido', '<p>Este enlace de baja no es válido o ha caducado.</p>'));
    if (found.done) return send(res, 200, done(found.projectName, found.recipient));
    return send(
      res,
      200,
      page(
        'Darse de baja',
        `<p>¿Dejar de recibir correos de <strong>${escape(found.projectName)}</strong> en <strong>${escape(mask(found.recipient))}</strong>?</p>
        <form method="post"><input type="hidden" name="confirm" value="1"><button type="submit">Darme de baja</button></form>`,
      ),
    );
  }

  @Post(':token')
  @HttpCode(200)
  async unsubscribe(@Param('token') token: string, @Body() body: Record<string, unknown> | undefined, @Res() res: Response) {
    const result = await this.live.unsubscribe(token);
    const oneClick = body?.['List-Unsubscribe'] === 'One-Click';
    if (!result) return oneClick ? res.status(404).end() : send(res, 404, page('Enlace no válido', '<p>Este enlace de baja no es válido.</p>'));
    if (oneClick) return res.status(200).end();
    return send(res, 200, done(result.projectName, result.recipient));
  }
}

function done(projectName: string, recipient: string): string {
  return page('Baja hecha', `<p>Listo: <strong>${escape(mask(recipient))}</strong> ya no recibirá más correos de <strong>${escape(projectName)}</strong>.</p>`);
}

function send(res: Response, status: number, html: string): void {
  res.status(status).type('html').setHeader('Cache-Control', 'no-store').setHeader('X-Robots-Tag', 'noindex').send(html);
}

/** a••••@empresa.com: enough to recognize one's address on a page anyone with the link can open. */
function mask(address: string): string {
  const [user = '', domain = ''] = address.split('@');
  return `${user.slice(0, 1)}${'•'.repeat(Math.max(1, Math.min(6, user.length - 1)))}@${domain}`;
}

function escape(text: string): string {
  return text.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
}

function page(title: string, content: string): string {
  return `<!doctype html>
<html lang="es">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="robots" content="noindex">
<title>${escape(title)}</title>
<style>
  :root { color-scheme: light dark; --bg: #f6f7f9; --card: #fff; --text: #16181d; --muted: #5d6470; --accent: #2f5bea; }
  @media (prefers-color-scheme: dark) { :root { --bg: #0f1115; --card: #181b21; --text: #eceef2; --muted: #9aa1ad; --accent: #7c9cff; } }
  body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: var(--bg); color: var(--text);
    font: 16px/1.5 system-ui, -apple-system, "Segoe UI", sans-serif; }
  main { box-sizing: border-box; width: min(440px, calc(100% - 32px)); background: var(--card); border-radius: 12px; padding: 28px;
    box-shadow: 0 1px 3px rgb(0 0 0 / 0.08); }
  h1 { font-size: 20px; margin: 0 0 12px; }
  p { margin: 0 0 16px; color: var(--muted); }
  strong { color: var(--text); font-weight: 600; word-break: break-word; }
  button { font: inherit; font-weight: 600; color: #fff; background: var(--accent); border: 0; border-radius: 8px; padding: 10px 18px; cursor: pointer; }
  footer { margin-top: 20px; font-size: 13px; color: var(--muted); }
</style>
</head>
<body>
<main>
<h1>${escape(title)}</h1>
${content}
<footer>Gestionado con Relayo.</footer>
</main>
</body>
</html>`;
}
