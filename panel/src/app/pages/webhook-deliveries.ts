import { Component, inject, input, signal } from '@angular/core';
import { LucideRefreshCw, LucideRotateCcw, LucideWebhook } from '@lucide/angular';
import { Api } from '../core/api';
import { lookOf, type Tone } from '../core/events';
import { formatNumber, fullDate, timeAgo } from '../core/format';
import type { WebhookDelivery, WebhookDeliveryDetail, WebhookStats } from '../core/types';
import { Badge, EmptyState, Modal, Toasts } from '../ui/ui';

const TRIGGERS: Record<WebhookDelivery['trigger'], string> = { auto: 'Automático', redeliver: 'Reenvío', test: 'Prueba' };

/** Every POST of an event to the project's webhook: what it answered, retries, and redelivery. */
@Component({
  selector: 'app-webhook-deliveries',
  imports: [Badge, EmptyState, Modal, LucideRefreshCw, LucideRotateCcw, LucideWebhook],
  template: `
    <section class="card">
      <header class="card-head">
        <div>
          <h2>Entregas</h2>
          <p class="muted small">
            @if (stats(); as s) {
              Últimas 24 h: {{ format(s.ok) }} {{ s.ok === 1 ? 'aceptada' : 'aceptadas' }} ·
              <span [class.danger-text]="s.failed > 0">{{ format(s.failed) }} {{ s.failed === 1 ? 'fallida' : 'fallidas' }}</span>
              @if (s.latest) {
                · último intento {{ ago(s.latest.createdAt) }}
              }
            } @else {
              Cada intento de enviar un evento a tu URL, con lo que respondió.
            }
          </p>
        </div>
        <div class="row">
          <div class="segmented" role="group" aria-label="Filtro">
            <button type="button" [attr.aria-pressed]="!failedOnly()" (click)="filter(false)">Todas</button>
            <button type="button" [attr.aria-pressed]="failedOnly()" (click)="filter(true)">Fallidas</button>
          </div>
          <button type="button" class="icon-button" (click)="reload()" aria-label="Actualizar" title="Actualizar"><svg lucideRefreshCw [size]="15"></svg></button>
        </div>
      </header>

      @if (rows() === null) {
        <div class="card-body stack"><div class="skeleton"></div><div class="skeleton"></div></div>
      } @else if (rows()!.length === 0) {
        <app-empty [heading]="failedOnly() ? 'Sin fallos' : 'Sin entregas'">
          <svg icon lucideWebhook [size]="20"></svg>
          @if (failedOnly()) {
            Tu endpoint ha aceptado todos los eventos.
          } @else if (hasUrl()) {
            Aún no se ha enviado ningún evento. Prueba con «Enviar evento de prueba».
          } @else {
            Configura la URL del webhook para empezar a recibir los eventos.
          }
        </app-empty>
      } @else {
        <div class="table-wrap">
          <table class="table deliveries">
            <thead>
              <tr>
                <th>Cuándo</th>
                <th>Evento</th>
                <th>Respuesta</th>
                <th>Intento</th>
                <th class="num">Tiempo</th>
              </tr>
            </thead>
            <tbody>
              @for (d of rows(); track d.id) {
                <tr class="clickable" (click)="open(d)" tabindex="0" (keydown.enter)="open(d)">
                  <td class="nowrap" [title]="full(d.createdAt)">{{ ago(d.createdAt) }}</td>
                  <td>
                    <app-badge [tone]="lookOf(d).tone">{{ lookOf(d).label }}</app-badge>
                    <div class="muted small truncate">{{ d.recipient }}</div>
                  </td>
                  <td><app-badge [tone]="answerTone(d)">{{ answer(d) }}</app-badge></td>
                  <td class="nowrap">
                    @if (d.trigger === 'auto') {
                      {{ d.attempt }} / {{ d.maxAttempts }}
                      @if (d.willRetry) {
                        <span class="muted small">· reintentará</span>
                      }
                    } @else {
                      <span class="chip">{{ trigger(d) }}</span>
                    }
                  </td>
                  <td class="num nowrap">{{ format(d.durationMs) }} ms</td>
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
      }
    </section>

    <app-modal heading="Entrega del webhook" [open]="!!selected()" (closed)="selected.set(null)">
      @if (selected(); as d) {
        <dl class="props delivery-props">
          <div><dt>Evento</dt><dd><app-badge [tone]="lookOf(d).tone">{{ lookOf(d).label }}</app-badge> <code>{{ d.eventId }}</code></dd></div>
          <div><dt>URL</dt><dd><code>{{ d.url }}</code></dd></div>
          <div><dt>Respuesta</dt><dd><app-badge [tone]="answerTone(d)">{{ answer(d) }}</app-badge> en {{ format(d.durationMs) }} ms</dd></div>
          <div><dt>Cuándo</dt><dd>{{ full(d.createdAt) }} · {{ trigger(d) }}@if (d.trigger === 'auto') { (intento {{ d.attempt }} de {{ d.maxAttempts }}) }</dd></div>
        </dl>
        @if (d.responseBody) {
          <p class="label">Cuerpo de la respuesta</p>
          <pre class="delivery-pre">{{ d.responseBody }}</pre>
        }
        @if (detail(); as full) {
          <p class="label">Evento enviado</p>
          @if (full.event) {
            <pre class="delivery-pre">{{ json(full.event) }}</pre>
          } @else {
            <p class="muted small">{{ d.trigger === 'test' ? 'Evento de prueba: no se guarda.' : 'El evento ya no existe: se borró con su mensaje al pasar el periodo de retención.' }}</p>
          }
        }
        <div class="modal-actions">
          <button type="button" class="btn" (click)="selected.set(null)">Cerrar</button>
          @if (d.trigger !== 'test') {
            <button type="button" class="btn btn-primary" (click)="redeliver(d)" [disabled]="busy() || !detail()?.event"><svg lucideRotateCcw [size]="14"></svg>Reenviar</button>
          }
        </div>
      }
    </app-modal>
  `,
})
export class WebhookDeliveries {
  /** Whether the project has a webhook URL, for the empty state. */
  readonly hasUrl = input(false);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly rows = signal<WebhookDelivery[] | null>(null);
  protected readonly stats = signal<WebhookStats | null>(null);
  protected readonly failedOnly = signal(false);
  protected readonly more = signal(false);
  protected readonly busy = signal(false);
  protected readonly selected = signal<WebhookDelivery | null>(null);
  protected readonly detail = signal<WebhookDeliveryDetail | null>(null);
  protected readonly format = formatNumber;
  protected readonly ago = (value: string) => timeAgo(value);
  protected readonly full = (value: string) => fullDate(value);
  protected readonly lookOf = (d: WebhookDelivery) => lookOf({ type: d.eventType });
  private static readonly PAGE = 50;

  constructor() {
    void this.reload();
  }

  /** Called by the page after it sends a test event. */
  async reload(): Promise<void> {
    try {
      const [rows, stats] = await Promise.all([
        this.api.webhookDeliveries({ limit: WebhookDeliveries.PAGE, ...(this.failedOnly() && { status: 'failed' }) }),
        this.api.webhookStats(),
      ]);
      this.rows.set(rows);
      this.more.set(rows.length === WebhookDeliveries.PAGE);
      this.stats.set(stats);
    } catch (error) {
      this.rows.update((r) => r ?? []);
      this.toasts.error(error);
    }
  }

  protected filter(failed: boolean): void {
    if (failed === this.failedOnly()) return;
    this.failedOnly.set(failed);
    this.rows.set(null);
    void this.reload();
  }

  protected async loadMore(): Promise<void> {
    const last = this.rows()?.at(-1);
    if (!last || this.busy()) return;
    this.busy.set(true);
    try {
      const next = await this.api.webhookDeliveries({
        limit: WebhookDeliveries.PAGE,
        before: last.createdAt,
        ...(this.failedOnly() && { status: 'failed' }),
      });
      this.rows.update((rows) => [...(rows ?? []), ...next]);
      this.more.set(next.length === WebhookDeliveries.PAGE);
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected async open(d: WebhookDelivery): Promise<void> {
    this.selected.set(d);
    this.detail.set(null);
    try {
      this.detail.set(await this.api.webhookDelivery(d.id));
    } catch (error) {
      this.toasts.error(error);
    }
  }

  protected async redeliver(d: WebhookDelivery): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const attempt = await this.api.redeliverWebhook(d.id);
      if (attempt.ok) this.toasts.show(`Reenviado: tu endpoint respondió ${attempt.statusCode}`);
      else this.toasts.error(new Error(`El reenvío falló: ${this.answer(attempt)}`));
      this.selected.set(null);
      await this.reload();
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected answer(d: WebhookDelivery): string {
    return d.statusCode ? `HTTP ${d.statusCode}` : (d.error ?? 'Sin respuesta');
  }

  protected answerTone(d: WebhookDelivery): Tone {
    if (d.ok) return 'good';
    return d.willRetry ? 'warning' : 'critical';
  }

  protected trigger(d: WebhookDelivery): string {
    return TRIGGERS[d.trigger];
  }

  protected json(value: unknown): string {
    return JSON.stringify(value, null, 2);
  }
}
