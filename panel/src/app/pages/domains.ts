import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideGlobe, LucidePlus, LucideRefreshCw, LucideTrash } from '@lucide/angular';
import { Api } from '../core/api';
import { timeAgo } from '../core/format';
import type { SendingDomain } from '../core/types';
import { Badge, CopyButton, EmptyState, Modal, Toasts } from '../ui/ui';

const PURPOSE: Record<string, string> = { dkim: 'DKIM', spf: 'SPF', dmarc: 'DMARC' };

@Component({
  selector: 'app-domains',
  imports: [FormsModule, RouterLink, Badge, CopyButton, EmptyState, Modal, LucideGlobe, LucidePlus, LucideRefreshCw, LucideTrash],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Dominios</h1>
          <p>
            Para enviar con el envío de Relayo, sin proveedor propio: Relayo firma tus correos con DKIM para tu dominio, que
            demuestras con unos registros DNS.
          </p>
        </div>
      </header>

      @if (available() === false) {
        <div class="callout callout-info">
          Este servidor no ofrece el envío de Relayo. Usa una <a routerLink="/connections">conexión</a> con tu propio proveedor.
        </div>
      } @else {
        <div class="stack">
          @switch (access()) {
            @case ('approved') {
              <div class="callout callout-good">
                El envío de Relayo está aprobado para este proyecto. Verifica tu dominio y actívalo en
                <a routerLink="/connections">Conexiones</a> (proveedor «Envío de Relayo»).
              </div>
            }
            @case ('requested') {
              <div class="callout">Tu solicitud del envío de Relayo está pendiente de revisión. Mientras tanto, ya puedes preparar tu dominio.</div>
            }
            @case ('denied') {
              <div class="callout callout-critical">
                La solicitud del envío de Relayo fue rechazada. Puedes enviar con tu propio proveedor desde
                <a routerLink="/connections">Conexiones</a>.
              </div>
            }
            @default {
              <div class="card card-pad row access-request">
                <p class="text-2">
                  El envío de Relayo se revisa por proyecto antes de activarlo, para proteger la reputación que comparten todos
                  sus usuarios. Pídelo y prepara tu dominio mientras tanto.
                </p>
                <button type="button" class="btn btn-primary" (click)="request()" [disabled]="busy()">Solicitar el envío de Relayo</button>
              </div>
            }
          }
          <form class="card card-pad row domain-add" (ngSubmit)="add()">
            <input class="input" name="domain" [(ngModel)]="domain" placeholder="tudominio.com" aria-label="Dominio" />
            <button type="submit" class="btn btn-primary" [disabled]="busy() || !domain.trim()"><svg lucidePlus [size]="15"></svg>Añadir dominio</button>
          </form>

          @if (domains() === null) {
            <div class="card card-pad stack"><div class="skeleton"></div></div>
          } @else if (domains()!.length === 0) {
            <div class="card">
              <app-empty heading="Sin dominios">
                <svg icon lucideGlobe [size]="20"></svg>
                Añade el dominio desde el que envías (el de tu dirección de remitente) y publica sus registros DNS.
              </app-empty>
            </div>
          }

          @for (d of domains(); track d.id) {
            <section class="card">
              <header class="card-head">
                <div class="row">
                  <h2>{{ d.domain }}</h2>
                  <app-badge [tone]="d.verified ? 'good' : 'warning'">{{ d.verified ? 'Verificado' : 'Pendiente' }}</app-badge>
                </div>
                <div class="row">
                  <button type="button" class="btn btn-sm" (click)="verify(d)" [disabled]="busy()"><svg lucideRefreshCw [size]="14"></svg>Comprobar DNS</button>
                  <button type="button" class="icon-button" (click)="removing.set(d)" [attr.aria-label]="'Eliminar ' + d.domain" title="Eliminar">
                    <svg lucideTrash [size]="15"></svg>
                  </button>
                </div>
              </header>
              <div class="table-wrap">
                <table class="table records">
                  <thead>
                    <tr>
                      <th>Registro</th>
                      <th>Tipo</th>
                      <th>Nombre</th>
                      <th>Valor</th>
                      <th>Estado</th>
                    </tr>
                  </thead>
                  <tbody>
                    @for (r of d.records; track r.purpose) {
                      <tr>
                        <td class="cell-main">{{ purpose(r.purpose) }}@if (!r.required) {<span class="muted"> (recomendado)</span>}</td>
                        <td class="mono">{{ r.type }}</td>
                        <td><div class="row"><code class="truncate">{{ r.host }}</code><app-copy [value]="r.host" label="Copiar nombre" /></div></td>
                        <td><div class="row"><code class="truncate record-value">{{ r.value }}</code><app-copy [value]="r.value" label="Copiar valor" /></div></td>
                        <td><app-badge [tone]="r.ok ? 'good' : r.required ? 'warning' : 'neutral'">{{ r.ok ? 'Encontrado' : 'No encontrado' }}</app-badge></td>
                      </tr>
                    }
                  </tbody>
                </table>
              </div>
              <footer class="card-foot">
                <span class="muted small">
                  @if (d.relay; as relay) {
                    {{ relay.name }}: {{ relay.verified ? 'acepta el dominio.' : 'pendiente; lo comprueba con el mismo registro DKIM, unos minutos después de publicarlo.' }}
                  }
                  @if (d.lastCheckedAt) {
                    Comprobado {{ ago(d.lastCheckedAt) }}.
                  }
                  Si ya tienes un registro SPF, añade el <code>include:</code> al existente en vez de crear otro.
                </span>
              </footer>
            </section>
          }
        </div>
      }
    </div>

    <app-modal heading="Eliminar dominio" [open]="!!removing()" (closed)="removing.set(null)">
      <p class="text-2">El envío de Relayo dejará de aceptar remitentes de <strong>{{ removing()?.domain }}</strong>.</p>
      <div class="modal-actions">
        <button type="button" class="btn" (click)="removing.set(null)">Cancelar</button>
        <button type="button" class="btn btn-danger" (click)="remove()" [disabled]="busy()">Eliminar</button>
      </div>
    </app-modal>
  `,
})
export class DomainsPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly domains = signal<SendingDomain[] | null>(null);
  protected readonly available = signal<boolean | null>(null);
  protected readonly access = signal<'requested' | 'approved' | 'denied' | null>(null);
  protected readonly removing = signal<SendingDomain | null>(null);
  protected readonly busy = signal(false);
  protected readonly ago = (value: string) => timeAgo(value);
  protected domain = '';

  constructor() {
    void this.load();
  }

  protected purpose(value: string): string {
    return PURPOSE[value] ?? value;
  }

  protected async request(): Promise<void> {
    await this.run(async () => {
      const { access } = await this.api.requestManagedAccess();
      this.access.set(access);
      this.toasts.show(access === 'approved' ? 'Envío de Relayo aprobado' : 'Solicitud enviada: te avisaremos al revisarla');
    });
  }

  protected async add(): Promise<void> {
    await this.run(async () => {
      await this.api.addDomain(this.domain.trim());
      this.domain = '';
      await this.load();
    });
  }

  protected async verify(d: SendingDomain): Promise<void> {
    await this.run(async () => {
      const updated = await this.api.verifyDomain(d.id);
      this.toasts.show(updated.verified ? `${updated.domain} verificado` : 'Aún faltan registros: el DNS puede tardar unos minutos en propagarse');
      await this.load();
    });
  }

  protected async remove(): Promise<void> {
    const d = this.removing();
    if (!d) return;
    await this.run(async () => {
      await this.api.deleteDomain(d.id);
      this.removing.set(null);
      await this.load();
    });
  }

  private async load(): Promise<void> {
    try {
      const { available, access, data } = await this.api.domains();
      this.available.set(available);
      this.access.set(access);
      this.domains.set(data);
    } catch (error) {
      this.domains.update((d) => d ?? []);
      this.toasts.error(error);
    }
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await action();
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}
