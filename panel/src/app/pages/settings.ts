import { Component, inject, signal } from '@angular/core';
import { SimApi, type Project } from '../api.service';

@Component({
  selector: 'app-settings',
  template: `
    <header class="page-head">
      <div>
        <h1>Proyecto</h1>
        <p class="muted">Dónde se envían los eventos y cómo conectarse al simulador.</p>
      </div>
    </header>

    @if (error()) {
      <p class="error" role="alert">{{ error() }}</p>
    }

    @if (project(); as p) {
      <form class="card" (submit)="save($event)">
        <h2>Webhook</h2>
        <p class="muted">Cada evento se envía con un POST firmado (<code>Relayo-Signature</code>) a esta URL.</p>
        <label>
          URL
          <input type="url" [value]="webhookUrl()" (input)="webhookUrl.set($any($event.target).value)" placeholder="https://tu-app.com/webhooks/relayo" />
        </label>
        <button type="submit" [disabled]="saving()">{{ saving() ? 'Guardando…' : 'Guardar' }}</button>
        @if (saved()) {
          <span class="ok-text" role="status">Guardado</span>
        }
      </form>

      <form class="card" (submit)="saveReports($event)">
        <h2>Informes por correo</h2>
        <p class="muted">
          Como un servidor real, el simulador envía un DSN por cada rebote o aplazamiento y un informe ARF por cada queja
          al remitente del sobre de cada mensaje, a través de este servidor SMTP (tu buzón de rebotes, Mailpit…).
          Escenarios con <code>+async</code> (p. ej. <code>hard-bounce+async&#64;</code>) aceptan por SMTP y rebotan después.
        </p>
        <label>
          Servidor SMTP
          <input [value]="reportsSmtpUrl()" (input)="reportsSmtpUrl.set($any($event.target).value)" placeholder="smtp://usuario:clave@mail.tu-dominio.com:587" />
        </label>
        @if (p.reportsSmtpUrl) {
          <p class="hint">Configurado: <code>{{ p.reportsSmtpUrl }}</code>. Déjalo vacío y guarda para desactivarlo.</p>
        }
        <button type="submit" [disabled]="saving()">{{ saving() ? 'Guardando…' : 'Guardar' }}</button>
      </form>

      <section class="card">
        <h2>Conexión</h2>
        <dl class="facts">
          <div><dt>Proyecto</dt><dd>{{ p.name }} · <code>{{ p.id }}</code></dd></div>
          <div><dt>API</dt><dd><code>POST {{ origin }}/v1/messages</code> con <code>Authorization: Bearer &lt;API key&gt;</code></dd></div>
          <div><dt>SMTP</dt><dd><code>{{ host }}:2525</code> · usuario cualquiera · contraseña: tu API key</dd></div>
          <div><dt>Driver Relayo</dt><dd><code>simulator({{ '{' }} apiKey, baseUrl: '{{ origin }}', webhook: {{ '{' }} secret {{ '}' }} {{ '}' }})</code></dd></div>
        </dl>
      </section>
    }
  `,
})
export class SettingsPage {
  private readonly api = inject(SimApi);
  protected readonly project = signal<Project | null>(null);
  protected readonly webhookUrl = signal('');
  protected readonly reportsSmtpUrl = signal('');
  protected readonly error = signal<string | null>(null);
  protected readonly saving = signal(false);
  protected readonly saved = signal(false);
  protected readonly origin = location.origin;
  protected readonly host = location.hostname;

  constructor() {
    this.api.project().then(
      (p) => {
        this.project.set(p);
        this.webhookUrl.set(p.webhookUrl ?? '');
      },
      (error: Error) => this.error.set(error.message),
    );
  }

  protected save(event: Event): Promise<void> {
    event.preventDefault();
    return this.update({ webhookUrl: this.webhookUrl().trim() || null });
  }

  protected async saveReports(event: Event): Promise<void> {
    event.preventDefault();
    await this.update({ reportsSmtpUrl: this.reportsSmtpUrl().trim() || null });
    // The stored URL is shown masked; keep the field empty rather than echoing the password back.
    this.reportsSmtpUrl.set('');
  }

  private async update(changes: { webhookUrl?: string | null; reportsSmtpUrl?: string | null }): Promise<void> {
    this.saving.set(true);
    this.saved.set(false);
    this.error.set(null);
    try {
      this.project.set(await this.api.updateProject(changes));
      this.saved.set(true);
    } catch (error) {
      this.error.set((error as Error).message);
    } finally {
      this.saving.set(false);
    }
  }
}
