import { Component, inject, signal, viewChild } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideEye, LucideEyeOff, LucideRefreshCw, LucideSend } from '@lucide/angular';
import { Api } from '../core/api';
import { Session } from '../core/session';
import { CopyButton, Modal, Toasts } from '../ui/ui';
import { WebhookDeliveries } from './webhook-deliveries';
import { WebhookEndpoints } from './webhook-endpoints';

@Component({
  selector: 'app-webhooks',
  imports: [FormsModule, CopyButton, Modal, WebhookDeliveries, WebhookEndpoints, LucideEye, LucideEyeOff, LucideRefreshCw, LucideSend],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Webhooks</h1>
          <p>Adónde llegan los eventos de este proyecto (simulados y reales), con qué se firman y qué respondió tu endpoint.</p>
        </div>
      </header>

      <div class="stack">
        <app-webhook-deliveries [hasUrl]="!!current().webhookUrl" />

        <form class="card" (ngSubmit)="saveWebhook()">
          <header class="card-head">
            <div>
              <h2>URL del webhook</h2>
              <p class="muted small">Cada evento llega como un POST con la cabecera <code>Relayo-Signature</code>.</p>
            </div>
          </header>
          <div class="card-body">
            <div class="field field-last">
              <label for="webhook-url">URL</label>
              <input
                id="webhook-url"
                class="input"
                type="url"
                name="webhookUrl"
                placeholder="https://tu-app.example/webhooks/relayo"
                [(ngModel)]="webhookUrl"
              />
              <span class="hint">Déjala vacía para no enviar webhooks; los eventos se siguen viendo en el panel.</span>
            </div>
          </div>
          <footer class="card-foot">
            <button type="button" class="btn btn-sm" (click)="test()" [disabled]="busy() || !current().webhookUrl">
              <svg lucideSend [size]="14"></svg>Enviar evento de prueba
            </button>
            <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy()">Guardar</button>
          </footer>
        </form>

        <app-webhook-endpoints (tested)="deliveries().reload()" />

        <section class="card">
          <header class="card-head">
            <div>
              <h2>Secreto de firma</h2>
              <p class="muted small">Pásalo como <code>webhook.secret</code> al driver <code>&#64;alimzen/relayo-cloud</code> o <code>&#64;alimzen/relayo-simulator</code> para verificar la firma.</p>
            </div>
          </header>
          <div class="card-body">
            <div class="secret">
              <code>{{ secret() ? (shown() ? secret() : mask) : '…' }}</code>
              <button type="button" class="icon-button" (click)="shown.set(!shown())" [attr.aria-label]="shown() ? 'Ocultar' : 'Mostrar'">
                @if (shown()) {
                  <svg lucideEyeOff [size]="15"></svg>
                } @else {
                  <svg lucideEye [size]="15"></svg>
                }
              </button>
              @if (secret()) {
                <app-copy [value]="secret()!" label="Copiar secreto" />
              }
            </div>
          </div>
          <footer class="card-foot">
            <span class="muted small">Al rotarlo, las firmas con el secreto anterior dejan de ser válidas.</span>
            <button type="button" class="btn btn-sm" (click)="rotating.set(true)"><svg lucideRefreshCw [size]="14"></svg>Rotar</button>
          </footer>
        </section>

        <form class="card" (ngSubmit)="saveReports()">
          <header class="card-head">
            <div>
              <h2>Informes por correo</h2>
              <p class="muted small">
                Opcional: el simulador envía además cada rebote como DSN y cada queja como informe ARF a este SMTP, para probar un
                buzón de rebotes.
              </p>
            </div>
          </header>
          <div class="card-body">
            @if (current().reportsSmtpUrl; as url) {
              <p class="small current-value">Ahora: <code>{{ url }}</code></p>
            }
            <div class="field field-last">
              <label for="reports-url">{{ current().reportsSmtpUrl ? 'Nueva URL SMTP' : 'URL SMTP' }}</label>
              <input
                id="reports-url"
                class="input mono"
                name="reportsSmtpUrl"
                autocomplete="off"
                placeholder="smtp://usuario:contraseña@smtp.example:587/rebotes@example.com"
                [(ngModel)]="reportsUrl"
              />
              <span class="hint">La contraseña no se vuelve a mostrar. La ruta es el buzón que recibe los informes.</span>
            </div>
          </div>
          <footer class="card-foot">
            @if (current().reportsSmtpUrl) {
              <button type="button" class="btn btn-sm btn-ghost danger-text" (click)="clearReports()" [disabled]="busy()">Desactivar</button>
            } @else {
              <span></span>
            }
            <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy() || !reportsUrl.trim()">Guardar</button>
          </footer>
        </form>
      </div>
    </div>

    <app-modal heading="Rotar el secreto" [open]="rotating()" (closed)="rotating.set(false)">
      <p class="text-2">
        Se genera un secreto nuevo y el actual deja de valer al momento. Tendrás que actualizarlo en tu aplicación.
      </p>
      <div class="modal-actions">
        <button type="button" class="btn" (click)="rotating.set(false)">Cancelar</button>
        <button type="button" class="btn btn-danger" (click)="rotate()" [disabled]="busy()">Rotar secreto</button>
      </div>
    </app-modal>
  `,
})
export class WebhooksPage {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly toasts = inject(Toasts);
  protected readonly current = () => this.session.project()!;
  protected readonly secret = signal<string | null>(null);
  protected readonly shown = signal(false);
  protected readonly rotating = signal(false);
  protected readonly busy = signal(false);
  protected readonly mask = '•'.repeat(32);
  protected webhookUrl = this.current().webhookUrl ?? '';
  protected readonly deliveries = viewChild.required(WebhookDeliveries);
  protected reportsUrl = '';

  constructor() {
    this.api.webhookSecret().then(
      ({ webhookSecret }) => this.secret.set(webhookSecret),
      (error) => this.toasts.error(error),
    );
  }

  protected async saveWebhook(): Promise<void> {
    await this.update({ webhookUrl: this.webhookUrl.trim() || null }, 'URL del webhook guardada');
  }

  /** A made-up `delivered` event (header `Relayo-Test: true`), to check the endpoint and its signature check. */
  protected async test(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const attempt = await this.api.testWebhook();
      if (attempt.ok) this.toasts.show(`Tu endpoint respondió ${attempt.statusCode} en ${attempt.durationMs} ms`);
      else this.toasts.error(new Error(`El evento de prueba falló: ${attempt.statusCode ? `HTTP ${attempt.statusCode}` : attempt.error}`));
      await this.deliveries().reload();
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected async saveReports(): Promise<void> {
    if (await this.update({ reportsSmtpUrl: this.reportsUrl.trim() }, 'Informes por correo activados')) this.reportsUrl = '';
  }

  protected async clearReports(): Promise<void> {
    await this.update({ reportsSmtpUrl: null }, 'Informes por correo desactivados');
  }

  protected async rotate(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const { webhookSecret } = await this.api.rotateWebhookSecret();
      this.secret.set(webhookSecret);
      this.shown.set(true);
      this.rotating.set(false);
      this.toasts.show('Secreto rotado');
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  private async update(changes: Parameters<Api['updateProject']>[0], done: string): Promise<boolean> {
    if (this.busy()) return false;
    this.busy.set(true);
    try {
      const project = await this.api.updateProject(changes);
      this.session.replaceProject(project);
      this.webhookUrl = project.webhookUrl ?? '';
      this.toasts.show(done);
      return true;
    } catch (error) {
      this.toasts.error(error);
      return false;
    } finally {
      this.busy.set(false);
    }
  }
}
