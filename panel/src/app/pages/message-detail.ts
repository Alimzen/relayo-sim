import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { RouterLink } from '@angular/router';
import {
  LucideArrowLeft,
  LucideCheck,
  LucideCircleAlert,
  LucideClock,
  LucideDownload,
  LucideFileText,
  LucidePaperclip,
  LucideMail,
  LucideRefreshCw,
} from '@lucide/angular';
import { Api } from '../core/api';
import { detailOf, lookOf, reportOf, scenarioLabel, type Tone } from '../core/events';
import { fileSize, fullDate, timeAgo } from '../core/format';
import type { MessageContent, MessageDetail, Recipient, SimEvent } from '../core/types';
import { EmailPreview } from '../ui/email-preview';
import { Badge, CopyButton, EmptyState, Toasts } from '../ui/ui';

type Tab = 'events' | 'preview' | 'text' | 'html' | 'headers';

interface Track {
  recipient: Recipient;
  events: SimEvent[];
}

@Component({
  selector: 'app-message-detail',
  imports: [
    RouterLink,
    Badge,
    CopyButton,
    EmptyState,
    LucideArrowLeft,
    LucideCheck,
    LucideCircleAlert,
    LucideClock,
    LucideDownload,
    LucideFileText,
    LucidePaperclip,
    EmailPreview,
    LucideMail,
    LucideRefreshCw,
  ],
  template: `
    <div class="page">
      <a class="breadcrumb" routerLink="/messages"><svg lucideArrowLeft [size]="14"></svg>Mensajes</a>

      @if (missing()) {
        <div class="card">
          <app-empty heading="Mensaje no encontrado">
            <svg icon lucideMail [size]="20"></svg>
            No existe en este proyecto, o se ha borrado.
          </app-empty>
        </div>
      } @else if (message(); as m) {
        <header class="page-head">
          <div class="detail-title">
            <h1 class="truncate">{{ m.subject || '(sin asunto)' }}</h1>
            <p>De {{ m.from }} · {{ full(m.createdAt) }}</p>
          </div>
          <div class="row">
            @if (m.size) {
              <button type="button" class="btn" (click)="downloadRaw(m.id)"><svg lucideDownload [size]="14"></svg>Original</button>
            }
            <button type="button" class="btn" (click)="load()"><svg lucideRefreshCw [size]="14"></svg>Actualizar</button>
          </div>
        </header>

        <nav class="tabs" aria-label="Secciones del mensaje">
          @for (t of tabs(); track t.id) {
            <a
              class="tab"
              [routerLink]="[]"
              [queryParams]="{ tab: t.id === 'events' ? null : t.id }"
              replaceUrl
              [attr.aria-current]="current() === t.id ? 'page' : null"
              >{{ t.label }}</a
            >
          }
        </nav>

        <div class="detail-grid">
          <div class="stack">
            @if (current() !== 'events') {
              @if (content(); as c) {
                <section class="card">
                  <dl class="envelope">
                    @if (c.from) {
                      <div><dt>De</dt><dd>{{ c.from }}</dd></div>
                    }
                    @if (c.to) {
                      <div><dt>Para</dt><dd>{{ c.to }}</dd></div>
                    }
                    @if (c.cc) {
                      <div><dt>Cc</dt><dd>{{ c.cc }}</dd></div>
                    }
                    @if (c.replyTo) {
                      <div><dt>Responder a</dt><dd>{{ c.replyTo }}</dd></div>
                    }
                    <div><dt>Asunto</dt><dd>{{ c.subject || '(sin asunto)' }}</dd></div>
                  </dl>
                  @switch (current()) {
                    @case ('preview') {
                      @if (c.html) {
                        <app-email-preview [html]="c.html" />
                      } @else {
                        <pre class="body-text">{{ c.text || '(sin cuerpo)' }}</pre>
                      }
                    }
                    @case ('text') {
                      @if (c.text) {
                        <pre class="body-text">{{ c.text }}</pre>
                      } @else {
                        <p class="card-body muted">Este correo no tiene versión de texto: los clientes que no muestran HTML no verán nada.</p>
                      }
                    }
                    @case ('html') {
                      <div class="code-head">
                        <span class="muted small">{{ size(c.html?.length ?? 0) }}</span>
                        @if (c.html) {
                          <app-copy [value]="c.html" label="Copiar HTML" />
                        }
                      </div>
                      <pre class="body-code">{{ c.html || '(sin HTML)' }}</pre>
                    }
                    @case ('headers') {
                      <div class="table-wrap">
                        <table class="table headers-table">
                          <tbody>
                            @for (h of c.headers; track $index) {
                              <tr>
                                <th scope="row" class="mono">{{ h.name }}</th>
                                <td class="mono">{{ h.value }}</td>
                              </tr>
                            }
                          </tbody>
                        </table>
                      </div>
                    }
                  }
                </section>
              } @else if (contentError()) {
                <div class="card"><p class="card-body muted">{{ contentError() }}</p></div>
              } @else {
                <div class="card card-pad stack"><div class="skeleton"></div><div class="skeleton"></div></div>
              }
            } @else {
            @for (track of tracks(); track track.recipient.address) {
              <section class="card">
                <header class="card-head">
                  <div class="track-head">
                    <h2 class="truncate">{{ track.recipient.address }}</h2>
                    <span class="chip mono">{{ scenario(track.recipient) }}</span>
                  </div>
                  @if (track.events.at(-1); as last) {
                    <app-badge [tone]="look(last).tone">{{ look(last).label }}</app-badge>
                  }
                </header>
                <div class="card-body">
                  @if (track.events.length === 0) {
                    <p class="muted">Sin eventos todavía: el escenario aún no ha decidido qué pasa con este destinatario.</p>
                  } @else {
                    <ol class="timeline">
                      @for (event of track.events; track event.id) {
                        <li>
                          <span class="timeline-dot" [attr.data-tone]="look(event).tone" aria-hidden="true">
                            @switch (icon(look(event).tone)) {
                              @case ('ok') {
                                <svg lucideCheck [size]="12" [strokeWidth]="2.5"></svg>
                              }
                              @case ('wait') {
                                <svg lucideClock [size]="12" [strokeWidth]="2.5"></svg>
                              }
                              @default {
                                <svg lucideCircleAlert [size]="12" [strokeWidth]="2.5"></svg>
                              }
                            }
                          </span>
                          <div>
                            <div class="timeline-head">
                              <strong>{{ look(event).label }}</strong>
                              <time [attr.datetime]="event.timestamp" [title]="full(event.timestamp)">{{ ago(event.timestamp) }}</time>
                            </div>
                            @if (detail(event); as text) {
                              <p class="timeline-detail">{{ text }}</p>
                            }
                            @if (event.diagnostic) {
                              <code class="timeline-diag">{{ event.diagnostic }}</code>
                            }
                            @if (reportOf(event); as kind) {
                              <div class="timeline-actions">
                                <button type="button" class="btn btn-sm btn-ghost" (click)="toggleReport(event)">
                                  <svg lucideFileText [size]="14"></svg>
                                  {{ reports()[event.id] !== undefined ? 'Ocultar ' + kind : 'Ver ' + kind }}
                                </button>
                                @if (reports()[event.id]; as raw) {
                                  <app-copy [value]="raw" [label]="'Copiar ' + kind" />
                                }
                              </div>
                              @if (reports()[event.id] !== undefined) {
                                <pre>{{ reports()[event.id] || 'Cargando…' }}</pre>
                              }
                            }
                          </div>
                        </li>
                      }
                    </ol>
                  }
                </div>
              </section>
            }
            }
          </div>

          <aside class="stack">
          @if (files().length) {
            <section class="card card-pad">
              <h2 class="aside-title">Adjuntos</h2>
              <ul class="files">
                @for (f of files(); track f.index) {
                  <li>
                    <svg lucidePaperclip [size]="15" class="muted"></svg>
                    <span class="file-name">
                      <span class="truncate">{{ f.filename }}</span>
                      <small class="muted">{{ f.contentType }} · {{ size(f.size) }}</small>
                    </span>
                    <button
                      type="button"
                      class="icon-button"
                      (click)="downloadAttachment(m.id, f.index, f.filename)"
                      [attr.aria-label]="'Descargar ' + f.filename"
                      title="Descargar"
                    >
                      <svg lucideDownload [size]="15"></svg>
                    </button>
                  </li>
                }
              </ul>
            </section>
          }
          <section class="card card-pad">
            <h2 class="aside-title">Detalles</h2>
            <dl class="props">
              <div>
                <dt>Id del simulador</dt>
                <dd><code class="truncate">{{ m.id }}</code><app-copy [value]="m.id" label="Copiar id" /></dd>
              </div>
              @if (m.relayoMessageId) {
                <div>
                  <dt>messageId de Relayo</dt>
                  <dd><code class="truncate">{{ m.relayoMessageId }}</code><app-copy [value]="m.relayoMessageId" label="Copiar messageId" /></dd>
                </div>
              }
              <div>
                <dt>Recibido por</dt>
                <dd>{{ m.via === 'smtp' ? 'SMTP' : 'API HTTP' }}</dd>
              </div>
              <div>
                <dt>Remitente</dt>
                <dd>{{ m.from }}</dd>
              </div>
              @if (m.envelopeFrom && m.envelopeFrom !== m.from) {
                <div>
                  <dt>MAIL FROM (sobre)</dt>
                  <dd>{{ m.envelopeFrom }}</dd>
                </div>
              }
              <div>
                <dt>Destinatarios</dt>
                <dd>{{ m.recipients.length }}</dd>
              </div>
              @if (m.tags?.length) {
                <div>
                  <dt>Tags</dt>
                  <dd class="wrap">
                    @for (tag of m.tags; track tag) {
                      <span class="chip">{{ tag }}</span>
                    }
                  </dd>
                </div>
              }
              @if (metadata().length) {
                <div>
                  <dt>Metadata</dt>
                  <dd class="meta">
                    @for (entry of metadata(); track entry[0]) {
                      <span><span class="muted">{{ entry[0] }}</span> {{ entry[1] }}</span>
                    }
                  </dd>
                </div>
              }
              @if (m.size) {
                <div>
                  <dt>Tamaño</dt>
                  <dd>{{ size(m.size) }}</dd>
                </div>
              }
            </dl>
          </section>
          </aside>
        </div>
      } @else {
        <div class="card card-pad stack">
          <div class="skeleton"></div>
          <div class="skeleton"></div>
        </div>
      }
    </div>
  `,
})
export class MessageDetailPage {
  readonly id = input.required<string>();
  /** Query param `?tab=`; the timeline when absent. */
  readonly tab = input<string>();
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly message = signal<MessageDetail | null>(null);
  protected readonly missing = signal(false);
  /** Loaded reports by event id; '' while loading. */
  protected readonly reports = signal<Record<string, string>>({});
  protected readonly reportOf = reportOf;
  protected readonly look = lookOf;
  protected readonly detail = detailOf;
  protected readonly scenario = scenarioLabel;
  protected readonly full = fullDate;
  protected readonly ago = (value: string) => timeAgo(value);

  protected readonly tracks = computed<Track[]>(() => {
    const m = this.message();
    if (!m) return [];
    return m.recipients.map((recipient) => ({
      recipient,
      events: m.events.filter((e) => e.recipient === recipient.address),
    }));
  });

  protected readonly metadata = computed(() => Object.entries(this.message()?.metadata ?? {}));
  protected readonly content = signal<MessageContent | null>(null);
  protected readonly contentError = signal('');
  protected readonly size = fileSize;

  protected readonly tabs = computed(() => {
    const tabs: Array<{ id: Tab; label: string }> = [{ id: 'events', label: 'Eventos' }];
    if (this.message()?.size) {
      tabs.push(
        { id: 'preview', label: 'Vista previa' },
        { id: 'text', label: 'Texto' },
        { id: 'html', label: 'HTML' },
        { id: 'headers', label: 'Cabeceras' },
      );
    }
    return tabs;
  });
  protected readonly current = computed<Tab>(() => {
    const wanted = this.tab();
    return this.tabs().some((t) => t.id === wanted) ? (wanted as Tab) : 'events';
  });
  /** Attachments shown as files; inline images are part of the preview. */
  protected readonly files = computed(() => (this.content()?.attachments ?? []).filter((a) => !a.inline));

  constructor() {
    // The captured content is loaded once, as soon as the message says there is one.
    effect(() => {
      if (this.message()?.size && untracked(() => !this.content() && !this.contentError())) void this.loadContent();
    });
  }

  ngOnInit(): void {
    void this.load();
  }

  private async loadContent(): Promise<void> {
    try {
      this.content.set(await this.api.content(this.id()));
    } catch (error) {
      this.contentError.set(error instanceof Error ? error.message : String(error));
    }
  }

  protected async downloadRaw(id: string): Promise<void> {
    try {
      await this.api.download(`/v1/messages/${encodeURIComponent(id)}/raw`, `${id}.eml`);
    } catch (error) {
      this.toasts.error(error);
    }
  }

  protected async downloadAttachment(id: string, index: number, filename: string): Promise<void> {
    try {
      await this.api.download(`/v1/messages/${encodeURIComponent(id)}/attachments/${index}`, filename);
    } catch (error) {
      this.toasts.error(error);
    }
  }

  protected async load(): Promise<void> {
    try {
      this.message.set(await this.api.message(this.id()));
    } catch (error) {
      if ((error as { status?: number }).status === 404) this.missing.set(true);
      else this.toasts.error(error);
    }
  }

  protected icon(tone: Tone): 'ok' | 'wait' | 'bad' {
    if (tone === 'good' || tone === 'info' || tone === 'neutral') return 'ok';
    if (tone === 'warning') return 'wait';
    return 'bad';
  }

  protected async toggleReport(event: SimEvent): Promise<void> {
    if (this.reports()[event.id] !== undefined) {
      this.reports.update(({ [event.id]: _removed, ...rest }) => rest);
      return;
    }
    this.reports.update((r) => ({ ...r, [event.id]: '' }));
    try {
      const raw = await this.api.report(this.id(), event.id);
      this.reports.update((r) => ({ ...r, [event.id]: raw }));
    } catch (error) {
      this.reports.update(({ [event.id]: _removed, ...rest }) => rest);
      this.toasts.error(error);
    }
  }
}
