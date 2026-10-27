import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideRefreshCw, LucideRotateCcw, LucideWebhook } from '@lucide/angular';
import { Api } from '../core/api';
import { lookOf, type Tone } from '../core/events';
import { formatNumber, fullDate, timeAgo } from '../core/format';
import type { WebhookDelivery, WebhookDeliveryDetail, WebhookEndpoint, WebhookStats } from '../core/types';
import { Badge, EmptyState, Modal, Toasts } from '../ui/ui';

const TRIGGERS: Record<WebhookDelivery['trigger'], string> = { auto: 'Automático', redeliver: 'Reenvío', test: 'Prueba' };

/** Every POST of an event to the project's webhook: what it answered, retries, and redelivery. */
@Component({
  selector: 'app-webhook-deliveries',
  imports: [FormsModule, Badge, EmptyState, Modal, LucideRefreshCw, LucideRotateCcw, LucideWebhook],
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
          <button type="button" class="btn btn-sm" (click)="openBulk()"><svg lucideRotateCcw [size]="14"></svg>Reenviar fallidos</button>
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
                    <div class="muted small truncate">
                      {{ d.recipient }}
                      @if (d.endpointId) {
                        · <span [title]="d.url">{{ host(d.url) }}</span>
                      }
                    </div>
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

    <app-modal heading="Reenviar los fallidos" [open]="bulk()" (closed)="bulk.set(false)">
      <form (ngSubmit)="redeliverFailed()">
        <p class="text-2 modal-lede">
          Vuelve a enviar cada evento que no se pudo entregar (falló su último intento y no le quedan reintentos) al endpoint al que
          iba. Hasta 1000 eventos, en segundo plano.
        </p>
        <div class="field">
          <label for="bulk-period">Desde hace</label>
          <select id="bulk-period" class="input" name="period" [(ngModel)]="bulkHours">
            <option [ngValue]="1">1 hora</option>
            <option [ngValue]="24">24 horas</option>
            <option [ngValue]="72">3 días</option>
            <option [ngValue]="168">7 días</option>
          </select>
        </div>
        <div class="field">
          <label for="bulk-endpoint">Endpoint</label>
          <select id="bulk-endpoint" class="input" name="endpoint" [(ngModel)]="bulkEndpoint">
            <option value="">Todos</option>
            <option value="main">URL principal</option>
            @for (e of endpoints(); track e.id) {
              <option [value]="e.id">{{ e.description || host(e.url) }}</option>
            }
          </select>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" (click)="bulk.set(false)">Cancelar</button>
          <button type="submit" class="btn btn-primary" [disabled]="busy()">Reenviar</button>
        </div>
      </form>
    </app-modal>

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
  protected readonly bulk = signal(false);
  protected readonly endpoints = signal<WebhookEndpoint[]>([]);
  protected bulkHours = 24;
  protected bulkEndpoint = '';
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

  protected host(url: string): string {
    try {
      return new URL(url).host;
    } catch {
      return url;
    }
  }

  protected openBulk(): void {
    this.bulk.set(true);
    this.api.webhookEndpoints().then(
      (list) => this.endpoints.set(list),
      () => this.endpoints.set([]),
    );
  }

  protected async redeliverFailed(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const since = new Date(Date.now() - this.bulkHours * 3_600_000).toISOString();
      const { events } = await this.api.redeliverFailedWebhooks({ since, ...(this.bulkEndpoint && { endpoint: this.bulkEndpoint }) });
      this.toasts.show(events ? `Reenviando ${events} ${events === 1 ? 'evento' : 'eventos'}` : 'No hay eventos fallidos en ese periodo');
      this.bulk.set(false);
      if (events) setTimeout(() => void this.reload(), 2000);
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
