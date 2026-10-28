import { Component, inject, signal } from '@angular/core';
import { LucideCheck, LucideShieldCheck, LucideX } from '@lucide/angular';
import { Api } from '../core/api';
import { timeAgo } from '../core/format';
import type { ManagedRequest } from '../core/types';
import { Badge, EmptyState, Toasts } from '../ui/ui';
import { AdminPlans } from './admin-plans';
import { AdminIncidents } from './admin-incidents';

const ACCESS: Record<string, { label: string; tone: 'warning' | 'good' | 'critical' }> = {
  requested: { label: 'Pendiente', tone: 'warning' },
  approved: { label: 'Aprobado', tone: 'good' },
  denied: { label: 'Rechazado', tone: 'critical' },
};

/** Platform admins: who may send through Relayo's own relay. */
@Component({
  selector: 'app-admin',
  imports: [Badge, EmptyState, AdminPlans, AdminIncidents, LucideCheck, LucideShieldCheck, LucideX],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Administración</h1>
          <p>
            Solicitudes del envío de Relayo. Aprueba solo proyectos que reconozcas: envían con la reputación del relay, que
            comparten todos. Rechazar un proyecto aprobado lo detiene al momento.
          </p>
        </div>
      </header>

      <section class="card">
        @if (rows() === null) {
          <div class="card-body stack"><div class="skeleton"></div><div class="skeleton"></div></div>
        } @else if (rows()!.length === 0) {
          <app-empty heading="Sin solicitudes">
            <svg icon lucideShieldCheck [size]="20"></svg>
            Cuando un proyecto pida el envío de Relayo desde Dominios, aparecerá aquí.
          </app-empty>
        } @else {
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Proyecto</th>
                  <th>Dueño</th>
                  <th>Dominios</th>
                  <th class="num">Envíos reales (mes)</th>
                  <th>Estado</th>
                  <th><span class="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                @for (r of rows(); track r.project.id) {
                  <tr>
                    <td class="cell-main">{{ r.project.name }}<div class="muted small mono">{{ r.project.id }}</div></td>
                    <td>
                      @if (r.owner) {
                        {{ r.owner.name }}
                        <div class="muted small">{{ r.owner.email }} · cuenta de {{ ago(r.owner.createdAt) }}</div>
                      } @else {
                        <span class="muted">Sin dueño</span>
                      }
                    </td>
                    <td>
                      @for (d of r.domains; track d.domain) {
                        <div>{{ d.domain }} <span class="muted small">{{ d.verified ? '· verificado' : '· sin verificar' }}</span></div>
                      } @empty {
                        <span class="muted">Ninguno</span>
                      }
                    </td>
                    <td class="num">{{ r.usage }}</td>
                    <td><app-badge [tone]="access(r).tone">{{ access(r).label }}</app-badge></td>
                    <td>
                      <div class="row row-end">
                        @if (r.project.managedAccess !== 'approved') {
                          <button type="button" class="btn btn-sm" (click)="decide(r, 'approved')" [disabled]="busy()"><svg lucideCheck [size]="14"></svg>Aprobar</button>
                        }
                        @if (r.project.managedAccess !== 'denied') {
                          <button type="button" class="btn btn-sm btn-danger" (click)="decide(r, 'denied')" [disabled]="busy()"><svg lucideX [size]="14"></svg>Rechazar</button>
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

      <app-admin-plans />
      <app-admin-incidents />
    </div>
  `,
})
export class AdminPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly rows = signal<ManagedRequest[] | null>(null);
  protected readonly busy = signal(false);
  protected readonly ago = (value: string) => timeAgo(value);

  constructor() {
    void this.load();
  }

  protected access(r: ManagedRequest) {
    return ACCESS[r.project.managedAccess ?? 'requested']!;
  }

  protected async decide(r: ManagedRequest, decision: 'approved' | 'denied'): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.decideManagedAccess(r.project.id, decision);
      this.toasts.show(decision === 'approved' ? `«${r.project.name}» aprobado` : `«${r.project.name}» rechazado`);
      await this.load();
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  private async load(): Promise<void> {
    try {
      this.rows.set(await this.api.managedRequests());
    } catch (error) {
      this.rows.update((r) => r ?? []);
      this.toasts.error(error);
    }
  }
}
