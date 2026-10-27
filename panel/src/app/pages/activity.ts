import { Component, computed, effect, inject, signal } from '@angular/core';
import { LucideHistory, LucideRefreshCw } from '@lucide/angular';
import { Api } from '../core/api';
import type { Tone } from '../core/events';
import { formatNumber, fullDate, timeAgo } from '../core/format';
import { Session } from '../core/session';
import type { ApiRequestLog, AuditEntry } from '../core/types';
import { Badge, EmptyState, Toasts } from '../ui/ui';

/** What each change in the audit log means, by method and route. */
const ACTIONS: Record<string, string> = {
  'PATCH /v1/project': 'Cambió los ajustes del proyecto',
  'POST /v1/project/keys': 'Creó una clave de API',
  'DELETE /v1/project/keys/:id': 'Revocó una clave de API',
  'POST /v1/project/webhook-secret/rotate': 'Rotó el secreto del webhook',
  'POST /v1/project/team/invites': 'Invitó a alguien al equipo',
  'DELETE /v1/project/team/invites/:id': 'Anuló una invitación',
  'PATCH /v1/project/team/members/:userId': 'Cambió el rol de un miembro',
  'DELETE /v1/project/team/members/:userId': 'Quitó a alguien del equipo',
  'DELETE /v1/scheduled/:id': 'Canceló un envío programado',
  'POST /v1/project/templates': 'Creó una plantilla',
  'PATCH /v1/project/templates/:ref': 'Editó una plantilla',
  'DELETE /v1/project/templates/:ref': 'Borró una plantilla',
  'POST /v1/project/webhook/deliveries/:id/redeliver': 'Reenvió un evento al webhook',
  'POST /v1/project/webhook/test': 'Envió un evento de prueba al webhook',
  'POST /v1/project/webhook/redeliver': 'Reenvió los eventos fallidos',
  'POST /v1/project/webhook/endpoints': 'Añadió un endpoint de webhook',
  'PATCH /v1/project/webhook/endpoints/:id': 'Editó un endpoint de webhook',
  'DELETE /v1/project/webhook/endpoints/:id': 'Borró un endpoint de webhook',
  'POST /v1/project/webhook/endpoints/:id/secret/rotate': 'Rotó el secreto de un endpoint',
  'POST /v1/project/managed-access': 'Pidió el envío de Relayo',
  'POST /v1/project/domains': 'Añadió un dominio',
  'POST /v1/project/domains/:id/verify': 'Comprobó un dominio',
  'DELETE /v1/project/domains/:id': 'Borró un dominio',
  'POST /v1/project/connections': 'Añadió una conexión',
  'POST /v1/project/connections/order': 'Cambió el orden de las conexiones',
  'PATCH /v1/project/connections/:id': 'Editó una conexión',
  'DELETE /v1/project/connections/:id': 'Borró una conexión',
  'POST /v1/project/connections/:id/test': 'Probó una conexión',
  'POST /v1/project/suppressions': 'Añadió una supresión',
  'DELETE /v1/project/suppressions/:address': 'Quitó una supresión',
  'PATCH /v1/admin/plans/:projectId': 'Cambió el plan del proyecto',
  'POST /v1/project/inbound': 'Activó la dirección de entrada',
  'DELETE /v1/project/inbound': 'Desactivó la dirección de entrada',
};

const FIELDS: Record<string, string> = {
  name: 'nombre',
  email: 'email',
  role: 'rol',
  permission: 'permiso',
  allowedDomains: 'dominios',
  mode: 'modo',
  address: 'dirección',
  reason: 'motivo',
  domain: 'dominio',
  kind: 'tipo',
  channel: 'canal',
  monthlyMessages: 'simulados/mes',
  liveMonthlyMessages: 'reales/mes',
  messagesPerMinute: 'por minuto',
  retentionDays: 'retención',
};

type Tab = 'requests' | 'audit';

/** The project's activity: every request made with its API keys, and who changed what. */
@Component({
  selector: 'app-activity',
  imports: [Badge, EmptyState, LucideHistory, LucideRefreshCw],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Actividad</h1>
          <p>
            Las peticiones hechas con las claves de API, con su respuesta, y quién cambió qué en el proyecto. Las peticiones se guardan
            lo mismo que los mensajes; la auditoría, un año.
          </p>
        </div>
      </header>

      <section class="card">
        <header class="card-head">
          <div class="segmented" role="group" aria-label="Registro">
            <button type="button" [attr.aria-pressed]="tab() === 'requests'" (click)="show('requests')">Peticiones de API</button>
            @if (admin()) {
              <button type="button" [attr.aria-pressed]="tab() === 'audit'" (click)="show('audit')">Auditoría</button>
            }
          </div>
          <div class="row">
            @if (tab() === 'requests') {
              <div class="segmented" role="group" aria-label="Filtro">
                <button type="button" [attr.aria-pressed]="!failedOnly()" (click)="filter(false)">Todas</button>
                <button type="button" [attr.aria-pressed]="failedOnly()" (click)="filter(true)">Con error</button>
              </div>
            }
            <button type="button" class="icon-button" (click)="reload()" aria-label="Actualizar" title="Actualizar"><svg lucideRefreshCw [size]="15"></svg></button>
          </div>
        </header>

        @if (tab() === 'requests') {
          @if (requests() === null) {
            <div class="card-body stack"><div class="skeleton"></div><div class="skeleton"></div></div>
          } @else if (requests()!.length === 0) {
            <app-empty [heading]="failedOnly() ? 'Sin errores' : 'Sin peticiones'">
              <svg icon lucideHistory [size]="20"></svg>
              {{ failedOnly() ? 'Ninguna petición ha fallado.' : 'Aquí aparecerá cada petición hecha con una clave de API de este proyecto.' }}
            </app-empty>
          } @else {
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>Cuándo</th>
                    <th>Petición</th>
                    <th>Clave</th>
                    <th>Respuesta</th>
                    <th class="num">Tiempo</th>
                  </tr>
                </thead>
                <tbody>
                  @for (r of requests(); track r.id) {
                    <tr>
                      <td class="nowrap" [title]="full(r.createdAt)">{{ ago(r.createdAt) }}</td>
                      <td>
                        <code>{{ r.method }} {{ r.path }}</code>
                        @if (r.error) {
                          <div class="muted small">{{ r.error }}</div>
                        }
                      </td>
                      <td class="small">
                        {{ r.keyName }}
                        @if (r.mode === 'live') {
                          <span class="chip">real</span>
                        }
                      </td>
                      <td><app-badge [tone]="statusTone(r.status)">{{ r.status }}</app-badge></td>
                      <td class="num nowrap">{{ format(r.durationMs) }} ms</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        } @else {
          @if (audit() === null) {
            <div class="card-body stack"><div class="skeleton"></div><div class="skeleton"></div></div>
          } @else if (audit()!.length === 0) {
            <app-empty heading="Sin cambios">
              <svg icon lucideHistory [size]="20"></svg>
              Aquí aparecerá cada cambio en el proyecto: claves, equipo, ajustes, plantillas, conexiones…
            </app-empty>
          } @else {
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr>
                    <th>Cuándo</th>
                    <th>Quién</th>
                    <th>Qué</th>
                  </tr>
                </thead>
                <tbody>
                  @for (e of audit(); track e.id) {
                    <tr>
                      <td class="nowrap" [title]="full(e.createdAt)">{{ ago(e.createdAt) }}</td>
                      <td class="small">
                        {{ who(e) }}
                        @if (e.ip) {
                          <div class="muted small">{{ e.ip }}</div>
                        }
                      </td>
                      <td>
                        {{ describe(e) }}
                        @if (details(e); as d) {
                          <div class="muted small">{{ d }}</div>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        }
        @if (more()) {
          <footer class="card-foot">
            <span></span>
            <button type="button" class="btn btn-sm" (click)="loadMore()" [disabled]="busy()">Cargar más</button>
          </footer>
        }
      </section>
    </div>
  `,
})
export class ActivityPage {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly toasts = inject(Toasts);
  protected readonly admin = computed(() => this.session.project()?.role !== 'member');
  protected readonly tab = signal<Tab>('requests');
  protected readonly requests = signal<ApiRequestLog[] | null>(null);
  protected readonly audit = signal<AuditEntry[] | null>(null);
  protected readonly failedOnly = signal(false);
  protected readonly more = signal(false);
  protected readonly busy = signal(false);
  protected readonly format = formatNumber;
  protected readonly ago = (value: string) => timeAgo(value);
  protected readonly full = (value: string) => fullDate(value);
  private static readonly PAGE = 50;

  constructor() {
    // Again when the project or the mode changes.
    effect(() => {
      this.session.project();
      void this.reload();
    });
  }

  protected show(tab: Tab): void {
    if (tab === this.tab()) return;
    this.tab.set(tab);
    void this.reload();
  }

  protected filter(failed: boolean): void {
    if (failed === this.failedOnly()) return;
    this.failedOnly.set(failed);
    void this.reload();
  }

  protected async reload(): Promise<void> {
    this.more.set(false);
    try {
      if (this.tab() === 'requests') {
        this.requests.set(null);
        const rows = await this.api.apiRequests({ limit: ActivityPage.PAGE, ...(this.failedOnly() && { status: 'failed' }) });
        this.requests.set(rows);
        this.more.set(rows.length === ActivityPage.PAGE);
      } else {
        this.audit.set(null);
        const rows = await this.api.audit({ limit: ActivityPage.PAGE });
        this.audit.set(rows);
        this.more.set(rows.length === ActivityPage.PAGE);
      }
    } catch (error) {
      this.requests.update((r) => r ?? []);
      this.audit.update((r) => r ?? []);
      this.toasts.error(error);
    }
  }

  protected async loadMore(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      if (this.tab() === 'requests') {
        const last = this.requests()?.at(-1);
        if (!last) return;
        const next = await this.api.apiRequests({ limit: ActivityPage.PAGE, before: last.createdAt, ...(this.failedOnly() && { status: 'failed' }) });
        this.requests.update((rows) => [...(rows ?? []), ...next]);
        this.more.set(next.length === ActivityPage.PAGE);
      } else {
        const last = this.audit()?.at(-1);
        if (!last) return;
        const next = await this.api.audit({ limit: ActivityPage.PAGE, before: last.createdAt });
        this.audit.update((rows) => [...(rows ?? []), ...next]);
        this.more.set(next.length === ActivityPage.PAGE);
      }
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected statusTone(status: number): Tone {
    if (status < 400) return 'good';
    return status < 500 ? 'warning' : 'critical';
  }

  protected who(e: AuditEntry): string {
    switch (e.actor.kind) {
      case 'user':
        return e.actor.email;
      case 'key':
        return `Clave «${e.actor.name}»`;
      default:
        return e.actor.email ? `Administración (${e.actor.email})` : 'Administración de la plataforma';
    }
  }

  protected describe(e: AuditEntry): string {
    return ACTIONS[e.action] ?? e.action;
  }

  protected details(e: AuditEntry): string {
    const parts = Object.entries(e.details ?? {}).map(([key, value]) => `${FIELDS[key] ?? key}: ${Array.isArray(value) ? value.join(', ') : String(value)}`);
    const target = e.params && Object.values(e.params)[0];
    if (target && !parts.length) parts.push(target);
    return parts.join(' · ');
  }
}
