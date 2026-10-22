import { Component, DestroyRef, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideInbox, LucideRefreshCw, LucideSearch } from '@lucide/angular';
import { Api } from '../core/api';
import { STATUS_FILTERS } from '../core/events';
import type { SimMessage } from '../core/types';
import { MessageTable } from '../ui/message-table';
import { EmptyState, Toasts } from '../ui/ui';

const PAGE = 50;

@Component({
  selector: 'app-messages',
  imports: [FormsModule, RouterLink, MessageTable, EmptyState, LucideInbox, LucideRefreshCw, LucideSearch],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Mensajes</h1>
          <p>Todo lo que el simulador ha recibido en este proyecto, con su último evento.</p>
        </div>
        <button type="button" class="btn" (click)="reload()" [disabled]="loading()">
          <svg lucideRefreshCw [size]="14"></svg>Actualizar
        </button>
      </header>

      <section class="card">
        <div class="toolbar">
          <label class="input-icon">
            <svg lucideSearch [size]="15"></svg>
            <span class="sr-only">Buscar</span>
            <input
              class="input"
              type="search"
              placeholder="Buscar por destinatario, asunto o id"
              [ngModel]="query()"
              (ngModelChange)="search($event)"
            />
          </label>
          <label>
            <span class="sr-only">Canal</span>
            <select class="select" [ngModel]="channel()" (ngModelChange)="filterChannel($event)">
              <option value="">Email y SMS</option>
              <option value="email">Solo email</option>
              <option value="sms">Solo SMS</option>
            </select>
          </label>
          <label>
            <span class="sr-only">Estado</span>
            <select class="select" [ngModel]="status()" (ngModelChange)="filter($event)">
              @for (option of filters; track option.value) {
                <option [value]="option.value">{{ option.label }}</option>
              }
            </select>
          </label>
        </div>

        @if (messages() === null) {
          <div class="card-body stack">
            <div class="skeleton"></div>
            <div class="skeleton"></div>
            <div class="skeleton"></div>
          </div>
        } @else if (messages()!.length === 0) {
          @if (query() || status() || channel()) {
            <app-empty heading="Sin resultados">
              <svg icon lucideSearch [size]="20"></svg>
              Ningún mensaje coincide con la búsqueda o el filtro.
            </app-empty>
          } @else {
            <app-empty heading="Todavía no hay mensajes">
              <svg icon lucideInbox [size]="20"></svg>
              Envía uno desde <a routerLink="/scenarios">Escenarios</a>, por la API o por SMTP, y aparecerá aquí.
            </app-empty>
          }
        } @else {
          <app-message-table [messages]="messages()!" />
          @if (more()) {
            <footer class="card-foot">
              <span class="muted small">{{ messages()!.length }} mensajes</span>
              <button type="button" class="btn btn-sm" (click)="loadMore()" [disabled]="loading()">Cargar más</button>
            </footer>
          }
        }
      </section>
    </div>
  `,
})
export class MessagesPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly filters = STATUS_FILTERS;
  protected readonly query = signal('');
  protected readonly status = signal('');
  protected readonly channel = signal('');
  protected readonly messages = signal<SimMessage[] | null>(null);
  protected readonly loading = signal(false);
  protected readonly more = signal(false);
  private timer: ReturnType<typeof setTimeout> | undefined;
  private generation = 0;

  constructor() {
    inject(DestroyRef).onDestroy(() => clearTimeout(this.timer));
    void this.load(false);
  }

  protected search(value: string): void {
    this.query.set(value);
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.load(false), 250);
  }

  protected filter(value: string): void {
    this.status.set(value);
    void this.load(false);
  }

  protected filterChannel(value: string): void {
    this.channel.set(value);
    void this.load(false);
  }

  protected reload(): void {
    void this.load(false);
  }

  protected loadMore(): void {
    void this.load(true);
  }

  private async load(append: boolean): Promise<void> {
    const generation = ++this.generation;
    const current = append ? (this.messages() ?? []) : [];
    this.loading.set(true);
    try {
      const page = await this.api.messages({
        limit: PAGE,
        before: append ? current.at(-1)?.createdAt : undefined,
        q: this.query().trim(),
        status: this.status(),
        channel: this.channel(),
      });
      if (generation !== this.generation) return;
      this.messages.set([...current, ...page]);
      this.more.set(page.length === PAGE);
    } catch (error) {
      if (generation !== this.generation) return;
      this.messages.update((list) => list ?? []);
      this.toasts.error(error);
    } finally {
      if (generation === this.generation) this.loading.set(false);
    }
  }
}
