import { Component, inject, input, signal, type OnInit } from '@angular/core';
import { RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { Session } from '../../core/session';
import { Brand } from '../../ui/ui';

@Component({
  selector: 'app-verify-email',
  imports: [RouterLink, Brand],
  template: `
    <main class="auth">
      <a href="/" class="brand-link" aria-label="Relayo, inicio"><app-brand /></a>
      <div class="card auth-card">
        @switch (state()) {
          @case ('working') {
            <h1>Confirmando tu email…</h1>
            <div class="skeleton"></div>
          }
          @case ('done') {
            <h1>Email confirmado</h1>
            <p class="lede">Ya puedes usar el modo en vivo: conexiones, claves <code>rly_live_</code> y envíos reales.</p>
            <a class="btn btn-primary btn-block" routerLink="/overview">Ir al panel</a>
          }
          @default {
            <h1>No se pudo confirmar</h1>
            <p class="lede">{{ error() || 'Abre el enlace tal como llegó en el correo.' }}</p>
            <a class="btn btn-primary btn-block" routerLink="/overview">Ir al panel y pedir otro enlace</a>
          }
        }
      </div>
    </main>
  `,
})
export class VerifyEmailPage implements OnInit {
  readonly token = input<string>();
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  protected readonly state = signal<'working' | 'done' | 'failed'>('working');
  protected readonly error = signal('');

  async ngOnInit(): Promise<void> {
    const token = this.token();
    if (!token) {
      this.state.set('failed');
      return;
    }
    try {
      const { user } = await this.api.verifyEmail(token);
      // Signed in (often, in the same browser): the panel should stop asking for it.
      if (this.session.user()?.id === user.id) this.session.user.set(user);
      this.state.set('done');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
      this.state.set('failed');
    }
  }
}
