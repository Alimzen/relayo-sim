import { Component, effect, inject, signal } from '@angular/core';
import { LucideGauge, LucideTriangleAlert } from '@lucide/angular';
import { Api } from '../core/api';
import { formatNumber } from '../core/format';
import { Session } from '../core/session';
import type { Deliverability, DeliverabilityAlert, DeliverabilityGroup } from '../core/types';
import { Badge, EmptyState, Toasts } from '../ui/ui';

const GROUPS: Array<{ id: DeliverabilityGroup; label: string; column: string }> = [
  { id: 'domain', label: 'Dominio', column: 'Dominio del destinatario' },
  { id: 'template', label: 'Plantilla', column: 'Plantilla' },
  { id: 'tag', label: 'Etiqueta', column: 'Etiqueta' },
];

const PERIODS = [
  { days: 1, label: '24 h' },
  { days: 7, label: '7 días' },
  { days: 30, label: '30 días' },
];

/** How sending is doing, split by recipient domain, template or tag, with the rates that need watching. */
@Component({
  selector: 'app-deliverability',
  imports: [Badge, EmptyState, LucideGauge, LucideTriangleAlert],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Entregabilidad</h1>
          <p>
            Cómo llegan tus envíos {{ live() ? 'reales' : 'simulados' }}, por dominio del destinatario, plantilla o etiqueta. Los rebotes
            se cuentan sobre lo enviado; quejas, aperturas y clics, sobre lo entregado.
          </p>
        </div>
        <div class="segmented" role="group" aria-label="Periodo">
          @for (p of periods; track p.days) {
            <button type="button" [attr.aria-pressed]="days() === p.days" (click)="days.set(p.days)">{{ p.label }}</button>
          }
        </div>
      </header>

      @for (a of result()?.alerts ?? []; track a.kind) {
        <div class="callout" [class.callout-critical]="a.level === 'critical'" role="status">
          <svg lucideTriangleAlert [size]="16"></svg>
          <span>{{ alertText(a) }}</span>
        </div>
      }

      <section class="card">
        <header class="card-head">
          <div class="segmented" role="group" aria-label="Agrupar por">
            @for (g of groups; track g.id) {
              <button type="button" [attr.aria-pressed]="by() === g.id" (click)="by.set(g.id)">{{ g.label }}</button>
            }
          </div>
          @if (result(); as r) {
            <p class="muted small">
              {{ format(r.overall.sent) }} enviados · entregados {{ pct(r.overall.rates.delivery) }} · rebotes {{ pct(r.overall.rates.bounce) }} ·
              quejas {{ pct(r.overall.rates.complaint) }}
            </p>
          }
        </header>
        @if (result(); as r) {
          @if (r.data.length) {
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>{{ column() }}</th>
                    <th class="num">Enviados</th>
                    <th class="num">Entregados</th>
                    <th class="num">Rebotes</th>
                    <th class="num">Quejas</th>
                    <th class="num">Aperturas</th>
                    <th class="num">Clics</th>
                    <th>Estado</th>
                  </tr>
                </thead>
                <tbody>
                  @for (row of r.data; track row.key) {
                    <tr>
                      <td class="cell-main"><span class="truncate">{{ row.key }}</span></td>
                      <td class="num">{{ format(row.sent) }}</td>
                      <td class="num">{{ pct(row.rates.delivery) }}</td>
                      <td class="num" [title]="format(row.bounced) + ' rebotes'">{{ pct(row.rates.bounce) }}</td>
                      <td class="num" [title]="format(row.complained) + ' quejas'">{{ pct(row.rates.complaint) }}</td>
                      <td class="num">{{ pct(row.rates.open) }}</td>
                      <td class="num">{{ pct(row.rates.click) }}</td>
                      <td>
                        @for (a of row.alerts; track a.kind) {
                          <app-badge [tone]="a.level === 'critical' ? 'critical' : 'warning'">{{ a.kind === 'bounces' ? 'Rebotes' : 'Quejas' }}</app-badge>
                        } @empty {
                          @if (row.sent < minVolume) {
                            <span class="muted small">Poco volumen</span>
                          } @else {
                            <app-badge tone="good">Bien</app-badge>
                          }
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          } @else {
            <app-empty heading="Sin datos en este periodo">
              <svg icon lucideGauge [size]="20"></svg>
              {{ by() === 'domain' ? 'Aún no hay envíos de correo.' : by() === 'template' ? 'Ningún envío usó una plantilla.' : 'Ningún envío llevaba etiquetas.' }}
            </app-empty>
          }
        } @else {
          <div class="card-body stack"><div class="skeleton"></div><div class="skeleton"></div></div>
        }
        <footer class="card-foot">
          <span class="muted small">
            Avisos con {{ minVolume }} envíos o más: rebotes desde el 2 % (crítico el 5 %), quejas desde el 0,1 % (crítico el 0,3 %, el
            límite de Gmail y Yahoo). En modo real, el dueño y los administradores reciben un correo.
          </span>
        </footer>
      </section>
    </div>
  `,
})
export class DeliverabilityPage {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly toasts = inject(Toasts);
  protected readonly groups = GROUPS;
  protected readonly periods = PERIODS;
  protected readonly by = signal<DeliverabilityGroup>('domain');
  protected readonly days = signal(7);
  protected readonly result = signal<Deliverability | null>(null);
  protected readonly live = () => this.session.mode() === 'live';
  protected readonly format = formatNumber;
  protected readonly minVolume = 50;

  constructor() {
    effect(() => {
      const query = { by: this.by(), days: this.days() };
      this.session.project();
      this.session.mode();
      this.result.set(null);
      this.api.deliverability(query).then(
        (r) => this.result.set(r),
        (error) => this.toasts.error(error),
      );
    });
  }

  protected column(): string {
    return GROUPS.find((g) => g.id === this.by())!.column;
  }

  protected pct(value: number | null): string {
    if (value === null) return '—';
    return `${(value * 100).toLocaleString('es', { maximumFractionDigits: value < 0.01 ? 2 : 1 })} %`;
  }

  protected alertText(a: DeliverabilityAlert): string {
    const what = a.kind === 'bounces' ? 'Los rebotes' : 'Las quejas';
    const limit = this.pct(a.threshold);
    return a.level === 'critical'
      ? `${what} están en ${this.pct(a.rate)}, por encima del ${limit}: los proveedores pueden empezar a frenar o rechazar tus correos.`
      : `${what} están en ${this.pct(a.rate)} (aviso desde el ${limit}). Revisa de dónde vienen en la tabla.`;
  }
}

