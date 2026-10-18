import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { LucideSend } from '@lucide/angular';
import { Api } from '../core/api';
import type { Scenario } from '../core/types';
import { CopyButton, Toasts } from '../ui/ui';

const GROUPS: Array<{ title: string; names: string[] }> = [
  { title: 'Entrega', names: ['delivered', 'delay', 'engaged'] },
  { title: 'Rebotes', names: ['hard-bounce', 'no-mx', 'mailbox-full', 'too-large', 'timeout'] },
  { title: 'Bloqueos', names: ['blocked', 'blocklisted', 'dmarc', 'suppressed'] },
  { title: 'Aplazamientos', names: ['greylist', 'rate-limit'] },
  { title: 'Después de la entrega', names: ['complaint', 'unsubscribe'] },
];

const DESCRIPTIONS: Record<string, string> = {
  delivered: 'Aceptado y entregado. Cualquier dirección que no sea un escenario se comporta así.',
  'hard-bounce': 'El buzón no existe: 550 5.1.1.',
  'no-mx': 'El dominio no puede recibir correo: 550 5.1.2.',
  'mailbox-full': 'Buzón lleno: 452 4.2.2 en cada intento. Por la API se aplaza dos veces y acaba en rebote suave.',
  greylist: 'Greylisting: 451 4.7.1 hasta el intento N (2 por defecto) y luego se acepta. greylist+3@ acepta el tercero.',
  blocked: 'Rechazado por la política del receptor: 550 5.7.1. Un bloqueo, no una dirección mala.',
  blocklisted: 'Tu IP de envío está en una lista negra: 554 5.7.1 … zen.spamhaus.org.',
  dmarc: 'Fallo de SPF/DKIM/DMARC después de DATA: 550 5.7.26.',
  'too-large': 'Mensaje demasiado grande, después de DATA: 552 5.3.4.',
  'rate-limit': 'El receptor te limita: 421 4.7.28. Por la API se aplaza y después se entrega.',
  timeout: 'El receptor nunca responde a DATA y el cliente SMTP agota el tiempo. Por la API, rebote suave.',
  delay: 'Se entrega tarde: delay+30m@ (s, m o h; 5m por defecto), aplazado mientras tanto.',
  complaint: 'Se entrega y después lo marcan como spam.',
  unsubscribe: 'Se entrega y después el destinatario se da de baja.',
  engaged: 'Se entrega, se abre y se hace clic.',
  suppressed: 'Está en la lista de supresión: nunca se intenta.',
};

const DOMAIN = 'sim.relayo.dev';

@Component({
  selector: 'app-scenarios',
  imports: [FormsModule, CopyButton, LucideSend],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Escenarios</h1>
          <p>
            Cada dirección <code>escenario&#64;{{ domain }}</code> provoca un resultado distinto. Añade
            <code>+async</code> para que SMTP acepte y el rebote llegue después.
          </p>
        </div>
      </header>

      <div class="stack">
        <section class="card">
          <header class="card-head">
            <div>
              <h2>Enviar una prueba</h2>
              <p class="muted small">Se envía por la API con este proyecto; verás el mensaje y sus eventos al momento.</p>
            </div>
          </header>
          <form class="card-body" (ngSubmit)="send()">
            <div class="two-col">
              <div class="field">
                <label for="scenario">Escenario</label>
                <select id="scenario" class="select" name="scenario" [(ngModel)]="selected">
                  @for (group of groups(); track group.title) {
                    <optgroup [label]="group.title">
                      @for (s of group.items; track s.name) {
                        <option [value]="s.name">{{ s.name }}</option>
                      }
                    </optgroup>
                  }
                </select>
              </div>
              <div class="field">
                <label for="param">Parámetro <span class="muted">(opcional)</span></label>
                <input id="param" class="input mono" name="param" [(ngModel)]="param" placeholder="p. ej. 3, 30m, async" />
              </div>
              <div class="field">
                <label for="from">Remitente</label>
                <input id="from" class="input" type="email" name="from" required [(ngModel)]="from" />
              </div>
              <div class="field">
                <label for="subject">Asunto</label>
                <input id="subject" class="input" name="subject" [(ngModel)]="subject" [placeholder]="'Prueba de ' + selected" />
              </div>
            </div>
            <div class="row send-row">
              <span class="muted small">Para: <code>{{ address() }}</code></span>
              <span class="spacer"></span>
              <button type="submit" class="btn btn-primary" [disabled]="busy()"><svg lucideSend [size]="14"></svg>Enviar prueba</button>
            </div>
          </form>
        </section>

        @for (group of groups(); track group.title) {
          <section class="card">
            <header class="card-head"><h2>{{ group.title }}</h2></header>
            <div class="table-wrap">
              <table class="table">
                <tbody>
                  @for (s of group.items; track s.name) {
                    <tr class="scenario-row">
                      <td>
                        <div class="row">
                          <code>{{ s.example }}</code>
                          <app-copy [value]="s.example" label="Copiar dirección" />
                        </div>
                      </td>
                      <td class="text-2">{{ describe(s) }}</td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          </section>
        }
      </div>
    </div>
  `,
})
export class ScenariosPage {
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  protected readonly domain = DOMAIN;
  protected readonly scenarios = signal<Scenario[]>([]);
  protected readonly busy = signal(false);
  protected selected = 'delivered';
  protected param = '';
  protected from = 'app@example.com';
  protected subject = '';

  protected readonly groups = computed(() => {
    const byName = new Map(this.scenarios().map((s) => [s.name, s]));
    const grouped = GROUPS.map((g) => ({ title: g.title, items: g.names.flatMap((n) => byName.get(n) ?? []) }));
    const known = new Set(GROUPS.flatMap((g) => g.names));
    const others = this.scenarios().filter((s) => !known.has(s.name));
    if (others.length) grouped.push({ title: 'Otros', items: others });
    return grouped.filter((g) => g.items.length);
  });

  constructor() {
    this.api.scenarios().then(
      (list) => this.scenarios.set(list),
      (error) => this.toasts.error(error),
    );
  }

  protected address(): string {
    const param = this.param.trim();
    return `${this.selected}${param ? `+${param}` : ''}@${DOMAIN}`;
  }

  protected describe(s: Scenario): string {
    return DESCRIPTIONS[s.name] ?? s.description;
  }

  protected async send(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const { id } = await this.api.send({
        from: this.from.trim(),
        to: [this.address()],
        subject: this.subject.trim() || `Prueba de ${this.selected}`,
        text: 'Mensaje de prueba enviado desde el panel de Relayo Sim.',
      });
      this.toasts.show('Mensaje enviado');
      await this.router.navigate(['/messages', id]);
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}
