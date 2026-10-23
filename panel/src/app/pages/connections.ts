import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideArrowDown, LucideArrowUp, LucidePencil, LucidePlug, LucidePlus, LucideSend, LucideTrash } from '@lucide/angular';
import { Api } from '../core/api';
import { Session } from '../core/session';
import type { Connection, Provider } from '../core/types';
import { Badge, CopyButton, EmptyState, Modal, Toasts } from '../ui/ui';

@Component({
  selector: 'app-connections',
  imports: [
    FormsModule,
    RouterLink,
    Badge,
    CopyButton,
    EmptyState,
    Modal,
    LucideArrowDown,
    LucideArrowUp,
    LucidePencil,
    LucidePlug,
    LucidePlus,
    LucideSend,
    LucideTrash,
  ],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Conexiones</h1>
          <p>
            Tus cuentas de proveedor para el modo en vivo. Las claves <code>rly_live_…</code> entregan por la primera de cada canal
            (email o SMS); si falla, prueban la siguiente. Las credenciales se guardan cifradas.
          </p>
        </div>
        <button type="button" class="btn btn-primary" (click)="openCreate()"><svg lucidePlus [size]="15"></svg>Añadir conexión</button>
      </header>

      <section class="card">
        @if (connections() === null) {
          <div class="card-body stack"><div class="skeleton"></div><div class="skeleton"></div></div>
        } @else if (connections()!.length === 0) {
          <app-empty heading="Sin conexiones">
            <svg icon lucidePlug [size]="20"></svg>
            Conecta SES, SendGrid, Resend, Postmark, Mailgun, un servidor SMTP o Twilio para enviar de verdad con una clave
            <a routerLink="/keys">en vivo</a>. Mientras tanto, las claves de prueba siguen simulando.
          </app-empty>
        } @else {
          @for (group of groups(); track group.channel) {
            @if (groups().length > 1) {
              <h2 class="connection-group">{{ group.label }}</h2>
            }
          @for (c of group.items; track c.id; let i = $index; let last = $last) {
            <article class="connection">
              <div class="connection-order">
                <button type="button" class="icon-button" [disabled]="i === 0" (click)="move(group.items, i, -1)" aria-label="Subir"><svg lucideArrowUp [size]="14"></svg></button>
                <span class="connection-rank">{{ i + 1 }}</span>
                <button type="button" class="icon-button" [disabled]="last" (click)="move(group.items, i, 1)" aria-label="Bajar"><svg lucideArrowDown [size]="14"></svg></button>
              </div>
              <div>
                <div class="connection-title">
                  <strong>{{ c.name }}</strong>
                  <span class="chip">{{ c.providerLabel }}</span>
                  <app-badge [tone]="i === 0 ? 'good' : 'neutral'">{{ i === 0 ? 'Principal' : 'Respaldo ' + i }}</app-badge>
                  @if (c.pausedUntil) {
                    <app-badge tone="serious" [attr.title]="'Falló varias veces seguidas: se prueba la última hasta ' + time(c.pausedUntil)">En pausa</app-badge>
                  }
                </div>
                <p class="connection-meta">{{ summary(c) }}</p>
                @if (c.webhooks.supported) {
                  <div class="inbound">
                    <span class="label">URL de eventos</span>
                    <div class="secret"><code>{{ origin + c.inboundPath }}</code><app-copy [value]="origin + c.inboundPath" label="Copiar URL" /></div>
                    <span class="hint">{{ c.webhooks.help }}</span>
                  </div>
                } @else {
                  <p class="hint">{{ c.webhooks.help }}</p>
                }
              </div>
              <div class="connection-actions">
                <button type="button" class="icon-button" (click)="openTest(c)" title="Enviar una prueba" [attr.aria-label]="'Probar ' + c.name"><svg lucideSend [size]="15"></svg></button>
                <button type="button" class="icon-button" (click)="openEdit(c)" title="Editar" [attr.aria-label]="'Editar ' + c.name"><svg lucidePencil [size]="15"></svg></button>
                <button type="button" class="icon-button" (click)="removing.set(c)" title="Eliminar" [attr.aria-label]="'Eliminar ' + c.name"><svg lucideTrash [size]="15"></svg></button>
              </div>
            </article>
          }
          }
        }
      </section>
    </div>

    <app-modal [heading]="editing() ? 'Editar «' + editing()!.name + '»' : 'Añadir conexión'" [open]="formOpen()" (closed)="formOpen.set(false)">
      <form (ngSubmit)="save()">
        @if (!editing()) {
          <div class="field">
            <label for="provider">Proveedor</label>
            <select id="provider" class="select" name="provider" [ngModel]="providerName()" (ngModelChange)="pick($event)">
              @for (p of providers(); track p.name) {
                <option [value]="p.name">{{ p.label }}</option>
              }
            </select>
          </div>
        }
        <div class="field">
          <label for="name">Nombre</label>
          <input id="name" class="input" name="name" [(ngModel)]="name" [placeholder]="spec()?.label ?? ''" />
        </div>
        @if (spec()?.name === 'managed') {
          <p class="callout callout-info">
            Relayo envía por su propio servidor, firmando con DKIM tu dominio. Antes de enviar, verifica el dominio de tu
            remitente en <a routerLink="/domains" (click)="formOpen.set(false)">Dominios</a>.
          </p>
        }
        @for (f of spec()?.fields ?? []; track f.key) {
          <div class="field">
            <label [for]="'f-' + f.key">{{ f.label }}@if (!f.required) {<span class="muted"> (opcional)</span>}</label>
            @if (f.options) {
              <select class="select" [id]="'f-' + f.key" [name]="f.key" [(ngModel)]="values[f.key]">
                <option value="">Por defecto</option>
                @for (o of f.options; track o) {
                  <option [value]="o">{{ o }}</option>
                }
              </select>
            } @else {
              <input
                class="input"
                [class.mono]="f.secret"
                [id]="'f-' + f.key"
                [name]="f.key"
                [type]="f.secret ? 'password' : 'text'"
                autocomplete="off"
                [(ngModel)]="values[f.key]"
                [placeholder]="f.secret && editing()?.secretsSet?.includes(f.key) ? '•••••••• (sin cambios)' : (f.placeholder ?? '')"
              />
            }
            @if (f.help) {
              <span class="hint">{{ f.help }}</span>
            }
          </div>
        }
        <div class="modal-actions">
          <button type="button" class="btn" (click)="formOpen.set(false)">Cancelar</button>
          <button type="submit" class="btn btn-primary" [disabled]="busy()">{{ editing() ? 'Guardar' : 'Añadir conexión' }}</button>
        </div>
      </form>
    </app-modal>

    <app-modal [heading]="'Probar «' + (testing()?.name ?? '') + '»'" [open]="!!testing()" (closed)="testing.set(null)">
      <form (ngSubmit)="test()">
        @if (testing()?.channel === 'sms') {
          <p class="text-2 modal-lede">Se envía un SMS real por esta conexión, desde el número configurado en ella.</p>
          <div class="field">
            <label for="test-phone">Para</label>
            <input id="test-phone" class="input" type="tel" name="phone" required [(ngModel)]="testPhone" placeholder="+34600111222" />
            <span class="hint">En formato internacional, con el prefijo del país.</span>
          </div>
        } @else {
          <p class="text-2 modal-lede">Se envía un correo real por esta conexión. El remitente debe ser de un dominio verificado en el proveedor.</p>
          <div class="field">
            <label for="test-from">Remitente</label>
            <input id="test-from" class="input" type="email" name="from" required [(ngModel)]="testFrom" placeholder="no-reply@tudominio.com" />
          </div>
          <div class="field">
            <label for="test-to">Para</label>
            <input id="test-to" class="input" type="email" name="to" required [(ngModel)]="testTo" />
          </div>
        }
        <div class="modal-actions">
          <button type="button" class="btn" (click)="testing.set(null)">Cancelar</button>
          <button type="submit" class="btn btn-primary" [disabled]="busy()"><svg lucideSend [size]="14"></svg>Enviar prueba</button>
        </div>
      </form>
    </app-modal>

    <app-modal heading="Eliminar conexión" [open]="!!removing()" (closed)="removing.set(null)">
      <p class="text-2">
        Se borra <strong>{{ removing()?.name }}</strong> con sus credenciales. Los envíos en vivo pasarán a la siguiente conexión, y
        su URL de eventos dejará de funcionar.
      </p>
      <div class="modal-actions">
        <button type="button" class="btn" (click)="removing.set(null)">Cancelar</button>
        <button type="button" class="btn btn-danger" (click)="remove()" [disabled]="busy()">Eliminar</button>
      </div>
    </app-modal>
  `,
})
export class ConnectionsPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly session = inject(Session);
  protected readonly origin = location.origin;
  protected readonly connections = signal<Connection[] | null>(null);
  /** Each channel has its own failover order. */
  protected readonly groups = computed(() => {
    const all = this.connections() ?? [];
    return [
      { channel: 'email', label: 'Email', items: all.filter((c) => c.channel !== 'sms') },
      { channel: 'sms', label: 'SMS', items: all.filter((c) => c.channel === 'sms') },
    ].filter((g) => g.items.length);
  });
  protected readonly providers = signal<Provider[]>([]);
  protected readonly providerName = signal('ses');
  protected readonly spec = computed(() =>
    this.editing()
      ? this.providers().find((p) => p.name === this.editing()!.provider)
      : this.providers().find((p) => p.name === this.providerName()),
  );
  protected readonly formOpen = signal(false);
  protected readonly editing = signal<Connection | null>(null);
  protected readonly testing = signal<Connection | null>(null);
  protected readonly removing = signal<Connection | null>(null);
  protected readonly busy = signal(false);
  protected name = '';
  protected values: Record<string, string> = {};
  protected testFrom = '';
  protected testTo = this.session.user()?.email ?? '';
  protected testPhone = '';

  constructor() {
    void this.load();
    this.api.providers().then(
      (list) => {
        this.providers.set(list);
        // Relayo's own sending comes first when the platform offers it.
        if (list[0]) this.providerName.set(list[0].name);
      },
      (error) => this.toasts.error(error),
    );
  }

  protected time(value: string): string {
    return new Date(value).toLocaleTimeString();
  }

  protected summary(c: Connection): string {
    const s = c.settings;
    switch (c.provider) {
      case 'smtp':
        return `${s['username'] ? `${s['username']} · ` : ''}${s['host']}:${s['port']} (${s['security'] ?? 'starttls'})`;
      case 'ses':
        return `${s['region']} · ${s['accessKeyId']}${s['configurationSetName'] ? ` · ${s['configurationSetName']}` : ' · sin configuration set (sin eventos)'}`;
      case 'mailgun':
        return `${s['domain']} · región ${s['region'] ?? 'us'}`;
      case 'twilio':
        return `${s['accountSid']} · ${s['messagingServiceSid'] ? `Messaging Service ${s['messagingServiceSid']}` : s['from']}`;
      default:
        return Object.entries(s).map(([k, v]) => `${k}: ${v}`).join(' · ') || 'Credenciales guardadas';
    }
  }

  protected pick(name: string): void {
    this.providerName.set(name);
    this.values = {};
  }

  protected openCreate(): void {
    this.editing.set(null);
    this.name = '';
    this.values = {};
    this.formOpen.set(true);
  }

  protected openEdit(c: Connection): void {
    this.editing.set(c);
    this.name = c.name;
    this.values = { ...c.settings };
    this.formOpen.set(true);
  }

  protected openTest(c: Connection): void {
    this.testing.set(c);
    this.testFrom = c.settings['username']?.includes('@') ? c.settings['username'] : this.testFrom;
  }

  protected async save(): Promise<void> {
    await this.run(async () => {
      const values = Object.fromEntries(Object.entries(this.values).filter(([, v]) => v?.trim()));
      const editing = this.editing();
      if (editing) {
        await this.api.updateConnection(editing.id, { name: this.name.trim(), values });
        this.toasts.show('Conexión guardada');
      } else {
        await this.api.createConnection({ name: this.name.trim(), provider: this.providerName(), values });
        this.toasts.show('Conexión añadida');
      }
      this.formOpen.set(false);
      await this.load();
    });
  }

  protected async move(group: Connection[], index: number, step: -1 | 1): Promise<void> {
    const list = [...group];
    const [item] = list.splice(index, 1);
    list.splice(index + step, 0, item!);
    const moved = new Set(list.map((c) => c.id));
    this.connections.update((all) => [...(all ?? []).filter((c) => !moved.has(c.id)), ...list]);
    await this.run(() => this.api.reorderConnections(list.map((c) => c.id)));
  }

  protected async test(): Promise<void> {
    const connection = this.testing();
    if (!connection) return;
    await this.run(async () => {
      const sms = connection.channel === 'sms';
      await this.api.testConnection(connection.id, sms ? { to: this.testPhone.trim() } : { to: this.testTo.trim(), from: this.testFrom.trim() });
      this.testing.set(null);
      this.toasts.show(sms ? 'Prueba enviada: revisa el teléfono' : 'Prueba enviada: revisa la bandeja de entrada');
    });
  }

  protected async remove(): Promise<void> {
    const connection = this.removing();
    if (!connection) return;
    await this.run(async () => {
      await this.api.deleteConnection(connection.id);
      this.removing.set(null);
      this.toasts.show(`Conexión «${connection.name}» eliminada`);
      await this.load();
    });
  }

  private async load(): Promise<void> {
    try {
      this.connections.set(await this.api.connections());
    } catch (error) {
      this.connections.update((c) => c ?? []);
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
