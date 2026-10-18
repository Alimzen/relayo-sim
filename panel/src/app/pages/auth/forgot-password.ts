import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { LucideMailCheck } from '@lucide/angular';
import { Api } from '../../core/api';
import { Brand } from '../../ui/ui';

@Component({
  selector: 'app-forgot-password',
  imports: [FormsModule, RouterLink, Brand, LucideMailCheck],
  template: `
    <main class="auth">
      <a href="/" class="brand-link" aria-label="Relayo Sim, inicio"><app-brand /></a>
      @if (sentTo()) {
        <div class="card auth-card">
          <span class="auth-icon" aria-hidden="true"><svg lucideMailCheck [size]="20"></svg></span>
          <h1>Revisa tu correo</h1>
          <p class="lede">
            Si existe una cuenta con <strong>{{ sentTo() }}</strong>, te enviamos un enlace para elegir una contraseña nueva.
            Caduca en una hora.
          </p>
          <a class="btn btn-block" routerLink="/login">Volver a entrar</a>
        </div>
      } @else {
        <form class="card auth-card" (ngSubmit)="submit()">
          <h1>¿Olvidaste tu contraseña?</h1>
          <p class="lede">Escribe el correo de tu cuenta y te enviamos un enlace para elegir otra.</p>

          @if (error()) {
            <p class="form-error" role="alert">{{ error() }}</p>
          }

          <div class="field">
            <label for="email">Correo electrónico</label>
            <input id="email" class="input" type="email" name="email" autocomplete="email" required [(ngModel)]="email" />
          </div>

          <button class="btn btn-primary btn-block" type="submit" [disabled]="busy() || !email.trim()">
            {{ busy() ? 'Enviando…' : 'Enviar enlace' }}
          </button>
        </form>
        <p class="auth-alt"><a routerLink="/login">Volver a entrar</a></p>
      }
    </main>
  `,
})
export class ForgotPasswordPage {
  private readonly api = inject(Api);
  protected email = '';
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly sentTo = signal('');

  protected async submit(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.forgotPassword(this.email.trim());
      this.sentTo.set(this.email.trim());
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
