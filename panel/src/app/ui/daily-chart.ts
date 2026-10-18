import { Component, computed, input, signal } from '@angular/core';
import type { ProjectStats } from '../core/types';
import { formatNumber, shortDate } from '../core/format';

type Day = ProjectStats['daily'][number];
type SeriesKey = 'delivered' | 'deferred' | 'bounced' | 'complained';

/**
 * Series, bottom to top, colored with categorical slots 1–4 in fixed order (validated for color-vision
 * deficiencies on both surfaces). Light-mode contrast is relieved by the legend, tooltip and table.
 */
const SERIES: Array<{ key: SeriesKey; label: string }> = [
  { key: 'delivered', label: 'Entregados' },
  { key: 'bounced', label: 'Rebotados' },
  { key: 'deferred', label: 'Aplazados' },
  { key: 'complained', label: 'Quejas' },
];

/** Clean axis maximum: 1, 2, 5 × 10^n at or above the value. */
function niceMax(value: number): number {
  if (value <= 4) return 4;
  const power = 10 ** Math.floor(Math.log10(value));
  const step = [1, 2, 2.5, 5, 10].find((s) => s * power >= value)!;
  return step * power;
}

@Component({
  selector: 'app-daily-chart',
  template: `
    <figure class="chart">
      <figcaption class="chart-head">
        <span class="chart-title">Eventos por día</span>
        <ul class="legend" aria-label="Leyenda">
          @for (s of series; track s.key) {
            <li><span class="legend-key" [attr.data-series]="s.key" aria-hidden="true"></span>{{ s.label }}</li>
          }
        </ul>
      </figcaption>

      <div class="chart-plot" role="img" [attr.aria-label]="summary()">
        <div class="chart-grid" aria-hidden="true">
          @for (tick of ticks(); track tick) {
            <div class="chart-gridline" [style.bottom.%]="(tick / max()) * 100">
              <span>{{ format(tick) }}</span>
            </div>
          }
        </div>
        <div class="chart-columns">
          @for (day of days(); track day.date; let i = $index) {
            <div
              class="chart-column"
              (mouseenter)="hovered.set(i)"
              (mouseleave)="hovered.set(null)"
              (focus)="hovered.set(i)"
              (blur)="hovered.set(null)"
              tabindex="0"
              [attr.aria-label]="dayLabel(day)"
            >
              <div class="chart-stack">
                @for (s of series; track s.key) {
                  @if (day[s.key] > 0) {
                    <div class="chart-segment" [attr.data-series]="s.key" [style.height.%]="(day[s.key] / max()) * 100"></div>
                  }
                }
              </div>
              @if (hovered() === i) {
                <div class="chart-tooltip" [class.chart-tooltip-left]="i > days().length / 2" role="presentation">
                  <strong>{{ dayName(day.date) }}</strong>
                  @for (s of series; track s.key) {
                    <span><i class="legend-key" [attr.data-series]="s.key"></i>{{ s.label }}<b>{{ format(day[s.key]) }}</b></span>
                  }
                </div>
              }
            </div>
          }
        </div>
      </div>
      <div class="chart-axis" aria-hidden="true">
        @for (day of days(); track day.date; let i = $index) {
          <span>{{ showLabel(i) ? axisLabel(day.date) : '' }}</span>
        }
      </div>

      <details class="chart-table">
        <summary>Ver como tabla</summary>
        <table>
          <thead>
            <tr>
              <th>Día</th>
              @for (s of series; track s.key) {
                <th>{{ s.label }}</th>
              }
            </tr>
          </thead>
          <tbody>
            @for (day of days(); track day.date) {
              <tr>
                <td>{{ dayName(day.date) }}</td>
                @for (s of series; track s.key) {
                  <td>{{ format(day[s.key]) }}</td>
                }
              </tr>
            }
          </tbody>
        </table>
      </details>
    </figure>
  `,
})
export class DailyChart {
  readonly days = input.required<Day[]>();
  protected readonly series = SERIES;
  protected readonly hovered = signal<number | null>(null);
  protected readonly format = formatNumber;

  protected readonly max = computed(() =>
    niceMax(Math.max(0, ...this.days().map((d) => d.delivered + d.deferred + d.bounced + d.complained))),
  );
  protected readonly ticks = computed(() => [0, 0.25, 0.5, 0.75, 1].map((f) => Math.round(this.max() * f)));
  protected readonly summary = computed(() => {
    const total = (key: SeriesKey) => this.days().reduce((sum, d) => sum + d[key], 0);
    return `Eventos por día: ${SERIES.map((s) => `${formatNumber(total(s.key))} ${s.label.toLowerCase()}`).join(', ')}.`;
  });

  protected showLabel(index: number): boolean {
    const n = this.days().length;
    const every = n <= 8 ? 1 : n <= 16 ? 2 : Math.ceil(n / 8);
    return index % every === 0 || index === n - 1;
  }

  protected axisLabel(date: string): string {
    const d = new Date(`${date}T00:00:00Z`);
    return `${d.getUTCDate()}/${d.getUTCMonth() + 1}`;
  }

  protected dayName(date: string): string {
    return shortDate(`${date}T12:00:00Z`);
  }

  protected dayLabel(day: Day): string {
    return `${this.dayName(day.date)}: ${SERIES.map((s) => `${day[s.key]} ${s.label.toLowerCase()}`).join(', ')}`;
  }
}
