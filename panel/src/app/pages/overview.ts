import { Component, computed, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideArrowRight, LucideInbox } from '@lucide/angular';
import { Api } from '../core/api';
import { formatNumber, percent } from '../core/format';
import { Session } from '../core/session';
import type { ProjectStats, SimMessage } from '../core/types';
import { DailyChart } from '../ui/daily-chart';
import { MessageTable } from '../ui/message-table';
import { EmptyState, Toasts } from '../ui/ui';

@Component({
  selector: 'app-overview',
  imports: [RouterLink, DailyChart, MessageTable, EmptyState, LucideArrowRight, LucideInbox],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Resumen</h1>
          <p>Lo que ha pasado con los envíos de {{ session.project()?.name }}.</p>
        </div>
        <div class="segmented" role="group" aria-label="Periodo">
          @for (option of ranges; track option) {
            <button type="button" [attr.aria-pressed]="days() === option" (click)="setDays(option)">{{ option }} días</button>
          }
        </div>
      </header>

      <div class="stack">
        <section class="stats" aria-label="Indicadores">
          <div class="card stat">
            <p class="stat-label">Mensajes</p>
            <p class="stat-value">{{ stats() ? format(stats()!.messages) : '—' }}</p>
            <p class="stat-sub">en los últimos {{ days() }} días</p>
          </div>
          <div class="card stat">
            <p class="stat-label">Tasa de entrega</p>
            <p class="stat-value">{{ deliveryRate() }}</p>
            <p class="stat-sub">{{ count('delivered') }} entregados</p>
          </div>
          <div class="card stat">
            <p class="stat-label">Rebotes</p>
            <p class="stat-value">{{ count('bounced') }}</p>
            <p class="stat-sub">
              {{ bounces('hard') }} duros · {{ bounces('soft') }} suaves · {{ bounces('block') }} bloqueos
            </p>
          </div>
          <div class="card stat">
            <p class="stat-label">Quejas</p>
            <p class="stat-value">{{ count('complained') }}</p>
            <p class="stat-sub">{{ count('unsubscribed') }} bajas</p>
          </div>
        </section>

        <section class="card card-pad">
          @if (stats(); as s) {
            <app-daily-chart [days]="s.daily" />
          } @else {
            <div class="chart-placeholder"><div class="skeleton"></div></div>
          }
        </section>

        <section class="card">
          <header class="card-head">
            <h2>Mensajes recientes</h2>
            <a class="btn btn-sm btn-ghost" routerLink="/messages">Ver todos <svg lucideArrowRight [size]="14"></svg></a>
          </header>
          @if (recent() === null) {
            <div class="card-body"><div class="skeleton"></div></div>
          } @else if (recent()!.length === 0) {
            <app-empty heading="Todavía no hay mensajes">
              <svg icon lucideInbox [size]="20"></svg>
              Envía uno desde <a routerLink="/scenarios">Escenarios</a>, por la API o por SMTP, y aparecerá aquí.
            </app-empty>
          } @else {
            <app-message-table [messages]="recent()!" compact />
          }
        </section>
      </div>
    </div>
  `,
})
export class OverviewPage {
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly ranges = [7, 30];
  protected readonly days = signal(7);
  protected readonly stats = signal<ProjectStats | null>(null);
  protected readonly recent = signal<SimMessage[] | null>(null);
  protected readonly format = formatNumber;

  protected readonly deliveryRate = computed(() => {
    const s = this.stats();
    if (!s) return '—';
    const delivered = s.events.delivered ?? 0;
    const failed = (s.events.bounced ?? 0) + (s.events.rejected ?? 0);
    return percent(delivered, delivered + failed);
  });

  constructor() {
    void this.loadStats();
    this.api.messages({ limit: 8 }).then(
      (list) => this.recent.set(list),
      (error) => {
        this.recent.set([]);
        this.toasts.error(error);
      },
    );
  }

  protected setDays(days: number): void {
    if (days === this.days()) return;
    this.days.set(days);
    void this.loadStats();
  }

  protected count(type: keyof ProjectStats['events']): string {
    const s = this.stats();
    return s ? formatNumber(s.events[type] ?? 0) : '—';
  }

  protected bounces(type: keyof ProjectStats['bounces']): string {
    const s = this.stats();
    return s ? formatNumber(s.bounces[type]) : '—';
  }

  private async loadStats(): Promise<void> {
    const days = this.days();
    try {
      const stats = await this.api.stats(days);
      if (days === this.days()) this.stats.set(stats);
    } catch (error) {
      this.toasts.error(error);
    }
  }
}
