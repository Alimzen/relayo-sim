import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideExternalLink, LucidePlus } from '@lucide/angular';
import { Api } from '../core/api';
import { fullDate } from '../core/format';
import type { Incident, IncidentStatus, StatusComponent } from '../core/types';
import { Badge, Modal, Toasts } from '../ui/ui';

const COMPONENTS: Array<{ id: StatusComponent; label: string }> = [
  { id: 'api', label: 'API y panel' },
  { id: 'database', label: 'Base de datos' },
  { id: 'queues', label: 'Colas y webhooks' },
  { id: 'smtp', label: 'SMTP' },
];

const STATUSES: Record<IncidentStatus, string> = {
  investigating: 'Investigando',
  identified: 'Identificado',
  monitoring: 'En observación',
  resolved: 'Resuelto',
};

const IMPACTS: Record<Incident['impact'], string> = { minor: 'Leve', major: 'Grave', critical: 'Crítico' };

/** Platform admins: the incidents the public status page (/status) shows. */
@Component({
  selector: 'app-admin-incidents',
  imports: [FormsModule, Badge, Modal, LucideExternalLink, LucidePlus],
  styles: ':host { display: block; margin-top: 20px; }',
  template: `
    <section class="card">
      <header class="card-head">
        <div>
          <h2>Incidencias</h2>
          <p class="muted small">
            Lo que muestra la <a href="/status" target="_blank" rel="noopener">página de estado <svg lucideExternalLink [size]="12"></svg></a>, además de
            las comprobaciones de cada minuto.
          </p>
        </div>
        <button type="button" class="btn btn-sm" (click)="startNew()"><svg lucidePlus [size]="14"></svg>Abrir incidencia</button>
      </header>
      @if (incidents(); as list) {
        @if (list.length) {
          <div class="table-wrap">
            <table class="table">
              <thead>
                <tr><th>Incidencia</th><th>Impacto</th><th>Estado</th><th>Última actualización</th><th><span class="sr-only">Acciones</span></th></tr>
              </thead>
              <tbody>
                @for (i of list; track i.id) {
                  <tr>
                    <td class="cell-main">
                      {{ i.title }}
                      <div class="muted small">{{ componentsOf(i) }}</div>
                    </td>
                    <td><app-badge [tone]="i.impact === 'minor' ? 'warning' : 'critical'">{{ impacts[i.impact] }}</app-badge></td>
                    <td><app-badge [tone]="i.status === 'resolved' ? 'good' : 'info'">{{ statuses[i.status] }}</app-badge></td>
                    <td class="small">
                      {{ i.updates[i.updates.length - 1]!.message }}
                      <div class="muted small">{{ full(i.updates[i.updates.length - 1]!.at) }}</div>
                    </td>
                    <td>
                      @if (i.status !== 'resolved') {
                        <button type="button" class="btn btn-sm" (click)="startUpdate(i)">Actualizar</button>
                      }
                    </td>
                  </tr>
                }
              </tbody>
            </table>
          </div>
        } @else {
          <div class="card-body"><p class="muted small">Ninguna en los últimos 90 días.</p></div>
        }
      } @else {
        <div class="card-body stack"><div class="skeleton"></div></div>
      }
    </section>

    <app-modal heading="Abrir incidencia" [open]="opening()" (closed)="opening.set(false)">
      <form (ngSubmit)="open()">
        <div class="field">
          <label for="inc-title">Título</label>
          <input id="inc-title" class="input" name="title" required maxlength="120" [(ngModel)]="draft.title" placeholder="Retrasos en la entrega de webhooks" />
        </div>
        <div class="field">
          <label for="inc-impact">Impacto</label>
          <select id="inc-impact" class="input" name="impact" [(ngModel)]="draft.impact">
            <option value="minor">Leve: algo va lento o falla a veces</option>
            <option value="major">Grave: un componente no funciona</option>
            <option value="critical">Crítico: la plataforma no funciona</option>
          </select>
        </div>
        <fieldset class="field">
          <legend class="label">Afecta a</legend>
          <div class="check-grid">
            @for (c of components; track c.id) {
              <label class="check"><input type="checkbox" [name]="'c-' + c.id" [(ngModel)]="draft.components[c.id]" />{{ c.label }}</label>
            }
          </div>
        </fieldset>
        <div class="field">
          <label for="inc-message">Primer mensaje</label>
          <textarea id="inc-message" class="input textarea" name="message" rows="3" required [(ngModel)]="draft.message" placeholder="Estamos investigando…"></textarea>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" (click)="opening.set(false)">Cancelar</button>
          <button type="submit" class="btn btn-primary" [disabled]="busy() || !draft.title.trim() || !draft.message.trim()">Publicar</button>
        </div>
      </form>
    </app-modal>

    <app-modal [heading]="'Actualizar «' + (updating()?.title ?? '') + '»'" [open]="!!updating()" (closed)="updating.set(null)">
      <form (ngSubmit)="update()">
        <div class="field">
          <label for="inc-status">Estado</label>
          <select id="inc-status" class="input" name="status" [(ngModel)]="next.status">
            @for (s of statusList; track s) {
              <option [value]="s">{{ statuses[s] }}</option>
            }
          </select>
        </div>
        <div class="field">
          <label for="inc-update">Mensaje</label>
          <textarea id="inc-update" class="input textarea" name="message" rows="3" required [(ngModel)]="next.message"></textarea>
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" (click)="updating.set(null)">Cancelar</button>
          <button type="submit" class="btn btn-primary" [disabled]="busy() || !next.message.trim()">Publicar</button>
        </div>
      </form>
    </app-modal>
  `,
})
export class AdminIncidents {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly incidents = signal<Incident[] | null>(null);
  protected readonly opening = signal(false);
  protected readonly updating = signal<Incident | null>(null);
  protected readonly busy = signal(false);
  protected readonly components = COMPONENTS;
  protected readonly statuses = STATUSES;
  protected readonly impacts = IMPACTS;
  protected readonly statusList = Object.keys(STATUSES) as IncidentStatus[];
  protected readonly full = (value: string) => fullDate(value);
  protected draft = { title: '', impact: 'minor' as Incident['impact'], components: {} as Partial<Record<StatusComponent, boolean>>, message: '' };
  protected next = { status: 'identified' as IncidentStatus, message: '' };

  constructor() {
    void this.load();
  }

  protected componentsOf(i: Incident): string {
    return i.components.map((id) => COMPONENTS.find((c) => c.id === id)?.label ?? id).join(', ');
  }

  protected startNew(): void {
    this.draft = { title: '', impact: 'minor', components: { api: true }, message: '' };
    this.opening.set(true);
  }

  protected startUpdate(i: Incident): void {
    this.next = { status: i.status === 'investigating' ? 'identified' : i.status === 'identified' ? 'monitoring' : 'resolved', message: '' };
    this.updating.set(i);
  }

  protected async open(): Promise<void> {
    const components = COMPONENTS.filter((c) => this.draft.components[c.id]).map((c) => c.id);
    if (!components.length) {
      this.toasts.error(new Error('Elige al menos un componente.'));
      return;
    }
    await this.run(async () => {
      await this.api.openIncident({ title: this.draft.title.trim(), impact: this.draft.impact, components, status: 'investigating', message: this.draft.message.trim() });
      this.opening.set(false);
      this.toasts.show('Incidencia publicada en la página de estado');
    });
  }

  protected async update(): Promise<void> {
    const incident = this.updating();
    if (!incident) return;
    await this.run(async () => {
      await this.api.updateIncident(incident.id, { status: this.next.status, message: this.next.message.trim() });
      this.updating.set(null);
      this.toasts.show(this.next.status === 'resolved' ? 'Incidencia resuelta' : 'Actualización publicada');
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await action();
      await this.load();
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  private async load(): Promise<void> {
    try {
      this.incidents.set(await this.api.incidents());
    } catch (error) {
      this.incidents.set([]);
      this.toasts.error(error);
    }
  }
}
