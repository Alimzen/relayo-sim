import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { Session } from '../../core/session';
import { Brand } from '../../ui/ui';

@Component({
  selector: 'app-reset-password',
  imports: [FormsModule, RouterLink, Brand],
  template: `
    <main class="auth">
      <a href="/" class="brand-link" aria-label="Relayo Sim, inicio"><app-brand /></a>
      @if (!token()) {
        <div class="card auth-card">
          <h1>Enlace incompleto</h1>
          <p class="lede">Abre el enlace tal como llegó en el correo, o pide uno nuevo.</p>
          <a class="btn btn-primary btn-block" routerLink="/forgot-password">Pedir otro enlace</a>
        </div>
      } @else {
        <form class="card auth-card" (ngSubmit)="submit()">
          <h1>Elige una contraseña nueva</h1>
          <p class="lede">Al guardarla se cerrarán las demás sesiones de tu cuenta.</p>

          @if (error()) {
            <p class="form-error" role="alert">
              {{ error() }}
              @if (expired()) {
                <a routerLink="/forgot-password">Pedir otro enlace</a>
              }
            </p>
          }

          <div class="field">
            <label for="password">Contraseña nueva</label>
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

          <button class="btn btn-primary btn-block" type="submit" [disabled]="busy() || !password">
            {{ busy() ? 'Guardando…' : 'Guardar y entrar' }}
          </button>
        </form>
      }
    </main>
  `,
})
export class ResetPasswordPage {
  readonly token = input<string>();
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  protected password = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly expired = signal(false);
  protected readonly minPassword = signal(10);

  constructor() {
    this.api.authConfig().then(
      (c) => this.minPassword.set(c.minPassword),
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
    this.expired.set(false);
    try {
      const { user, projects } = await this.api.resetPassword(this.token()!, this.password);
      this.session.set(user, projects);
      await this.router.navigateByUrl('/overview');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
      this.expired.set(/caducado/.test(String(error)));
    } finally {
      this.busy.set(false);
    }
  }
}
