import { Component, inject, signal } from '@angular/core';
import { Router } from '@angular/router';
import { SimApi, type Scenario } from '../api.service';

@Component({
  selector: 'app-scenarios',
  template: `
    <header class="page-head">
      <div>
        <h1>Escenarios</h1>
        <p class="muted">
          Envía a una de estas direcciones (o pon la cabecera <code>X-Sim-Scenario</code>) y el simulador responde como el mundo real.
          Cualquier otra dirección se entrega con normalidad.
        </p>
      </div>
    </header>

    <form class="card send" (submit)="send($event)">
      <h2>Enviar una prueba</h2>
      <div class="grid">
        <label>
          Para
          <input [value]="to()" (input)="to.set($any($event.target).value)" placeholder="hard-bounce@sim.relayo.dev" required />
        </label>
        <label>
          De
          <input [value]="from()" (input)="from.set($any($event.target).value)" required />
        </label>
      </div>
      <label>
        Asunto
        <input [value]="subject()" (input)="subject.set($any($event.target).value)" />
      </label>
      @if (sendError()) {
        <p class="error" role="alert">{{ sendError() }}</p>
      }
      <button type="submit" [disabled]="sending() || !to().trim()">{{ sending() ? 'Enviando…' : 'Enviar' }}</button>
    </form>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }
    <div class="scenario-grid">
      @for (scenario of scenarios(); track scenario.name) {
        <article class="card scenario">
          <h3><code>{{ scenario.name }}</code></h3>
          <p>{{ scenario.description }}</p>
          <div class="scenario-actions">
            <button type="button" class="ghost" (click)="copy(scenario.example)">
              {{ copied() === scenario.example ? 'Copiado' : 'Copiar dirección' }}
            </button>
            <button type="button" class="ghost" (click)="to.set(scenario.example)">Usar</button>
          </div>
          <code class="example">{{ scenario.example }}</code>
        </article>
      }
    </div>
  `,
})
export class ScenariosPage {
  private readonly api = inject(SimApi);
  private readonly router = inject(Router);
  protected readonly scenarios = signal<Scenario[]>([]);
  protected readonly error = signal<string | null>(null);
  protected readonly copied = signal<string | null>(null);

  protected readonly to = signal('hard-bounce@sim.relayo.dev');
  protected readonly from = signal('pruebas@empresa.com');
  protected readonly subject = signal('Prueba desde el panel');
  protected readonly sending = signal(false);
  protected readonly sendError = signal<string | null>(null);

  constructor() {
    this.api.scenarios().then(
      (list) => this.scenarios.set(list),
      (error: Error) => this.error.set(error.message),
    );
  }

  protected async copy(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text);
      this.copied.set(text);
      setTimeout(() => this.copied.set(null), 1500);
    } catch {
      this.copied.set(null);
    }
  }

  protected async send(event: Event): Promise<void> {
    event.preventDefault();
    this.sending.set(true);
    this.sendError.set(null);
    try {
      const to = this.to()
        .split(',')
        .map((a) => a.trim())
        .filter(Boolean);
      const { id } = await this.api.send({ from: this.from().trim(), to, subject: this.subject(), text: 'Enviado desde el panel de Relayo Sim.' });
      await this.router.navigate(['/messages', id]);
    } catch (error) {
      this.sendError.set((error as Error).message);
    } finally {
      this.sending.set(false);
    }
  }
}
