import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideKeyRound, LucidePlus, LucideTrash, LucideTriangleAlert } from '@lucide/angular';
import { Api } from '../core/api';
import { Session } from '../core/session';
import { fullDate, timeAgo } from '../core/format';
import type { ApiKey } from '../core/types';
import { Badge, CopyButton, EmptyState, Modal, Toasts } from '../ui/ui';

@Component({
  selector: 'app-keys',
  imports: [FormsModule, Badge, CopyButton, EmptyState, Modal, LucideKeyRound, LucidePlus, LucideTrash, LucideTriangleAlert],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Claves de API</h1>
          <p>Autentican la API HTTP y el SMTP del simulador. Usa una por entorno o aplicación.</p>
        </div>
        <button type="button" class="btn btn-primary" (click)="openCreate()"><svg lucidePlus [size]="15"></svg>Nueva clave</button>
      </header>

      <section class="card">
        @if (keys() === null) {
          <div class="card-body stack"><div class="skeleton"></div><div class="skeleton"></div></div>
        } @else if (keys()!.length === 0) {
          <app-empty heading="No hay claves">
            <svg icon lucideKeyRound [size]="20"></svg>
            Crea una para enviar mensajes al simulador.
          </app-empty>
        } @else {
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>Nombre</th>
                  <th>Clave</th>
                  <th class="hide-sm">Creada</th>
                  <th class="hide-sm">Último uso</th>
                  <th><span class="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                @for (key of keys(); track key.id) {
                  <tr [class.revoked]="key.revokedAt">
                    <td class="cell-main">
                      {{ key.name }}
                      <app-badge [tone]="key.mode === 'live' ? 'good' : 'neutral'">{{ key.mode === 'live' ? 'En vivo' : 'Prueba' }}</app-badge>
                    </td>
                    <td>
                      <code>{{ key.prefix }}…</code>
                      @if (key.revokedAt) {
                        <app-badge tone="neutral">Revocada</app-badge>
                      }
                    </td>
                    <td class="hide-sm muted nowrap" [title]="full(key.createdAt)">{{ ago(key.createdAt) }}</td>
                    <td class="hide-sm muted nowrap" [title]="key.lastUsedAt ? full(key.lastUsedAt) : ''">
                      {{ key.lastUsedAt ? ago(key.lastUsedAt) : 'Nunca' }}
                    </td>
                    <td class="cell-actions">
                      @if (!key.revokedAt) {
                        <button type="button" class="icon-button" (click)="confirmRevoke(key)" [attr.aria-label]="'Revocar ' + key.name" title="Revocar">
                          <svg lucideTrash [size]="15"></svg>
                        </button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        }
      </section>
      @if (activeCount() === 1) {
        <p class="muted small page-note">Este proyecto solo tiene una clave activa: si la revocas, nada podrá enviar hasta que crees otra.</p>
      }
    </div>

    <app-modal heading="Nueva clave de API" [open]="creating()" (closed)="closeCreate()">
      @if (created(); as value) {
        <div class="callout"><svg lucideTriangleAlert [size]="15"></svg><span>Copia la clave ahora: no se volverá a mostrar.</span></div>
        <div class="field modal-gap">
          <span class="label">Clave de API</span>
          <div class="secret"><code>{{ value }}</code><app-copy [value]="value" label="Copiar clave" /></div>
        </div>
        <div class="modal-actions"><button type="button" class="btn btn-primary" (click)="closeCreate()">Hecho</button></div>
      } @else {
        <form (ngSubmit)="create()">
          <div class="field">
            <label for="key-name">Nombre</label>
            <input id="key-name" class="input" name="name" required [(ngModel)]="name" placeholder="Producción, CI, local…" />
          </div>
          <div class="field">
            <span class="label">Modo</span>
            <div class="segmented" role="group" aria-label="Modo de la clave">
              <button type="button" [attr.aria-pressed]="mode === 'test'" (click)="mode = 'test'">Prueba</button>
              <button type="button" [attr.aria-pressed]="mode === 'live'" (click)="mode = 'live'">En vivo</button>
            </div>
            <span class="hint">
              {{ mode === 'test' ? 'rly_test_…: simula los envíos con los escenarios; no se entrega nada.' : 'rly_live_…: entrega de verdad por tus conexiones.' }}
            </span>
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" (click)="closeCreate()">Cancelar</button>
            <button type="submit" class="btn btn-primary" [disabled]="busy() || !name.trim()">Crear clave</button>
          </div>
        </form>
      }
    </app-modal>

    <app-modal heading="Revocar clave" [open]="!!revoking()" (closed)="revoking.set(null)">
      <p class="text-2">
        La clave <strong>{{ revoking()?.name }}</strong> (<code>{{ revoking()?.prefix }}…</code>) dejará de funcionar al momento. No
        se puede deshacer.
      </p>
      <div class="modal-actions">
        <button type="button" class="btn" (click)="revoking.set(null)">Cancelar</button>
        <button type="button" class="btn btn-danger" (click)="revoke()" [disabled]="busy()">Revocar clave</button>
      </div>
    </app-modal>
  `,
})
export class KeysPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly session = inject(Session);
  protected readonly keys = signal<ApiKey[] | null>(null);
  protected readonly creating = signal(false);
  protected readonly created = signal<string | null>(null);
  protected readonly revoking = signal<ApiKey | null>(null);
  protected readonly busy = signal(false);
  protected readonly activeCount = computed(() => (this.keys() ?? []).filter((k) => !k.revokedAt).length);
  protected readonly full = fullDate;
  protected readonly ago = (value: string) => timeAgo(value);
  protected name = '';
  protected mode: 'test' | 'live' = 'test';

  constructor() {
    void this.load();
  }

  protected openCreate(): void {
    this.name = '';
    this.mode = this.session.mode();
    this.created.set(null);
    this.creating.set(true);
  }

  protected closeCreate(): void {
    this.creating.set(false);
    this.created.set(null);
  }

  protected confirmRevoke(key: ApiKey): void {
    this.revoking.set(key);
  }

  protected async create(): Promise<void> {
    await this.run(async () => {
      const { apiKey } = await this.api.createKey(this.name.trim(), this.mode);
      this.created.set(apiKey);
      await this.load();
    });
  }

  protected async revoke(): Promise<void> {
    const key = this.revoking();
    if (!key) return;
    await this.run(async () => {
      await this.api.revokeKey(key.id);
      this.revoking.set(null);
      this.toasts.show(`Clave «${key.name}» revocada`);
      await this.load();
    });
  }

  private async load(): Promise<void> {
    try {
      this.keys.set(await this.api.keys());
    } catch (error) {
      this.keys.update((k) => k ?? []);
      this.toasts.error(error);
    }
  }

  private async run(action: () => Promise<void>): Promise<void> {
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
