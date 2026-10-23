import { Component, computed, effect, inject, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { LucideSend, LucideZap } from '@lucide/angular';
import { Api } from '../core/api';
import { Session } from '../core/session';
import type { Template } from '../core/types';
import { Toasts } from '../ui/ui';

type Channel = 'email' | 'sms';

/** One message written by hand: simulated in test mode, delivered for real in live mode. */
@Component({
  selector: 'app-compose',
  imports: [FormsModule, RouterLink, LucideSend, LucideZap],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Enviar</h1>
          <p>Un mensaje escrito a mano, por la API de este proyecto. Para probar escenarios concretos, usa <a routerLink="/scenarios">Escenarios</a>.</p>
        </div>
        <div class="segmented" role="group" aria-label="Canal">
          <button type="button" [attr.aria-pressed]="channel() === 'email'" (click)="channel.set('email')">Email</button>
          <button type="button" [attr.aria-pressed]="channel() === 'sms'" (click)="channel.set('sms')">SMS</button>
        </div>
      </header>

      <div class="stack">
        @if (live()) {
          <div class="callout callout-good">
            <svg lucideZap [size]="15"></svg>
            <span>Modo en vivo: se entrega de verdad, por las <a routerLink="/connections">conexiones</a> del proyecto, y cuenta en su límite de envíos reales.</span>
          </div>
        } @else {
          <div class="callout callout-info">Modo de prueba: el envío se simula y no sale a ningún destinatario real.</div>
        }

        <section class="card">
          <form class="card-body" (ngSubmit)="send()">
            @if (ownTemplates().length) {
              <div class="field">
                <label for="template">Plantilla <span class="muted">(opcional)</span></label>
                <select id="template" class="select" name="template" [(ngModel)]="template" (ngModelChange)="pickTemplate($event)">
                  <option value="">Escribir el mensaje</option>
                  @for (t of ownTemplates(); track t.id) {
                    <option [value]="t.alias">{{ t.alias }}{{ t.name !== t.alias ? ' · ' + t.name : '' }}</option>
                  }
                </select>
              </div>
            }
            @if (channel() === 'email') {
              <div class="two-col">
                <div class="field">
                  <label for="from">Remitente</label>
                  <input id="from" class="input" type="email" name="from" required [(ngModel)]="from" placeholder="hola@tudominio.com" />
                  @if (live()) {
                    <span class="hint">De un dominio verificado en tu proveedor (o en Dominios, con el envío de Relayo).</span>
                  }
                </div>
                <div class="field">
                  <label for="fromName">Nombre del remitente <span class="muted">(opcional)</span></label>
                  <input id="fromName" class="input" name="fromName" [(ngModel)]="fromName" placeholder="Tu empresa" />
                </div>
              </div>
              <div class="field">
                <label for="to">Para</label>
                <input id="to" class="input" name="to" required [(ngModel)]="to" placeholder="ana@ejemplo.com, luis@ejemplo.com" />
                <span class="hint">Varias direcciones separadas por comas: reciben el mismo mensaje.</span>
              </div>
              @if (!template) {
                <div class="field">
                  <label for="subject">Asunto</label>
                  <input id="subject" class="input" name="subject" required [(ngModel)]="subject" />
                </div>
                <div class="field">
                  <label for="text">Texto</label>
                  <textarea id="text" class="input textarea" name="text" rows="8" [(ngModel)]="text"></textarea>
                </div>
                <details class="compose-html">
                  <summary>Versión HTML <span class="muted">(opcional)</span></summary>
                  <textarea class="input textarea mono" name="html" rows="8" [(ngModel)]="html" placeholder="<p>Hola</p>" aria-label="HTML"></textarea>
                </details>
              }
            } @else {
              <div class="two-col">
                <div class="field">
                  <label for="sms-to">Para</label>
                  <input id="sms-to" class="input" name="smsTo" required [(ngModel)]="smsTo" placeholder="+34600111222" />
                  <span class="hint">En formato internacional; varios separados por comas.</span>
                </div>
                <div class="field">
                  <label for="sms-from">Remitente <span class="muted">(opcional)</span></label>
                  <input id="sms-from" class="input" name="smsFrom" maxlength="15" [(ngModel)]="smsFrom" placeholder="Por defecto, el de la conexión" />
                </div>
              </div>
              @if (!template) {
                <div class="field">
                  <label for="sms-body">Mensaje</label>
                  <textarea id="sms-body" class="input textarea" name="smsBody" rows="4" maxlength="1600" required [(ngModel)]="smsBody"></textarea>
                  <span class="hint">{{ smsBody.length }} / 1600 caracteres · {{ segments() }} {{ segments() === 1 ? 'segmento' : 'segmentos' }}</span>
                </div>
              }
            }
            @if (template) {
              <div class="field">
                <label for="variables">Variables</label>
                <textarea id="variables" class="input textarea mono" name="variables" rows="5" [(ngModel)]="variables"></textarea>
                <span class="hint">Un objeto JSON con el valor de cada variable de la plantilla.</span>
              </div>
            }

            <div class="row send-row">
              <span class="spacer"></span>
              <button type="submit" class="btn btn-primary" [disabled]="busy()">
                <svg lucideSend [size]="14"></svg>{{ live() ? (channel() === 'email' ? 'Enviar correo real' : 'Enviar SMS real') : 'Enviar (simulado)' }}
              </button>
            </div>
          </form>
        </section>
      </div>
    </div>
  `,
})
export class ComposePage {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  protected readonly live = computed(() => this.session.mode() === 'live');
  protected readonly channel = signal<Channel>('email');
  protected readonly busy = signal(false);
  protected from = '';
  protected fromName = '';
  protected to = '';
  protected subject = '';
  protected text = '';
  protected html = '';
  protected smsTo = '';
  protected smsFrom = '';
  protected smsBody = '';
  protected template = '';
  protected variables = '{}';
  private readonly allTemplates = signal<Template[]>([]);
  /** The project's templates for the channel being written. */
  protected readonly ownTemplates = computed(() => this.allTemplates().filter((t) => t.channel === this.channel()));

  constructor() {
    this.api.templates().then(
      (list) => this.allTemplates.set(list),
      () => undefined,
    );
    // Each channel has its own templates.
    effect(() => {
      this.channel();
      untracked(() => (this.template = ''));
    });
  }

  /** Fills the variables field with the template's variables, ready to give them a value. */
  protected pickTemplate(alias: string): void {
    const template = this.allTemplates().find((t) => t.alias === alias);
    this.variables = template ? JSON.stringify(Object.fromEntries(template.variables.map((v) => [v, ''])), null, 2) : '{}';
  }

  /** SMS parts the carrier bills: 160 GSM characters, or 70 when the text needs Unicode. */
  protected segments(): number {
    const unicode = /[^\n\r -~¡£¤¥§¿ÄÅÆÇÉÑÖØÜßàäåæèéìñòöøùü]/.test(this.smsBody);
    const single = unicode ? 70 : 160;
    const multi = unicode ? 67 : 153;
    const length = this.smsBody.length;
    return length <= single ? 1 : Math.ceil(length / multi);
  }

  protected async send(): Promise<void> {
    if (this.busy()) return;
    const list = (value: string) =>
      value
        .split(/[,;\s]+/)
        .map((v) => v.trim())
        .filter(Boolean);
    this.busy.set(true);
    try {
      let id: string;
      let variables: Record<string, unknown> = {};
      if (this.template) {
        try {
          variables = JSON.parse(this.variables || '{}') as Record<string, unknown>;
        } catch {
          throw new Error('Las variables deben ser un objeto JSON, como {"nombre": "Ana"}');
        }
      }
      const content = this.template ? { template: this.template, variables } : undefined;
      if (this.channel() === 'email') {
        const to = list(this.to);
        if (!to.length) throw new Error('Añade al menos un destinatario');
        if (!content && !this.text.trim() && !this.html.trim()) throw new Error('Escribe el texto o el HTML del mensaje');
        ({ id } = await this.api.sendMessage({
          from: this.fromName.trim() ? { address: this.from.trim(), name: this.fromName.trim() } : this.from.trim(),
          to,
          ...(content ?? {
            subject: this.subject,
            ...(this.text.trim() && { text: this.text }),
            ...(this.html.trim() && { html: this.html }),
          }),
        }));
      } else {
        const to = list(this.smsTo);
        if (!to.length) throw new Error('Añade al menos un número');
        ({ id } = await this.api.sendSmsMessage({ to, ...(content ?? { body: this.smsBody }), ...(this.smsFrom.trim() && { from: this.smsFrom.trim() }) }));
      }
      this.toasts.show(this.live() ? 'Enviado: sigue su estado en Mensajes' : 'Envío simulado');
      await this.router.navigate(['/messages', id]);
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}
