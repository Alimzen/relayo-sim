import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { RouterLink } from '@angular/router';
import { Api } from '../core/api';
import { formatNumber, fullDate } from '../core/format';
import type { ProjectUsage } from '../core/types';
import { Session } from '../core/session';
import { CopyButton, Toasts } from '../ui/ui';

@Component({
  selector: 'app-settings',
  imports: [FormsModule, RouterLink, CopyButton],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Ajustes</h1>
          <p>El proyecto y cómo conectar tu aplicación al simulador.</p>
        </div>
      </header>

      <div class="stack">
        <form class="card" (ngSubmit)="rename()">
          <header class="card-head"><h2>Proyecto</h2></header>
          <div class="card-body">
            <div class="field">
              <label for="project-name">Nombre</label>
              <input id="project-name" class="input" name="name" required maxlength="80" [(ngModel)]="name" />
            </div>
            <dl class="props props-inline">
              <div>
                <dt>Id del proyecto</dt>
                <dd><code>{{ project().id }}</code><app-copy [value]="project().id" label="Copiar id" /></dd>
              </div>
              <div>
                <dt>Creado</dt>
                <dd>{{ created() }}</dd>
              </div>
            </dl>
          </div>
          <footer class="card-foot">
            <span></span>
            <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy() || !name.trim() || name.trim() === project().name">
              Guardar
            </button>
          </footer>
        </form>

        @if (usage(); as u) {
          <section class="card">
            <header class="card-head">
              <div>
                <h2>Uso del plan</h2>
                <p class="muted small">Gratis durante la beta.</p>
              </div>
            </header>
            <div class="card-body">
              @for (row of meters(u); track row.label) {
                <div class="usage">
                  <div class="usage-row">
                    <span>{{ row.label }}</span>
                    <strong>{{ format(row.used) }}{{ row.limit ? ' / ' + format(row.limit) : '' }}</strong>
                  </div>
                  @if (row.limit) {
                    <div
                      class="meter"
                      role="meter"
                      [attr.aria-label]="row.label"
                      [attr.aria-valuenow]="row.used"
                      aria-valuemin="0"
                      [attr.aria-valuemax]="row.limit"
                      [attr.data-level]="level(row.used, row.limit)"
                    >
                      <span [style.width.%]="share(row.used, row.limit)"></span>
                    </div>
                  }
                </div>
              }
              <p class="muted small">
                Se reinician el día 1 de cada mes. Al llegar a un límite, los envíos se rechazan (HTTP 429; SMTP 452).
              </p>
              <dl class="props props-inline usage-props">
                <div>
                  <dt>Envíos por minuto</dt>
                  <dd>{{ u.limits.messagesPerMinute ? 'hasta ' + format(u.limits.messagesPerMinute) : 'sin límite' }}</dd>
                </div>
                <div>
                  <dt>Se guardan</dt>
                  <dd>{{ u.retentionDays ? u.retentionDays + ' días' : 'siempre' }}</dd>
                </div>
              </dl>
            </div>
          </section>
        }

        <section class="card">
          <header class="card-head">
            <div>
              <h2>Conexión</h2>
              <p class="muted small">
                Autentícate con una <a routerLink="/keys">clave de API</a> del proyecto. Referencia completa:
                <a href="/docs" target="_blank" rel="noopener">documentación de la API</a>.
              </p>
            </div>
          </header>
          <div class="card-body">
            <dl class="props">
              <div>
                <dt>API HTTP</dt>
                <dd><code>{{ origin }}</code><app-copy [value]="origin" label="Copiar URL" /></dd>
              </div>
              <div>
                <dt>SMTP</dt>
                <dd>
                  <code>{{ host }}:2525</code><app-copy [value]="host + ':2525'" label="Copiar servidor" />
                  <span class="muted small">· cualquier usuario; la contraseña es tu clave</span>
                </dd>
              </div>
            </dl>
          </div>
        </section>

        <section class="card">
          <header class="card-head">
            <div>
              <h2>Con Relayo</h2>
              <p class="muted small">El driver <code>&#64;alimzen/relayo-simulator</code> (o <code>&#64;alimzen/relayo-cloud</code>) envía por la API y normaliza los webhooks.</p>
            </div>
            <app-copy [value]="snippet()" label="Copiar código" />
          </header>
          <div class="card-body">
            <pre><code>{{ snippet() }}</code></pre>
          </div>
        </section>
      </div>
    </div>
  `,
})
export class SettingsPage {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly toasts = inject(Toasts);
  protected readonly project = computed(() => this.session.project()!);
  protected readonly created = computed(() => fullDate(this.project().createdAt));
  protected readonly busy = signal(false);
  protected readonly origin = location.origin;
  protected readonly host = location.hostname;
  protected name = this.project().name;
  protected readonly usage = signal<ProjectUsage | null>(null);
  protected readonly format = formatNumber;

  constructor() {
    this.api.usage().then(
      (u) => this.usage.set(u),
      () => undefined,
    );
  }

  protected meters(u: ProjectUsage): Array<{ label: string; used: number; limit: number }> {
    return [
      { label: 'Mensajes simulados este mes', used: u.messages, limit: u.limits.monthlyMessages },
      { label: 'Envíos reales este mes', used: u.live, limit: u.limits.liveMonthlyMessages },
    ];
  }

  protected share(used: number, limit: number): number {
    return Math.min(100, (used / limit) * 100);
  }

  protected level(used: number, limit: number): 'ok' | 'high' | 'full' {
    const share = this.share(used, limit);
    return share >= 100 ? 'full' : share >= 80 ? 'high' : 'ok';
  }

  protected readonly snippet = computed(
    () => `import { createRelayo } from '@alimzen/relayo';
import { simulator } from '@alimzen/relayo-simulator';

const relayo = createRelayo({
  email: simulator({
    baseUrl: '${this.origin}',
    apiKey: process.env.RELAYO_SIM_API_KEY!,
    webhook: { secret: process.env.RELAYO_SIM_WEBHOOK_SECRET! },
  }),
});`,
  );

  protected async rename(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const project = await this.api.updateProject({ name: this.name.trim() });
      this.session.replaceProject(project);
      this.name = project.name;
      this.toasts.show('Proyecto guardado');
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}
