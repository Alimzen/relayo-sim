import { Component, inject, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideEye, LucidePencil, LucidePlus, LucideRefreshCw, LucideSend, LucideTrash } from '@lucide/angular';
import { Api } from '../core/api';
import { EVENT_LABELS } from '../core/events';
import type { EventType, Mode, WebhookEndpoint } from '../core/types';
import { CopyButton, Modal, Toasts } from '../ui/ui';

const EVENT_TYPES = Object.keys(EVENT_LABELS) as EventType[];

interface Draft {
  url: string;
  description: string;
  mode: Mode | '';
  events: Partial<Record<EventType, boolean>>;
  inbound: boolean;
  enabled: boolean;
}

/** More URLs for the project's events, each with its own secret and the events (and mode) it wants. */
@Component({
  selector: 'app-webhook-endpoints',
  imports: [FormsModule, CopyButton, Modal, LucideEye, LucidePencil, LucidePlus, LucideRefreshCw, LucideSend, LucideTrash],
  template: `
    <section class="card">
      <header class="card-head">
        <div>
          <h2>Más endpoints</h2>
          <p class="muted small">
            Otras URLs que reciben los eventos, cada una con su secreto. Pueden quedarse solo con algunos tipos (por ejemplo, rebotes y
            quejas para el CRM) o solo con los de un modo.
          </p>
        </div>
        <button type="button" class="btn btn-sm" (click)="add()" [disabled]="(endpoints()?.length ?? 0) >= 10">
          <svg lucidePlus [size]="14"></svg>Añadir
        </button>
      </header>
      @if (endpoints(); as list) {
        @if (list.length) {
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr>
                  <th>URL</th>
                  <th>Eventos</th>
                  <th>Modo</th>
                  <th><span class="sr-only">Acciones</span></th>
                </tr>
              </thead>
              <tbody>
                @for (e of list; track e.id) {
                  <tr [class.muted]="!e.enabled">
                    <td class="cell-main">
                      <code class="truncate">{{ e.url }}</code>
                      <div class="muted small">
                        {{ e.description ?? '' }}
                        @if (!e.enabled) {
                          <span class="chip">En pausa</span>
                        }
                      </div>
                    </td>
                    <td class="small">{{ e.events ? labels(e.events) : 'Todos' }}</td>
                    <td class="small">{{ e.mode === 'live' ? 'Real' : e.mode === 'test' ? 'Prueba' : 'Los dos' }}</td>
                    <td class="nowrap">
                      <button type="button" class="icon-button" (click)="test(e)" [disabled]="busy()" title="Enviar evento de prueba" aria-label="Enviar evento de prueba">
                        <svg lucideSend [size]="15"></svg>
                      </button>
                      <button type="button" class="icon-button" (click)="showSecret(e)" title="Secreto de firma" aria-label="Ver el secreto de firma">
                        <svg lucideEye [size]="15"></svg>
                      </button>
                      <button type="button" class="icon-button" (click)="edit(e)" title="Editar" aria-label="Editar el endpoint">
                        <svg lucidePencil [size]="15"></svg>
                      </button>
                      <button type="button" class="icon-button" (click)="removing.set(e)" title="Borrar" aria-label="Borrar el endpoint">
                        <svg lucideTrash [size]="15"></svg>
                      </button>
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <div class="card-body"><p class="muted small">Ninguno: los eventos solo van a la URL principal.</p></div>
        }
      } @else {
        <div class="card-body stack"><div class="skeleton"></div></div>
      }
    </section>

    <app-modal [heading]="editing() ? 'Editar endpoint' : 'Añadir endpoint'" [open]="!!draft()" (closed)="draft.set(null)">
      @if (draft(); as d) {
        <form (ngSubmit)="save()">
          <div class="field">
            <label for="endpoint-url">URL</label>
            <input id="endpoint-url" class="input" type="url" name="url" required placeholder="https://crm.example/webhooks/relayo" [(ngModel)]="d.url" />
          </div>
          <div class="field">
            <label for="endpoint-description">Descripción</label>
            <input id="endpoint-description" class="input" name="description" maxlength="200" placeholder="CRM" [(ngModel)]="d.description" />
          </div>
          <div class="field">
            <label for="endpoint-mode">Modo</label>
            <select id="endpoint-mode" class="input" name="mode" [(ngModel)]="d.mode">
              <option value="">Los dos</option>
              <option value="test">Solo prueba (simulados)</option>
              <option value="live">Solo real</option>
            </select>
          </div>
          <fieldset class="field">
            <legend class="label">Eventos</legend>
            <div class="check-grid">
              @for (type of types; track type) {
                <label class="check">
                  <input type="checkbox" [name]="'event-' + type" [(ngModel)]="d.events[type]" />{{ label(type) }}
                </label>
              }
            </div>
            <span class="hint">Sin marcar ninguno, recibe todos los de los mensajes (con «Correos recibidos», solo esos correos).</span>
          </fieldset>
          <label class="check option endpoint-inbound">
            <input type="checkbox" name="inbound" [(ngModel)]="d.inbound" />
            <span>
              <strong>Correos recibidos</strong> (<code>inbound</code>)
              <span class="muted small block">Las respuestas y lo que llegue a la dirección de entrada.</span>
            </span>
          </label>
          @if (editing()) {
            <label class="check">
              <input type="checkbox" name="enabled" [(ngModel)]="d.enabled" />Activo
            </label>
          }
          <div class="modal-actions">
            <button type="button" class="btn" (click)="draft.set(null)">Cancelar</button>
            <button type="submit" class="btn btn-primary" [disabled]="busy() || !d.url.trim()">Guardar</button>
          </div>
        </form>
      }
    </app-modal>

    <app-modal heading="Secreto de firma" [open]="!!secretOf()" (closed)="secretOf.set(null)">
      @if (secretOf(); as s) {
        <p class="text-2 modal-lede">Verifica con él la cabecera <code>Relayo-Signature</code> de lo que llega a <code>{{ s.endpoint.url }}</code>.</p>
        <div class="secret">
          <code>{{ s.secret }}</code>
          <app-copy [value]="s.secret" label="Copiar secreto" />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" (click)="rotate(s.endpoint)" [disabled]="busy()"><svg lucideRefreshCw [size]="14"></svg>Rotar</button>
          <button type="button" class="btn btn-primary" (click)="secretOf.set(null)">Cerrar</button>
        </div>
      }
    </app-modal>

    <app-modal heading="Borrar el endpoint" [open]="!!removing()" (closed)="removing.set(null)">
      <p class="text-2">Deja de recibir eventos al momento. Sus entregas siguen en el registro.</p>
      <div class="modal-actions">
        <button type="button" class="btn" (click)="removing.set(null)">Cancelar</button>
        <button type="button" class="btn btn-danger" (click)="remove()" [disabled]="busy()">Borrar</button>
      </div>
    </app-modal>
  `,
})
export class WebhookEndpoints {
  /** After a test event: the delivery log has a new row. */
  readonly tested = output<void>();
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly endpoints = signal<WebhookEndpoint[] | null>(null);
  protected readonly draft = signal<Draft | null>(null);
  protected readonly editing = signal<WebhookEndpoint | null>(null);
  protected readonly removing = signal<WebhookEndpoint | null>(null);
  protected readonly secretOf = signal<{ endpoint: WebhookEndpoint; secret: string } | null>(null);
  protected readonly busy = signal(false);
  protected readonly types = EVENT_TYPES;

  constructor() {
    this.api.webhookEndpoints().then(
      (list) => this.endpoints.set(list),
      (error) => {
        this.endpoints.set([]);
        this.toasts.error(error);
      },
    );
  }

  protected label(type: EventType): string {
    return EVENT_LABELS[type];
  }

  protected labels(types: Array<EventType | 'inbound'>): string {
    return types.map((t) => (t === 'inbound' ? 'Recibidos' : EVENT_LABELS[t])).join(', ');
  }

  protected add(): void {
    this.editing.set(null);
    this.draft.set({ url: '', description: '', mode: '', events: {}, inbound: false, enabled: true });
  }

  protected edit(e: WebhookEndpoint): void {
    this.editing.set(e);
    this.draft.set({
      url: e.url,
      description: e.description ?? '',
      mode: e.mode ?? '',
      events: Object.fromEntries((e.events ?? []).filter((t) => t !== 'inbound').map((t) => [t, true])),
      inbound: e.events?.includes('inbound') ?? false,
      enabled: e.enabled,
    });
  }

  protected async save(): Promise<void> {
    const d = this.draft();
    if (!d || this.busy()) return;
    const picked = EVENT_TYPES.filter((t) => d.events[t]);
    // Received emails only with their box; ticked alone, the endpoint gets only them.
    const events: Array<EventType | 'inbound'> | null = d.inbound ? [...picked, 'inbound'] : picked.length ? picked : null;
    const body = {
      url: d.url.trim(),
      description: d.description.trim() || null,
      mode: d.mode || null,
      events,
      ...(this.editing() && { enabled: d.enabled }),
    };
    await this.run(async () => {
      const editing = this.editing();
      if (editing) {
        const updated = await this.api.updateWebhookEndpoint(editing.id, body);
        this.endpoints.update((list) => list?.map((e) => (e.id === updated.id ? updated : e)) ?? null);
        this.toasts.show('Endpoint guardado');
      } else {
        const { secret, ...created } = await this.api.createWebhookEndpoint(body);
        this.endpoints.update((list) => [...(list ?? []), created]);
        this.secretOf.set({ endpoint: created, secret });
      }
      this.draft.set(null);
    });
  }

  protected async test(e: WebhookEndpoint): Promise<void> {
    await this.run(async () => {
      const attempt = await this.api.testWebhook(e.id);
      if (attempt.ok) this.toasts.show(`El endpoint respondió ${attempt.statusCode} en ${attempt.durationMs} ms`);
      else this.toasts.error(new Error(`El evento de prueba falló: ${attempt.statusCode ? `HTTP ${attempt.statusCode}` : attempt.error}`));
      this.tested.emit();
    });
  }

  protected async showSecret(e: WebhookEndpoint): Promise<void> {
    await this.run(async () => this.secretOf.set({ endpoint: e, secret: (await this.api.webhookEndpointSecret(e.id)).secret }));
  }

  protected async rotate(e: WebhookEndpoint): Promise<void> {
    await this.run(async () => {
      this.secretOf.set({ endpoint: e, secret: (await this.api.rotateWebhookEndpointSecret(e.id)).secret });
      this.toasts.show('Secreto rotado: el anterior ya no vale');
    });
  }

  protected async remove(): Promise<void> {
    const e = this.removing();
    if (!e) return;
    await this.run(async () => {
      await this.api.deleteWebhookEndpoint(e.id);
      this.endpoints.update((list) => list?.filter((x) => x.id !== e.id) ?? null);
      this.removing.set(null);
      this.toasts.show('Endpoint borrado');
    });
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
