import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucidePencil, LucideSearch } from '@lucide/angular';
import { Api } from '../core/api';
import { formatNumber } from '../core/format';
import type { PlanLimits, PlanRow } from '../core/types';
import { Modal, Toasts } from '../ui/ui';

const FIELDS: Array<{ key: keyof PlanLimits; label: string; hint: string }> = [
  { key: 'monthlyMessages', label: 'Mensajes simulados al mes', hint: '0 = sin límite' },
  { key: 'liveMonthlyMessages', label: 'Envíos reales al mes', hint: '0 = sin límite' },
  { key: 'messagesPerMinute', label: 'Envíos por minuto', hint: '0 = sin límite' },
  { key: 'retentionDays', label: 'Días que se guardan los mensajes', hint: '0 = siempre' },
];

/** Platform admins: each project's usage and plan; a plan's limits replace the platform's. */
@Component({
  selector: 'app-admin-plans',
  imports: [FormsModule, Modal, LucidePencil, LucideSearch],
  template: `
    <section class="card">
      <header class="card-head">
        <div>
          <h2>Proyectos y planes</h2>
          <p class="muted small">
            Cada proyecto usa los límites de la plataforma salvo los que le pongas aquí. Por defecto:
            @if (defaults(); as d) {
              {{ limit(d.monthlyMessages) }} simulados y {{ limit(d.liveMonthlyMessages) }} reales al mes, {{ limit(d.messagesPerMinute) }} por minuto,
              {{ d.retentionDays ? d.retentionDays + ' días' : 'siempre' }}.
            }
          </p>
        </div>
      </header>
      <form class="card-body row" (ngSubmit)="search()">
        <input class="input" name="q" [(ngModel)]="q" placeholder="Nombre, id o email del dueño" aria-label="Buscar proyectos" />
        <button type="submit" class="btn"><svg lucideSearch [size]="14"></svg>Buscar</button>
      </form>
      @if (rows(); as list) {
        <div class="table-wrap">
          <table class="table">
            <thead>
              <tr>
                <th>Proyecto</th>
                <th class="num">Simulados (mes)</th>
                <th class="num">Reales (mes)</th>
                <th>Plan</th>
                <th><span class="sr-only">Acciones</span></th>
              </tr>
            </thead>
            <tbody>
              @for (r of list; track r.project.id) {
                <tr>
                  <td class="cell-main">
                    {{ r.project.name }}
                    <div class="muted small">{{ r.ownerEmail ?? 'sin dueño' }}</div>
                  </td>
                  <td class="num">{{ format(r.usage.messages) }} / {{ limit(r.effective.monthlyMessages) }}</td>
                  <td class="num">{{ format(r.usage.live) }} / {{ limit(r.effective.liveMonthlyMessages) }}</td>
                  <td class="small">
                    @if (custom(r)) {
                      <span class="chip">Propio</span>
                    } @else {
                      <span class="muted">Por defecto</span>
                    }
                  </td>
                  <td>
                    <button type="button" class="icon-button" (click)="edit(r)" [attr.aria-label]="'Editar el plan de ' + r.project.name" title="Editar el plan">
                      <svg lucidePencil [size]="15"></svg>
                    </button>
                  </td>
                </tr>
              } @empty {
                <tr><td colspan="5" class="muted">Ningún proyecto coincide.</td></tr>
              }
            </tbody>
          </table>
        </div>
      } @else {
        <div class="card-body stack"><div class="skeleton"></div></div>
      }
    </section>

    <app-modal [heading]="'Plan de «' + (editing()?.project?.name ?? '') + '»'" [open]="!!editing()" (closed)="editing.set(null)">
      <form (ngSubmit)="save()">
        <p class="text-2 modal-lede">Deja un campo vacío para usar el valor de la plataforma.</p>
        @for (f of fields; track f.key) {
          <div class="field">
            <label [for]="'plan-' + f.key">{{ f.label }}</label>
            <input
              class="input"
              type="number"
              min="0"
              step="1"
              [id]="'plan-' + f.key"
              [name]="f.key"
              [(ngModel)]="draft[f.key]"
              [placeholder]="placeholder(f.key)"
            />
            <span class="hint">{{ f.hint }}</span>
          </div>
        }
        <div class="modal-actions">
          <button type="button" class="btn" (click)="editing.set(null)">Cancelar</button>
          <button type="submit" class="btn btn-primary" [disabled]="busy()">Guardar</button>
        </div>
      </form>
    </app-modal>
  `,
})
export class AdminPlans {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly rows = signal<PlanRow[] | null>(null);
  protected readonly defaults = signal<Required<PlanLimits> | null>(null);
  protected readonly editing = signal<PlanRow | null>(null);
  protected readonly busy = signal(false);
  protected readonly fields = FIELDS;
  protected readonly format = formatNumber;
  protected q = '';
  protected draft: Partial<Record<keyof PlanLimits, number | null>> = {};

  constructor() {
    void this.search();
  }

  protected limit(value: number): string {
    return value ? formatNumber(value) : '∞';
  }

  protected custom(r: PlanRow): boolean {
    return Object.keys(r.plan).length > 0;
  }

  protected placeholder(key: keyof PlanLimits): string {
    const value = this.defaults()?.[key];
    return value === undefined ? '' : `Por defecto: ${value}`;
  }

  protected async search(): Promise<void> {
    try {
      const { defaults, data } = await this.api.plans(this.q.trim());
      this.defaults.set(defaults);
      this.rows.set(data);
    } catch (error) {
      this.rows.set([]);
      this.toasts.error(error);
    }
  }

  protected edit(r: PlanRow): void {
    this.draft = Object.fromEntries(FIELDS.map((f) => [f.key, r.plan[f.key] ?? null]));
    this.editing.set(r);
  }

  protected async save(): Promise<void> {
    const row = this.editing();
    if (!row || this.busy()) return;
    this.busy.set(true);
    try {
      // An empty number input gives null: back to the platform's value.
      const body = Object.fromEntries(FIELDS.map((f) => [f.key, this.draft[f.key] === undefined || this.draft[f.key] === null ? null : Number(this.draft[f.key])]));
      const updated = await this.api.updatePlan(row.project.id, body);
      this.rows.update((list) => list?.map((r) => (r.project.id === updated.project.id ? updated : r)) ?? null);
      this.editing.set(null);
      this.toasts.show(`Plan de «${updated.project.name}» guardado`);
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}
