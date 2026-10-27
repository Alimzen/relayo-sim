import { Component, computed, effect, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideInbox, LucidePaperclip, LucideRefreshCw } from '@lucide/angular';
import { Api } from '../core/api';
import { formatNumber, fullDate, timeAgo } from '../core/format';
import { Session } from '../core/session';
import type { InboundEmail, ProjectInbound } from '../core/types';
import { EmailPreview } from '../ui/email-preview';
import { CopyButton, EmptyState, Modal, Toasts } from '../ui/ui';

/** Emails the project receives (replies, mostly): the inbound URL to give the provider, and what arrived. */
@Component({
  selector: 'app-inbox',
  imports: [RouterLink, CopyButton, EmptyState, EmailPreview, Modal, LucideInbox, LucidePaperclip, LucideRefreshCw],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Recibidos</h1>
          <p>
            Los correos que llegan a tu dominio (respuestas, sobre todo), normalizados y enviados a tus webhooks. Cuando responden a un
            correo que enviaste, llevan su id y su metadata.
          </p>
        </div>
      </header>

      <div class="stack">
        @if (admin()) {
          <section class="card">
            <header class="card-head">
              <div>
                <h2>Dirección de entrada</h2>
                <p class="muted small">La URL a la que tu proveedor envía los correos que recibe tu dominio.</p>
              </div>
              @if (config(); as c) {
                @if (c.enabled) {
                  <button type="button" class="btn btn-sm btn-ghost danger-text" (click)="disable()" [disabled]="busy()">Desactivar</button>
                } @else {
                  <button type="button" class="btn btn-primary btn-sm" (click)="enable()" [disabled]="busy()">Activar</button>
                }
              }
            </header>
            @if (config()?.url; as url) {
              <div class="card-body stack">
                <div class="secret">
                  <code class="truncate">{{ url }}</code>
                  <app-copy [value]="url" label="Copiar URL" />
                </div>
                <ul class="muted small hints">
                  <li><strong>SendGrid</strong>: Inbound Parse con «POST the raw, full MIME message».</li>
                  <li><strong>Mailgun</strong>: una ruta con <code>forward()</code> a esta URL terminada en <code>mime</code> si quieres el original.</li>
                  <li><strong>Postmark</strong>: el webhook de entrada con «Include raw email content».</li>
                  <li><strong>Amazon SES</strong>: una regla de recepción con acción SNS (codificación Base64) y la URL como suscripción HTTPS.</li>
                  <li>O cualquier sistema que haga POST del correo tal cual, con <code>Content-Type: message/rfc822</code>.</li>
                </ul>
                <p class="muted small">
                  Para recibirlos en tu aplicación, añade en <a routerLink="/webhooks">Webhooks</a> un endpoint con el evento
                  «Correos recibidos»: la URL principal solo recibe eventos de mensajes.
                </p>
              </div>
            }
          </section>
        }

        <section class="card">
          <header class="card-head">
            <h2>Correos</h2>
            <button type="button" class="icon-button" (click)="reload()" aria-label="Actualizar" title="Actualizar"><svg lucideRefreshCw [size]="15"></svg></button>
          </header>
          @if (emails(); as list) {
            @if (list.length) {
              <div class="table-wrap">
                <table class="table">
                  <thead>
                    <tr>
                      <th>De</th>
                      <th>Asunto</th>
                      <th>Responde a</th>
                      <th>Cuándo</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (e of list; track e.id) {
                      <tr class="clickable" tabindex="0" (click)="selected.set(e)" (keydown.enter)="selected.set(e)">
                        <td class="cell-main">
                          {{ e.fromName || e.from }}
                          @if (e.fromName) {
                            <div class="muted small">{{ e.from }}</div>
                          }
                        </td>
                        <td>
                          <span class="truncate">{{ e.subject || '(sin asunto)' }}</span>
                          @if (e.attachments.length) {
                            <span class="muted small"> <svg lucidePaperclip [size]="12"></svg>{{ e.attachments.length }}</span>
                          }
                        </td>
                        <td class="small">
                          @if (e.replyTo) {
                            <a [routerLink]="['/messages', e.replyTo.relayoId]" (click)="$event.stopPropagation()"><code>{{ e.replyTo.relayoId }}</code></a>
                          } @else {
                            <span class="muted">—</span>
                          }
                        </td>
                        <td class="nowrap" [title]="full(e.createdAt)">{{ ago(e.createdAt) }}</td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              @if (more()) {
                <footer class="card-foot">
                  <span></span>
                  <button type="button" class="btn btn-sm" (click)="loadMore()" [disabled]="busy()">Cargar más</button>
                </footer>
              }
            } @else {
              <app-empty heading="Nada recibido todavía">
                <svg icon lucideInbox [size]="20"></svg>
                {{ config()?.enabled ? 'Aquí aparecerá cada correo que tu proveedor envíe a la dirección de entrada.' : 'Activa la dirección de entrada y dásela a tu proveedor.' }}
              </app-empty>
            }
          } @else {
            <div class="card-body stack"><div class="skeleton"></div><div class="skeleton"></div></div>
          }
        </section>
      </div>
    </div>

    <app-modal [heading]="selected()?.subject || '(sin asunto)'" [open]="!!selected()" (closed)="selected.set(null)">
      @if (selected(); as e) {
        <dl class="props">
          <div><dt>De</dt><dd>{{ e.fromName ? e.fromName + ' <' + e.from + '>' : e.from }}</dd></div>
          <div><dt>Para</dt><dd>{{ e.to.join(', ') }}</dd></div>
          @if (e.cc?.length) {
            <div><dt>Cc</dt><dd>{{ e.cc!.join(', ') }}</dd></div>
          }
          <div><dt>Recibido</dt><dd>{{ full(e.createdAt) }} · {{ format(e.size) }} bytes</dd></div>
          @if (e.attachments.length) {
            <div><dt>Adjuntos</dt><dd>{{ attachmentList(e) }}</dd></div>
          }
        </dl>
        @if (e.html) {
          <app-email-preview [html]="e.html" />
        } @else {
          <pre class="delivery-pre">{{ e.text || '(sin texto)' }}</pre>
        }
        <div class="modal-actions">
          <button type="button" class="btn" (click)="selected.set(null)">Cerrar</button>
        </div>
      }
    </app-modal>
  `,
})
export class InboxPage {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly toasts = inject(Toasts);
  protected readonly admin = computed(() => this.session.project()?.role !== 'member');
  protected readonly config = signal<ProjectInbound | null>(null);
  protected readonly emails = signal<InboundEmail[] | null>(null);
  protected readonly selected = signal<InboundEmail | null>(null);
  protected readonly more = signal(false);
  protected readonly busy = signal(false);
  protected readonly format = formatNumber;
  protected readonly ago = (value: string) => timeAgo(value);
  protected readonly full = (value: string) => fullDate(value);
  private static readonly PAGE = 25;

  constructor() {
    effect(() => {
      this.session.project();
      void this.reload();
      if (this.admin()) {
        this.api.inbound().then(
          (c) => this.config.set(c),
          (error) => this.toasts.error(error),
        );
      }
    });
  }

  protected async reload(): Promise<void> {
    try {
      const list = await this.api.inboundEmails({ limit: InboxPage.PAGE });
      this.emails.set(list);
      this.more.set(list.length === InboxPage.PAGE);
    } catch (error) {
      this.emails.set([]);
      this.toasts.error(error);
    }
  }

  protected async loadMore(): Promise<void> {
    const last = this.emails()?.at(-1);
    if (!last || this.busy()) return;
    this.busy.set(true);
    try {
      const next = await this.api.inboundEmails({ limit: InboxPage.PAGE, before: last.createdAt });
      this.emails.update((list) => [...(list ?? []), ...next]);
      this.more.set(next.length === InboxPage.PAGE);
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected async enable(): Promise<void> {
    await this.run(async () => {
      this.config.set(await this.api.enableInbound());
      this.toasts.show('Dirección de entrada activada');
    });
  }

  protected async disable(): Promise<void> {
    await this.run(async () => {
      await this.api.disableInbound();
      this.config.set({ enabled: false, url: null });
      this.toasts.show('Dirección de entrada desactivada: la URL deja de funcionar');
    });
  }

  protected attachmentList(e: InboundEmail): string {
    return e.attachments.map((a) => `${a.filename} (${formatNumber(a.size)} bytes)`).join(', ');
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await action();
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}
