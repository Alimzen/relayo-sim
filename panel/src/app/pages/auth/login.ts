import { Component, inject, input, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { Session } from '../../core/session';
import { Brand } from '../../ui/ui';

/** Only same-site paths, so `?next=` cannot send anyone elsewhere. */
export function safeNext(next: string | undefined): string {
  return next && next.startsWith('/') && !next.startsWith('//') && !next.startsWith('/login') ? next : '/overview';
}

@Component({
  selector: 'app-login',
  imports: [FormsModule, RouterLink, Brand],
  template: `
    <main class="auth">
      <a href="/" class="brand-link" aria-label="Relayo Sim, inicio"><app-brand /></a>
      <form class="card auth-card" (ngSubmit)="submit()">
        <h1>Entrar</h1>
        <p class="lede">Accede a tus proyectos de Relayo Sim.</p>

        @if (error()) {
          <p class="form-error" role="alert">{{ error() }}</p>
        }

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
            autocomplete="current-password"
            required
            [(ngModel)]="password"
          />
        </div>

        <button class="btn btn-primary btn-block" type="submit" [disabled]="busy()">
          {{ busy() ? 'Entrando…' : 'Entrar' }}
        </button>
      </form>
      @if (signupOpen()) {
        <p class="auth-alt">¿No tienes cuenta? <a routerLink="/signup" [queryParams]="next() ? { next: next() } : {}">Crear una</a></p>
      }
    </main>
  `,
})
export class LoginPage {
  readonly next = input<string>();
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  protected email = '';
  protected password = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly signupOpen = signal(false);

  constructor() {
    this.api.authConfig().then(
      (c) => this.signupOpen.set(c.signup),
      () => undefined,
    );
  }

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      const { user, projects } = await this.api.login(this.email.trim(), this.password);
      this.session.set(user, projects);
      await this.router.navigateByUrl(safeNext(this.next()));
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
