import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SimApi } from '../api.service';

@Component({
  selector: 'app-login',
  template: `
    <main class="login">
      <form class="card" (submit)="submit($event)">
        <h1>Relayo Sim</h1>
        <p class="muted">Entra con la API key de tu proyecto para ver sus mensajes y su línea de tiempo.</p>
        <label>
          API key
          <input
            type="password"
            autocomplete="off"
            placeholder="sim_live_..."
            [value]="apiKey()"
            (input)="apiKey.set($any($event.target).value)"
            required
          />
        </label>
        @if (error()) {
          <p class="error" role="alert">{{ error() }}</p>
        }
        <button type="submit" [disabled]="busy() || !apiKey().trim()">{{ busy() ? 'Entrando…' : 'Entrar' }}</button>
        <p class="hint">La clave se guarda solo en esta pestaña del navegador.</p>
      </form>
    </main>
  `,
})
export class LoginPage {
  private readonly api = inject(SimApi);
  private readonly router = inject(Router);
  protected readonly apiKey = signal('');
  protected readonly busy = signal(false);
  protected readonly error = signal<string | null>(null);

  async submit(event: Event): Promise<void> {
    event.preventDefault();
    this.busy.set(true);
    this.error.set(null);
    try {
      await this.api.signIn(this.apiKey());
      await this.router.navigateByUrl('/messages');
    } catch (error) {
      this.error.set(error instanceof Error && error.message.includes('API key') ? 'La API key no es válida' : (error as Error).message);
    } finally {
      this.busy.set(false);
    }
  }
}
