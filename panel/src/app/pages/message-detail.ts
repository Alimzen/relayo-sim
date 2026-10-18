import { DatePipe, JsonPipe } from '@angular/common';
import { Component, DestroyRef, computed, inject, input, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SimApi, type MessageDetail, type SimEvent } from '../api.service';
import { detailOf, lookOf, reportOf, scenarioLabel } from '../events';

const REFRESH_MS = 2000;

@Component({
  selector: 'app-message-detail',
  imports: [RouterLink, DatePipe, JsonPipe],
  template: `
    <a class="back" routerLink="/messages">← Mensajes</a>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    @if (message(); as m) {
      <header class="page-head">
        <div>
          <h1 class="truncate">{{ m.subject || '(sin asunto)' }}</h1>
          <p class="muted">
            De <strong>{{ m.from }}</strong> · {{ m.createdAt | date: 'dd/MM/yyyy HH:mm:ss' }} · vía {{ m.via === 'smtp' ? 'SMTP' : 'API' }}
          </p>
        </div>
      </header>

      <dl class="facts card">
        <div><dt>Id en el simulador</dt><dd><code>{{ m.id }}</code></dd></div>
        <div><dt>Id de Relayo</dt><dd><code>{{ m.relayoMessageId ?? '—' }}</code></dd></div>
        @if (m.metadata) {
          <div><dt>Metadata</dt><dd><code>{{ m.metadata | json }}</code></dd></div>
        }
      </dl>

      @for (lane of lanes(); track lane.address) {
        <section class="card lane">
          <header class="lane-head">
            <h2>{{ lane.address }}</h2>
            <code class="tag">{{ lane.scenario }}</code>
          </header>
          @if (lane.events.length === 0) {
            <p class="muted">Sin eventos todavía.</p>
          } @else {
            <ol class="timeline">
              @for (event of lane.events; track event.id) {
                <li [class]="'tone-' + look(event).tone">
                  <span class="dot" aria-hidden="true"></span>
                  <div class="entry">
                    <div class="entry-head">
                      <span class="badge" [class]="'badge tone-' + look(event).tone">{{ look(event).label }}</span>
                      <time [attr.datetime]="event.timestamp">{{ event.timestamp | date: 'HH:mm:ss.SSS' }}</time>
                    </div>
                    @if (detail(event); as text) {
                      <p class="entry-detail">{{ text }}</p>
                    }
                    @if (event.diagnostic) {
                      <p class="diagnostic"><code>{{ event.diagnostic }}</code></p>
                    }
                    <div class="entry-actions">
                      <details>
                        <summary>Evento JSON</summary>
                        <pre>{{ event | json }}</pre>
                      </details>
                      @if (reportOf(event); as kind) {
                        <button type="button" class="ghost small" (click)="toggleReport(event.id)">
                          {{ openReport() === event.id ? 'Ocultar ' + kind : 'Ver ' + kind }}
                        </button>
                      }
                    </div>
                    @if (openReport() === event.id) {
                      @if (reportText(); as text) {
                        <pre class="report" [attr.aria-label]="reportOf(event) + ' del evento'">{{ text }}</pre>
                      } @else {
                        <p class="muted">Cargando…</p>
                      }
                    }
                  </div>
                </li>
              }
            </ol>
          }
        </section>
      }
    } @else if (!error()) {
      <p class="muted">Cargando…</p>
    }
  `,
})
export class MessageDetailPage {
  private readonly api = inject(SimApi);
  readonly id = input.required<string>();
  protected readonly message = signal<MessageDetail | null>(null);
  protected readonly error = signal<string | null>(null);

  protected readonly lanes = computed(() => {
    const m = this.message();
    if (!m) return [];
    return m.recipients.map((r) => ({
      address: r.address,
      scenario: scenarioLabel(r),
      events: m.events.filter((e) => e.recipient === r.address),
    }));
  });

  protected readonly look = lookOf;
  protected readonly detail = detailOf;
  protected readonly reportOf = reportOf;
  protected readonly openReport = signal<string | null>(null);
  protected readonly reportText = signal<string | null>(null);

  protected async toggleReport(eventId: string): Promise<void> {
    if (this.openReport() === eventId) {
      this.openReport.set(null);
      return;
    }
    this.openReport.set(eventId);
    this.reportText.set(null);
    try {
      this.reportText.set(await this.api.report(this.id(), eventId));
    } catch (error) {
      this.reportText.set(`No se pudo cargar el informe: ${(error as Error).message}`);
    }
  }

  constructor() {
    queueMicrotask(() => void this.load());
    const timer = setInterval(() => void this.load(), REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  private async load(): Promise<void> {
    try {
      this.message.set(await this.api.message(this.id()));
      this.error.set(null);
    } catch (error) {
      this.error.set((error as Error).message);
    }
  }
}

export type { SimEvent };
