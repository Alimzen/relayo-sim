import { Controller, Get, Headers, Inject, Param, Res } from '@nestjs/common';
import type { Response } from 'express';
import { LiveService } from '../live/live.service.js';

/** A transparent 1×1 GIF. */
const PIXEL = Buffer.from('R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7', 'base64');

/** Opens (the pixel) and clicks (tracked links) of live emails. */
@Controller('t')
export class TrackingController {
  constructor(@Inject(LiveService) private readonly live: LiveService) {}

  /** Always the pixel, even for a bad token: an email client gets an image either way. */
  @Get('o/:token')
  async open(@Param('token') token: string, @Headers('user-agent') userAgent: string | undefined, @Res() res: Response) {
    await this.live.track('open', token.replace(/\.gif$/, ''), userAgent).catch(() => undefined);
    res.status(200).type('image/gif').setHeader('Cache-Control', 'no-store, max-age=0').send(PIXEL);
  }

  @Get('c/:token')
  async click(@Param('token') token: string, @Headers('user-agent') userAgent: string | undefined, @Res() res: Response) {
    const found = await this.live.track('click', token, userAgent);
    if (!found?.url) return res.status(404).type('text').send('Enlace no válido');
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Robots-Tag', 'noindex');
    return res.redirect(302, found.url);
  }
}
