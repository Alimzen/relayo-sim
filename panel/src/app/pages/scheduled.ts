import { Component, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { LucideClock, LucideRefreshCw } from '@lucide/angular';
import { Api } from '../core/api';
import type { Tone } from '../core/events';
import { fullDate, timeAgo } from '../core/format';
import type { ScheduledSend } from '../core/types';
import { Badge, EmptyState, Modal, Toasts } from '../ui/ui';

const STATUS: Record<ScheduledSend['status'], { label: string; tone: Tone }> = {
  pending: { label: 'Pendiente', tone: 'info' },
  sending: { label: 'Enviando', tone: 'warning' },
  sent: { label: 'Enviado', tone: 'good' },
  failed: { label: 'Falló', tone: 'critical' },
  canceled: { label: 'Cancelado', tone: 'neutral' },
};

/** Sends waiting for their time (sendAt), and what happened to the earlier ones. */
@Component({
  selector: 'app-scheduled',
  imports: [RouterLink, Badge, EmptyState, Modal, LucideClock, LucideRefreshCw],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Programados</h1>
          <p>
            Envíos con <code>sendAt</code>: salen a su hora (con un margen de unos segundos) y puedes cancelarlos mientras
            estén pendientes. Prográmalos desde <a routerLink="/send">Enviar</a> o por la API.
          </p>
        </div>
        <div class="row">
          <div class="segmented" role="group" aria-label="Estado">
            <button type="button" [attr.aria-pressed]="filter() === 'pending'" (click)="show('pending')">Pendientes</button>
            <button type="button" [attr.aria-pressed]="filter() === ''" (click)="show('')">Todos</button>
          </div>
          <button type="button" class="icon-button" (click)="load()" aria-label="Actualizar" title="Actualizar"><svg lucideRefreshCw [size]="15"></svg></button>
        </div>
      </header>

      <section class="card">
        @if (rows() === null) {
          <div class="card-body stack"><div class="skeleton"></div><div class="skeleton"></div></div>
        } @else if (rows()!.length === 0) {
          <app-empty [heading]="filter() === 'pending' ? 'Nada pendiente' : 'Sin envíos programados'">
            <svg icon lucideClock [size]="20"></svg>
            Añade <code>sendAt</code> a un envío, o usa «Programar» en Enviar.
          </app-empty>
        } @else {
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr><th>Cuándo</th><th>Mensaje</th><th>Para</th><th>Estado</th><th><span class="sr-only">Acciones</span></th></tr>
              </thead>
              <tbody>
                @for (s of rows(); track s.id) {
                  <tr>
                    <td class="nowrap" [title]="full(s.sendAt)">
                      {{ full(s.sendAt) }}
                      <div class="muted small">{{ ago(s.sendAt) }}</div>
                    </td>
                    <td class="cell-main">
                      <span class="chip">{{ s.channel === 'email' ? 'Email' : 'SMS' }}</span> {{ s.summary }}
                      @if (s.error) {
                        <div class="small danger-text">{{ s.error }}</div>
                      }
                    </td>
                    <td class="muted small">{{ s.recipients.join(', ') }}</td>
                    <td><app-badge [tone]="status(s).tone">{{ status(s).label }}</app-badge></td>
                    <td>
                      <div class="row row-end">
                        @if (s.status === 'pending') {
                          <button type="button" class="btn btn-sm" (click)="canceling.set(s)">Cancelar</button>
                        }
                        @if (s.messageId) {
                          <a class="btn btn-sm" [routerLink]="['/messages', s.messageId]">Ver mensaje</a>
                        }
                      </div>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    </div>

    <app-modal heading="Cancelar el envío" [open]="!!canceling()" (closed)="canceling.set(null)">
      <p class="text-2">«{{ canceling()?.summary }}» no se enviará. Esto no se puede deshacer.</p>
      <div class="modal-actions">
        <button type="button" class="btn" (click)="canceling.set(null)">Volver</button>
        <button type="button" class="btn btn-danger" (click)="cancel()" [disabled]="busy()">Cancelar el envío</button>
      </div>
    </app-modal>
  `,
})
export class ScheduledPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly rows = signal<ScheduledSend[] | null>(null);
  protected readonly filter = signal<'pending' | ''>('pending');
  protected readonly canceling = signal<ScheduledSend | null>(null);
  protected readonly busy = signal(false);
  protected readonly full = (value: string) => fullDate(value);
  protected readonly ago = (value: string) => timeAgo(value);
  protected readonly status = (s: ScheduledSend) => STATUS[s.status];

  constructor() {
    void this.load();
  }

  protected show(filter: 'pending' | ''): void {
    if (filter === this.filter()) return;
    this.filter.set(filter);
    this.rows.set(null);
    void this.load();
  }

  protected async load(): Promise<void> {
    try {
      this.rows.set(await this.api.scheduled(this.filter() || undefined));
    } catch (error) {
      this.rows.update((r) => r ?? []);
      this.toasts.error(error);
    }
  }

  protected async cancel(): Promise<void> {
    const s = this.canceling();
    if (!s || this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.cancelScheduled(s.id);
      this.canceling.set(null);
      this.toasts.show('Envío cancelado');
      await this.load();
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}
