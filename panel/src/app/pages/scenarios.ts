import { Component, computed, effect, inject, input, signal, untracked } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router, RouterLink } from '@angular/router';
import { LucidePlus, LucideSend, LucideX } from '@lucide/angular';
import { Api } from '../core/api';
import type { Scenario } from '../core/types';
import { CopyButton, Toasts } from '../ui/ui';

const EMAIL_GROUPS: Array<{ title: string; names: string[] }> = [
  { title: 'Entrega', names: ['delivered', 'delay', 'engaged'] },
  { title: 'Rebotes', names: ['hard-bounce', 'no-mx', 'mailbox-full', 'too-large', 'timeout'] },
  { title: 'Bloqueos', names: ['blocked', 'blocklisted', 'dmarc', 'suppressed'] },
  { title: 'Aplazamientos', names: ['greylist', 'rate-limit'] },
  { title: 'Después de la entrega', names: ['complaint', 'unsubscribe'] },
];

const SMS_GROUPS: Array<{ title: string; names: string[] }> = [
  { title: 'Entrega', names: ['delivered', 'delay'] },
  { title: 'Rebotes', names: ['invalid-number', 'landline', 'unreachable'] },
  { title: 'Bloqueos', names: ['carrier-filtered', 'suppressed'] },
  { title: 'Después de la entrega', names: ['opt-out'] },
];

const EMAIL_DESCRIPTIONS: Record<string, string> = {
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

const SMS_DESCRIPTIONS: Record<string, string> = {
  delivered: 'Entregado al teléfono. Cualquier número que no sea un escenario se comporta así.',
  'invalid-number': 'El número no existe: rebote duro, deja de escribirle (error 30005).',
  landline: 'Es un fijo y no puede recibir SMS: rebote duro (error 30006).',
  unreachable: 'Teléfono apagado o sin cobertura: se aplaza dos veces y acaba en rebote suave (error 30003).',
  'carrier-filtered': 'El operador lo filtra como spam: un bloqueo, revisa el contenido y el remitente (error 30007).',
  'opt-out': 'Se entrega y después el destinatario responde STOP: una baja.',
  suppressed: 'Ya había respondido STOP antes: rechazado, nunca se envía.',
  delay: 'Se entrega tarde, a los 30 segundos, aplazado mientras tanto.',
};

const DOMAIN = 'sim.relayo.dev';

type Channel = 'email' | 'sms';

@Component({
  selector: 'app-scenarios',
  imports: [FormsModule, RouterLink, CopyButton, LucidePlus, LucideSend, LucideX],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Escenarios</h1>
          @if (channel() === 'email') {
            <p>
              Cada dirección <code>escenario&#64;{{ domain }}</code> provoca un resultado distinto. Añade
              <code>+async</code> para que SMTP acepte y el rebote llegue después.
            </p>
          } @else {
            <p>Cada número provoca un resultado distinto. Son números ficticios (555-01XX): ningún teléfono real los recibe.</p>
          }
        </div>
        <div class="segmented" role="group" aria-label="Canal">
          <button type="button" [attr.aria-pressed]="channel() === 'email'" [routerLink]="[]" [queryParams]="{ channel: null }" replaceUrl>Email</button>
          <button type="button" [attr.aria-pressed]="channel() === 'sms'" [routerLink]="[]" [queryParams]="{ channel: 'sms' }" replaceUrl>SMS</button>
        </div>
      </header>

      <div class="stack">
        <section class="card">
          <header class="card-head">
            <div>
              <h2>{{ channel() === 'email' ? 'Enviar un correo de prueba' : 'Enviar un SMS de prueba' }}</h2>
              <p class="muted small">Por la API con este proyecto: un solo envío a todos los destinatarios de la lista, y cada uno sigue su escenario.</p>
            </div>
          </header>
          <form class="card-body" (ngSubmit)="send()">
            <div class="two-col">
              <div class="field">
                <label for="scenario">Escenario</label>
                <div class="row">
                  <select id="scenario" class="select" name="scenario" [(ngModel)]="selected">
                    @for (group of groups(); track group.title) {
                      <optgroup [label]="group.title">
                        @for (s of group.items; track s.name) {
                          <option [value]="s.name">{{ s.name }}</option>
                        }
                      </optgroup>
                    }
                  </select>
                  @if (channel() === 'email') {
                    <input class="input mono param-input" name="param" [(ngModel)]="param" placeholder="+param" aria-label="Parámetro (opcional)" />
                  }
                  <button type="button" class="btn" (click)="add()"><svg lucidePlus [size]="14"></svg>Añadir</button>
                </div>
              </div>
              <div class="field">
                <label for="from">Remitente</label>
                @if (channel() === 'email') {
                  <input id="from" class="input" type="email" name="from" required [(ngModel)]="from" />
                } @else {
                  <input id="from" class="input" name="smsFrom" maxlength="15" [(ngModel)]="smsFrom" placeholder="Empresa o +12015550199" />
                }
              </div>
            </div>

            <div class="field">
              <span class="label">Para ({{ recipients().length }})</span>
              <div class="recipients">
                @for (r of recipients(); track r) {
                  <span class="chip mono recipient">
                    {{ r }}
                    <button type="button" class="chip-remove" (click)="remove(r)" [attr.aria-label]="'Quitar ' + r"><svg lucideX [size]="12"></svg></button>
                  </span>
                } @empty {
                  <span class="muted small">Añade al menos un destinatario.</span>
                }
              </div>
            </div>

            @if (channel() === 'email') {
              <div class="field">
                <label for="subject">Asunto</label>
                <input id="subject" class="input" name="subject" [(ngModel)]="subject" placeholder="Prueba de Relayo Sim" />
              </div>
            } @else {
              <div class="field">
                <label for="body">Mensaje</label>
                <textarea id="body" class="input textarea" name="body" rows="3" maxlength="1600" [(ngModel)]="body"></textarea>
                <span class="hint">{{ body.length }} / 1600 caracteres</span>
              </div>
            }

            <div class="row send-row">
              <span class="spacer"></span>
              <button type="submit" class="btn btn-primary" [disabled]="busy() || !recipients().length">
                <svg lucideSend [size]="14"></svg>{{ channel() === 'email' ? 'Enviar correo' : 'Enviar SMS' }}
              </button>
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
                          <app-copy [value]="s.example" [label]="channel() === 'email' ? 'Copiar dirección' : 'Copiar número'" />
                          @if (channel() === 'sms') {
                            <span class="chip">{{ s.name }}</span>
                          }
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
  /** Query param `?channel=sms`; email otherwise. */
  readonly channelParam = input<string>(undefined, { alias: 'channel' });
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  protected readonly domain = DOMAIN;
  protected readonly scenarios = signal<Scenario[]>([]);
  protected readonly busy = signal(false);
  protected readonly channel = computed<Channel>(() => (this.channelParam() === 'sms' ? 'sms' : 'email'));
  private readonly lists = { email: signal<string[]>([`delivered@${DOMAIN}`]), sms: signal<string[]>(['+12015550100']) };
  protected readonly recipients = computed(() => this.lists[this.channel()]());
  protected selected = 'delivered';
  protected param = '';
  protected from = 'app@example.com';
  protected smsFrom = 'RelayoSim';
  protected subject = '';
  protected body = 'Tu código de verificación es 482913.';

  protected readonly groups = computed(() => {
    const channel = this.channel();
    const own = this.scenarios().filter((s) => (s.channel ?? 'email') === channel);
    const byName = new Map(own.map((s) => [s.name, s]));
    const definitions = channel === 'email' ? EMAIL_GROUPS : SMS_GROUPS;
    const grouped = definitions.map((g) => ({ title: g.title, items: g.names.flatMap((n) => byName.get(n) ?? []) }));
    const known = new Set(definitions.flatMap((g) => g.names));
    const others = own.filter((s) => !known.has(s.name));
    if (others.length) grouped.push({ title: 'Otros', items: others });
    return grouped.filter((g) => g.items.length);
  });

  constructor() {
    // Each channel has its own scenario names: start again from "delivered" when switching.
    effect(() => {
      this.channel();
      untracked(() => {
        this.selected = 'delivered';
        this.param = '';
      });
    });
    this.api.scenarios().then(
      (list) => this.scenarios.set(list),
      (error) => this.toasts.error(error),
    );
  }

  /** The address or number for the selected scenario. */
  private target(): string {
    if (this.channel() === 'sms') {
      return this.scenarios().find((s) => s.channel === 'sms' && s.name === this.selected)?.example ?? '+12015550100';
    }
    const param = this.param.trim().replace(/^\+/, '');
    return `${this.selected}${param ? `+${param}` : ''}@${DOMAIN}`;
  }

  protected add(): void {
    const target = this.target();
    this.lists[this.channel()].update((list) => (list.includes(target) ? list : [...list, target]));
  }

  protected remove(target: string): void {
    this.lists[this.channel()].update((list) => list.filter((r) => r !== target));
  }

  protected describe(s: Scenario): string {
    return ((s.channel ?? 'email') === 'sms' ? SMS_DESCRIPTIONS : EMAIL_DESCRIPTIONS)[s.name] ?? s.description;
  }

  protected async send(): Promise<void> {
    if (this.busy() || !this.recipients().length) return;
    this.busy.set(true);
    try {
      const { id } =
        this.channel() === 'email'
          ? await this.api.send({
              from: this.from.trim(),
              to: this.recipients(),
              subject: this.subject.trim() || 'Prueba de Relayo Sim',
              text: 'Mensaje de prueba enviado desde el panel de Relayo Sim.',
              html: '<p>Mensaje de prueba enviado desde el panel de <strong>Relayo Sim</strong>.</p>',
            })
          : await this.api.sendSms({ from: this.smsFrom.trim() || 'RelayoSim', to: this.recipients(), body: this.body });
      this.toasts.show(this.channel() === 'email' ? 'Correo enviado' : 'SMS enviado');
      await this.router.navigate(['/messages', id]);
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}
