import { DatePipe } from '@angular/common';
import { Component, DestroyRef, inject, signal } from '@angular/core';
import { RouterLink } from '@angular/router';
import { SimApi, type SimMessage } from '../api.service';
import { scenarioLabel } from '../events';

const REFRESH_MS = 3000;

@Component({
  selector: 'app-messages',
  imports: [RouterLink, DatePipe],
  template: `
    <header class="page-head">
      <div>
        <h1>Mensajes</h1>
        <p class="muted">Los últimos mensajes recibidos por SMTP o por la API. Se actualiza solo.</p>
      </div>
      <a class="button" routerLink="/scenarios">Enviar una prueba</a>
    </header>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    @if (messages(); as list) {
      @if (list.length === 0) {
        <div class="empty card">
          <p>Todavía no hay mensajes.</p>
          <p class="muted">Envía uno desde <a routerLink="/scenarios">Escenarios</a>, por SMTP o con el driver <code>simulator()</code>.</p>
        </div>
      } @else {
        <div class="table-wrap card">
          <table>
            <thead>
              <tr>
                <th>Fecha</th>
                <th>Destinatario</th>
                <th>Escenario</th>
                <th>Asunto</th>
                <th>Vía</th>
              </tr>
            </thead>
            <tbody>
              @for (message of list; track message.id) {
                <tr>
                  <td class="nowrap"><a [routerLink]="['/messages', message.id]">{{ message.createdAt | date: 'dd/MM HH:mm:ss' }}</a></td>
                  <td>
                    {{ message.recipients[0]?.address }}
                    @if (message.recipients.length > 1) {
                      <span class="muted">+{{ message.recipients.length - 1 }}</span>
                    }
                  </td>
                  <td><code>{{ scenario(message) }}</code></td>
                  <td class="truncate">{{ message.subject || '—' }}</td>
                  <td><span class="tag">{{ message.via === 'smtp' ? 'SMTP' : 'API' }}</span></td>
                </tr>
              }
            </tbody>
          </table>
        </div>
      }
    } @else {
      <p class="muted">Cargando…</p>
    }
  `,
})
export class MessagesPage {
  private readonly api = inject(SimApi);
  protected readonly messages = signal<SimMessage[] | null>(null);
  protected readonly error = signal<string | null>(null);

  constructor() {
    void this.load();
    const timer = setInterval(() => void this.load(), REFRESH_MS);
    inject(DestroyRef).onDestroy(() => clearInterval(timer));
  }

  protected scenario(message: SimMessage): string {
    const first = message.recipients[0];
    return first ? scenarioLabel(first) : '—';
  }

  private async load(): Promise<void> {
    try {
      this.messages.set(await this.api.messages());
      this.error.set(null);
    } catch (error) {
      this.error.set((error as Error).message);
    }
  }
}
