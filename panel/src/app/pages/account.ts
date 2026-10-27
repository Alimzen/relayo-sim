import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { Api } from '../core/api';
import { Session } from '../core/session';
import { Modal, Toasts } from '../ui/ui';

@Component({
  selector: 'app-account',
  imports: [FormsModule, Modal],
  template: `
    <div class="page page-narrow">
      <header class="page-head">
        <div>
          <h1>Cuenta</h1>
          <p>Tus datos, tu contraseña, y qué hacer con tu cuenta.</p>
        </div>
      </header>

      <div class="stack">
        <form class="card" (ngSubmit)="saveProfile()">
          <header class="card-head"><h2>Perfil</h2></header>
          <div class="card-body">
            <div class="field">
              <label for="name">Nombre</label>
              <input id="name" class="input" name="name" required autocomplete="name" [(ngModel)]="name" />
            </div>
            <div class="field field-last">
              <label for="email">Correo electrónico</label>
              <input id="email" class="input" name="email" [value]="session.user()?.email" disabled />
            </div>
          </div>
          <footer class="card-foot">
            <span></span>
            <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy() || !name.trim() || name.trim() === session.user()?.name">
              Guardar
            </button>
          </footer>
        </form>

        <form class="card" (ngSubmit)="changePassword()">
          <header class="card-head">
            <div>
              <h2>Contraseña</h2>
              <p class="muted small">Al cambiarla se cierran tus otras sesiones.</p>
            </div>
          </header>
          <div class="card-body">
            @if (error()) {
              <p class="form-error" role="alert">{{ error() }}</p>
            }
            <div class="field">
              <label for="current">Contraseña actual</label>
              <input id="current" class="input" type="password" name="current" autocomplete="current-password" required [(ngModel)]="current" />
            </div>
            <div class="field field-last">
              <label for="next">Contraseña nueva</label>
              <input id="next" class="input" type="password" name="next" autocomplete="new-password" required [(ngModel)]="next" />
              <span class="hint">Al menos {{ minPassword() }} caracteres.</span>
            </div>
          </div>
          <footer class="card-foot">
            <span></span>
            <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy() || !current || !next">Cambiar contraseña</button>
          </footer>
        </form>

        <section class="card">
          <header class="card-head">
            <div>
              <h2>Tus datos</h2>
              <p class="muted small">
                Descarga en JSON todo lo que guardamos de tu cuenta y de tus proyectos: ajustes, plantillas, supresiones y los
                mensajes que aún se conservan. Sin contraseñas ni credenciales.
              </p>
            </div>
          </header>
          <footer class="card-foot">
            <span></span>
            <button type="button" class="btn btn-sm" (click)="exportData()" [disabled]="busy()">Exportar mis datos</button>
          </footer>
        </section>

        <section class="card danger-card">
          <header class="card-head">
            <div>
              <h2>Eliminar la cuenta</h2>
              <p class="muted small">
                Se borran tu cuenta y los proyectos de los que eres dueño, con todo lo que contienen. Dejas de tener acceso a
                los proyectos a los que te invitaron. No se puede deshacer.
              </p>
            </div>
          </header>
          <footer class="card-foot">
            <span></span>
            <button type="button" class="btn btn-sm btn-danger" (click)="deleting.set(true)">Eliminar mi cuenta</button>
          </footer>
        </section>
      </div>
    </div>

    <app-modal heading="Eliminar la cuenta" [open]="deleting()" (closed)="deleting.set(false)">
      <form (ngSubmit)="deleteAccount()">
        <p class="text-2 modal-lede">Escribe tu contraseña para confirmar. Te recomendamos exportar antes tus datos.</p>
        <div class="field">
          <label for="delete-password">Contraseña</label>
          <input id="delete-password" class="input" type="password" name="password" autocomplete="current-password" required [(ngModel)]="password" />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" (click)="deleting.set(false)">Cancelar</button>
          <button type="submit" class="btn btn-danger" [disabled]="busy() || !password">Eliminar para siempre</button>
        </div>
      </form>
    </app-modal>
  `,
})
export class AccountPage {
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly minPassword = signal(10);
  protected name = this.session.user()?.name ?? '';
  protected current = '';
  protected next = '';
  protected password = '';
  protected readonly deleting = signal(false);
  private readonly router = inject(Router);

  constructor() {
    this.api.authConfig().then(
      (c) => this.minPassword.set(c.minPassword),
      () => undefined,
    );
  }

  protected async saveProfile(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const { user } = await this.api.updateMe(this.name.trim());
      this.session.user.set(user);
      this.name = user.name;
      this.toasts.show('Perfil guardado');
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected async exportData(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.exportAccount();
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected async deleteAccount(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.deleteAccount(this.password);
      this.session.clear();
      await this.router.navigateByUrl('/login');
      this.toasts.show('Tu cuenta se ha eliminado');
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected async changePassword(): Promise<void> {
    if (this.busy()) return;
    if (this.next.length < this.minPassword()) {
      this.error.set(`La contraseña nueva debe tener al menos ${this.minPassword()} caracteres.`);
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.changePassword(this.current, this.next);
      this.current = '';
      this.next = '';
      this.toasts.show('Contraseña cambiada');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
