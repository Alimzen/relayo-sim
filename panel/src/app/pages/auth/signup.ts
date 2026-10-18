import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { Session } from '../../core/session';
import { Brand } from '../../ui/ui';
import { safeNext } from './login';

@Component({
  selector: 'app-signup',
  imports: [FormsModule, RouterLink, Brand],
  template: `
    <main class="auth">
      <app-brand />
      @if (closed()) {
        <div class="card auth-card">
          <h1>Registro cerrado</h1>
          <p class="lede">Esta instalación de Relayo Sim no admite cuentas nuevas. Pide acceso a quien la administra.</p>
          <a class="btn btn-block" routerLink="/login">Volver a entrar</a>
        </div>
      } @else {
        <form class="card auth-card" (ngSubmit)="submit()">
          <h1>Crear cuenta</h1>
          <p class="lede">Te creamos un primer proyecto con su clave de API.</p>

          @if (error()) {
            <p class="form-error" role="alert">{{ error() }}</p>
          }

          <div class="field">
            <label for="name">Nombre</label>
            <input id="name" class="input" name="name" autocomplete="name" required [(ngModel)]="name" />
          </div>
          <div class="field">
            <label for="email">Correo electrónico</label>
            <input id="email" class="input" type="email" name="email" autocomplete="email" required [(ngModel)]="email" />
          </div>
          <div class="field">
            <label for="password">Contraseña</label>
            <input
              id="password"
              class="input"
              type="password"
              name="password"
              autocomplete="new-password"
              required
              [minlength]="minPassword()"
              [(ngModel)]="password"
            />
            <span class="hint">Al menos {{ minPassword() }} caracteres.</span>
          </div>

          <button class="btn btn-primary btn-block" type="submit" [disabled]="busy()">
            {{ busy() ? 'Creando cuenta…' : 'Crear cuenta' }}
          </button>
        </form>
        <p class="auth-alt">¿Ya tienes cuenta? <a routerLink="/login" [queryParams]="next() ? { next: next() } : {}">Entrar</a></p>
      }
    </main>
  `,
})
export class SignupPage {
  readonly next = input<string>();
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  protected name = '';
  protected email = '';
  protected password = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly closed = signal(false);
  protected readonly minPassword = signal(10);

  constructor() {
    this.api.authConfig().then(
      (c) => {
        this.closed.set(!c.signup);
        this.minPassword.set(c.minPassword);
      },
      () => undefined,
    );
  }

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    if (this.password.length < this.minPassword()) {
      this.error.set(`La contraseña debe tener al menos ${this.minPassword()} caracteres.`);
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      const { user, projects } = await this.api.signup(this.name.trim(), this.email.trim(), this.password);
      this.session.set(user, projects);
      await this.router.navigateByUrl(safeNext(this.next()));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
