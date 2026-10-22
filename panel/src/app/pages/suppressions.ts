import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucidePlus, LucideShieldBan, LucideTrash } from '@lucide/angular';
import { Api } from '../core/api';
import { fullDate, timeAgo } from '../core/format';
import type { Suppression } from '../core/types';
import { Badge, EmptyState, Toasts } from '../ui/ui';

const REASONS: Record<Suppression['reason'], { label: string; tone: 'critical' | 'serious' | 'warning' | 'neutral' }> = {
  hard_bounce: { label: 'Rebote duro', tone: 'critical' },
  complaint: { label: 'Queja', tone: 'serious' },
  unsubscribe: { label: 'Baja', tone: 'warning' },
  manual: { label: 'Manual', tone: 'neutral' },
};

@Component({
  selector: 'app-suppressions',
  imports: [FormsModule, Badge, EmptyState, LucidePlus, LucideShieldBan, LucideTrash],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Supresiones</h1>
          <p>Direcciones a las que el modo en vivo no vuelve a enviar: se añaden solas con cada rebote duro, queja o baja.</p>
        </div>
      </header>

      <section class="card">
        <form class="toolbar" (ngSubmit)="add()">
          <input class="input" name="address" [(ngModel)]="address" placeholder="direccion@ejemplo.com" aria-label="Dirección" />
          <button type="submit" class="btn" [disabled]="!address.trim()"><svg lucidePlus [size]="14"></svg>Suprimir</button>
        </form>
        @if (list() === null) {
          <div class="card-body stack"><div class="skeleton"></div><div class="skeleton"></div></div>
        } @else if (list()!.length === 0) {
          <app-empty heading="Ninguna dirección suprimida">
            <svg icon lucideShieldBan [size]="20"></svg>
            Cuando un envío en vivo rebote de forma permanente, o alguien se queje o se dé de baja, su dirección aparecerá aquí.
          </app-empty>
        } @else {
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Dirección</th>
                  <th>Motivo</th>
                  <th class="hide-sm">Desde</th>
                  <th><span class="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                @for (s of list(); track s.address) {
                  <tr>
                    <td class="cell-main">{{ s.address }}</td>
                    <td><app-badge [tone]="reason(s).tone">{{ reason(s).label }}</app-badge></td>
                    <td class="hide-sm muted nowrap" [title]="full(s.createdAt)">{{ ago(s.createdAt) }}</td>
                    <td class="cell-actions">
                      <button type="button" class="icon-button" (click)="remove(s)" [attr.aria-label]="'Quitar ' + s.address" title="Quitar">
                        <svg lucideTrash [size]="15"></svg>
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
    </div>
  `,
})
export class SuppressionsPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly list = signal<Suppression[] | null>(null);
  protected readonly full = fullDate;
  protected readonly ago = (value: string) => timeAgo(value);
  protected address = '';

  constructor() {
    void this.load();
  }

  protected reason(s: Suppression) {
    return REASONS[s.reason] ?? REASONS.manual;
  }

  protected async add(): Promise<void> {
    try {
      await this.api.addSuppression(this.address.trim());
      this.address = '';
      await this.load();
    } catch (error) {
      this.toasts.error(error);
    }
  }

  protected async remove(s: Suppression): Promise<void> {
    try {
      await this.api.removeSuppression(s.address);
      this.toasts.show(`${s.address} vuelve a recibir envíos`);
      await this.load();
    } catch (error) {
      this.toasts.error(error);
    }
  }

  private async load(): Promise<void> {
    try {
      this.list.set(await this.api.suppressions());
    } catch (error) {
      this.list.update((l) => l ?? []);
      this.toasts.error(error);
    }
  }
}
