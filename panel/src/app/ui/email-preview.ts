import { Component, computed, inject, input, signal } from '@angular/core';
import { DomSanitizer } from '@angular/platform-browser';
import { LucideMonitor, LucideSmartphone } from '@lucide/angular';

/**
 * The captured HTML runs in a sandbox with no scripts and an opaque origin, so it can neither run code
 * nor read the panel's session. The CSP lets images and styles load, as in a mail client, and nothing else.
 */
const HEAD = `<meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data: https: http:; style-src 'unsafe-inline' https:; font-src data: https:"><base target="_blank"><style>body{margin:0;padding:16px;font-family:system-ui,sans-serif;color:#18181b;background:#fff}</style>`;

@Component({
  selector: 'app-email-preview',
  imports: [LucideMonitor, LucideSmartphone],
  template: `
    <div class="preview-bar">
      <div class="segmented" role="group" aria-label="Ancho">
        <button type="button" [attr.aria-pressed]="width() === 'desktop'" (click)="width.set('desktop')" title="Escritorio">
          <svg lucideMonitor [size]="14"></svg><span class="sr-only">Escritorio</span>
        </button>
        <button type="button" [attr.aria-pressed]="width() === 'mobile'" (click)="width.set('mobile')" title="Móvil">
          <svg lucideSmartphone [size]="14"></svg><span class="sr-only">Móvil</span>
        </button>
      </div>
    </div>
    <div class="preview-stage">
      <iframe
        class="preview-frame"
        [class.preview-mobile]="width() === 'mobile'"
        title="Vista previa del correo"
        sandbox="allow-popups allow-popups-to-escape-sandbox"
        referrerpolicy="no-referrer"
        [srcdoc]="doc()"
      ></iframe>
    </div>
  `,
})
export class EmailPreview {
  readonly html = input.required<string>();
  protected readonly width = signal<'desktop' | 'mobile'>('desktop');
  private readonly sanitizer = inject(DomSanitizer);
  // Trusted only because the frame is sandboxed without allow-scripts or allow-same-origin.
  protected readonly doc = computed(() => this.sanitizer.bypassSecurityTrustHtml(withHead(this.html())));
}

/** Puts our head first, so the CSP applies to everything the email loads. */
export function withHead(html: string): string {
  const head = /<head[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + HEAD + html.slice(head.index + head[0].length);
  const root = /<html[^>]*>/i.exec(html);
  if (root) return html.slice(0, root.index + root[0].length) + `<head>${HEAD}</head>` + html.slice(root.index + root[0].length);
  return `<!doctype html><html><head>${HEAD}</head><body>${html}</body></html>`;
}
