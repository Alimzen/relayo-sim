import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LucideLogOut, LucideTrash, LucideUserPlus, LucideUsers } from '@lucide/angular';
import { Api } from '../core/api';
import { timeAgo } from '../core/format';
import { Session } from '../core/session';
import type { ProjectRole, TeamView } from '../core/types';
import { Badge, EmptyState, Modal, Toasts } from '../ui/ui';

const ROLES: Record<ProjectRole, string> = { owner: 'Dueño', admin: 'Administrador', member: 'Miembro' };

/** Who has access to the project, the pending invitations, and inviting more people. */
@Component({
  selector: 'app-team',
  imports: [FormsModule, Badge, EmptyState, Modal, LucideLogOut, LucideTrash, LucideUserPlus, LucideUsers],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Equipo</h1>
          <p>
            Quién trabaja en este proyecto. Los administradores lo gestionan todo; los miembros ven los mensajes, envían y
            editan plantillas, pero no tocan claves, conexiones, dominios ni webhooks.
          </p>
        </div>
        @if (role() !== 'owner') {
          <button type="button" class="btn" (click)="leaving.set(true)"><svg lucideLogOut [size]="15"></svg>Salir del proyecto</button>
        }
      </header>

      <div class="stack">
        @if (admin()) {
          <form class="card card-pad row invite-row" (ngSubmit)="invite()">
            <input class="input" type="email" name="email" required [(ngModel)]="email" placeholder="persona@empresa.com" aria-label="Email" />
            <select class="select invite-role" name="role" [(ngModel)]="inviteRole" aria-label="Rol">
              <option value="member">Miembro</option>
              <option value="admin">Administrador</option>
            </select>
            <button type="submit" class="btn btn-primary" [disabled]="busy() || !email.trim()"><svg lucideUserPlus [size]="15"></svg>Invitar</button>
          </form>
        }

        <section class="card">
          @if (team() === null) {
            <div class="card-body stack"><div class="skeleton"></div><div class="skeleton"></div></div>
          } @else {
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr><th>Persona</th><th>Rol</th><th>Desde</th><th><span class="sr-only">Acciones</span></th></tr>
                </thead>
                <tbody>
                  @for (m of team()!.members; track m.userId) {
                    <tr>
                      <td class="cell-main">
                        {{ m.name }}@if (m.userId === me()) {<span class="muted"> (tú)</span>}
                        <div class="muted small">{{ m.email }}</div>
                      </td>
                      <td>
                        @if (admin() && m.role !== 'owner') {
                          <select class="select select-sm" [ngModel]="m.role" (ngModelChange)="changeRole(m.userId, $event)" [attr.aria-label]="'Rol de ' + m.name">
                            <option value="member">Miembro</option>
                            <option value="admin">Administrador</option>
                          </select>
                        } @else {
                          <app-badge [tone]="m.role === 'owner' ? 'info' : 'neutral'">{{ label(m.role) }}</app-badge>
                        }
                      </td>
                      <td class="muted small nowrap">{{ ago(m.since) }}</td>
                      <td>
                        @if (admin() && m.role !== 'owner' && m.userId !== me()) {
                          <button type="button" class="icon-button" (click)="removing.set(m)" [attr.aria-label]="'Quitar a ' + m.name" title="Quitar">
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

        @if (team()?.invites?.length) {
          <section class="card">
            <header class="card-head"><h2>Invitaciones pendientes</h2></header>
            <div class="table-wrap">
              <table class="table">
                <tbody>
                  @for (i of team()!.invites; track i.id) {
                    <tr>
                      <td class="cell-main">{{ i.email }}</td>
                      <td><app-badge tone="neutral">{{ label(i.role) }}</app-badge></td>
                      <td class="muted small">caduca {{ ago(i.expiresAt) }}</td>
                      <td>
                        @if (admin()) {
                          <button type="button" class="btn btn-sm" (click)="revoke(i.id)" [disabled]="busy()">Anular</button>
                        }
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        } @else if (team() && team()!.members.length === 1) {
          <div class="card">
            <app-empty heading="Trabajas solo en este proyecto">
              <svg icon lucideUsers [size]="20"></svg>
              Invita a tu equipo por email: les llega un enlace para unirse, válido 7 días.
            </app-empty>
          </div>
        }
      </div>
    </div>

    <app-modal heading="Quitar del proyecto" [open]="!!removing()" (closed)="removing.set(null)">
      <p class="text-2"><strong>{{ removing()?.name }}</strong> dejará de ver este proyecto al momento.</p>
      <div class="modal-actions">
        <button type="button" class="btn" (click)="removing.set(null)">Cancelar</button>
        <button type="button" class="btn btn-danger" (click)="remove()" [disabled]="busy()">Quitar</button>
      </div>
    </app-modal>

    <app-modal heading="Salir del proyecto" [open]="leaving()" (closed)="leaving.set(false)">
      <p class="text-2">Dejarás de ver «{{ session.project()?.name }}». Para volver, alguien tendrá que invitarte otra vez.</p>
      <div class="modal-actions">
        <button type="button" class="btn" (click)="leaving.set(false)">Cancelar</button>
        <button type="button" class="btn btn-danger" (click)="leave()" [disabled]="busy()">Salir</button>
      </div>
    </app-modal>
  `,
})
export class TeamPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  private readonly router = inject(Router);
  protected readonly session = inject(Session);
  protected readonly team = signal<TeamView | null>(null);
  protected readonly busy = signal(false);
  protected readonly removing = signal<TeamView['members'][number] | null>(null);
  protected readonly leaving = signal(false);
  protected readonly role = computed(() => this.session.project()?.role ?? 'owner');
  protected readonly admin = computed(() => this.role() !== 'member');
  protected readonly me = computed(() => this.session.user()?.id);
  protected readonly ago = (value: string) => timeAgo(value);
  protected readonly label = (role: ProjectRole) => ROLES[role];
  protected email = '';
  protected inviteRole: 'admin' | 'member' = 'member';

  constructor() {
    void this.load();
  }

  protected async invite(): Promise<void> {
    await this.run(async () => {
      const invite = await this.api.inviteMember(this.email.trim(), this.inviteRole);
      this.toasts.show(`Invitación enviada a ${invite.email}`);
      this.email = '';
    });
  }

  protected async revoke(id: string): Promise<void> {
    await this.run(() => this.api.revokeInvite(id));
  }

  protected async changeRole(userId: string, role: 'admin' | 'member'): Promise<void> {
    await this.run(async () => {
      await this.api.changeMemberRole(userId, role);
      this.toasts.show('Rol cambiado');
    });
  }

  protected async remove(): Promise<void> {
    const member = this.removing();
    if (!member) return;
    await this.run(async () => {
      await this.api.removeMember(member.userId);
      this.removing.set(null);
    });
  }

  protected async leave(): Promise<void> {
    const project = this.session.project();
    if (!project || this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.removeMember('me');
      this.session.projects.update((list) => list.filter((p) => p.id !== project.id));
      this.session.select(null);
      this.leaving.set(false);
      this.toasts.show(`Has salido de «${project.name}»`);
      await this.router.navigateByUrl('/overview');
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  private async run(action: () => Promise<unknown>): Promise<void> {
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
      this.team.set(await this.api.team());
    } catch (error) {
      this.toasts.error(error);
    }
  }
}
