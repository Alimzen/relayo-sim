import { Component, computed, inject, signal } from '@angular/core';
import { Api } from '../core/api';
import { Session } from '../core/session';
import type { Project } from '../core/types';
import { Toasts } from '../ui/ui';

type Option = 'unsubscribeLinks' | 'trackOpens' | 'trackClicks';

/** What Relayo adds to the project's real (live) emails. */
@Component({
  selector: 'app-email-options',
  template: `
    <section class="card">
      <header class="card-head">
        <div>
          <h2>Correos reales</h2>
          <p class="muted small">
            Lo que Relayo añade a los correos que salen con claves <code>rly_live_</code>, por cualquier conexión. Solo en correos a un
            destinatario: los enlaces son de cada persona.
          </p>
        </div>
      </header>
      <div class="card-body stack">
        <label class="check option">
          <input type="checkbox" [checked]="project().unsubscribeLinks" (change)="toggle('unsubscribeLinks', $event)" [disabled]="busy()" />
          <span>
            <strong>Enlace de baja en un clic</strong>
            <span class="muted small block">
              Cabeceras <code>List-Unsubscribe</code> y <code>List-Unsubscribe-Post</code> hacia una página de baja de Relayo, como piden
              Gmail y Yahoo a los envíos masivos. Quien se da de baja pasa a Supresiones y te llega un evento <code>unsubscribed</code>.
            </span>
          </span>
        </label>
        <label class="check option">
          <input type="checkbox" [checked]="project().trackOpens" (change)="toggle('trackOpens', $event)" [disabled]="busy()" />
          <span>
            <strong>Seguir aperturas</strong>
            <span class="muted small block">
              Una imagen invisible en el HTML: al cargarla llega un evento <code>opened</code> (uno por destinatario). Algunos clientes
              cargan las imágenes solos, así que es una estimación.
            </span>
          </span>
        </label>
        <label class="check option">
          <input type="checkbox" [checked]="project().trackClicks" (change)="toggle('trackClicks', $event)" [disabled]="busy()" />
          <span>
            <strong>Seguir clics</strong>
            <span class="muted small block">
              Los enlaces del HTML pasan por Relayo, que te manda un evento <code>clicked</code> con la URL y redirige al destino.
            </span>
          </span>
        </label>
        <p class="muted small">
          En el contenido (o en una plantilla), <code>{{ tag }}</code> se cambia por el enlace de baja de cada destinatario.
        </p>
      </div>
    </section>
  `,
})
export class EmailOptions {
  private readonly api = inject(Api);
  private readonly session = inject(Session);
  private readonly toasts = inject(Toasts);
  protected readonly project = computed(() => this.session.project()!);
  protected readonly busy = signal(false);
  protected readonly tag = '{{unsubscribe_url}}';

  protected async toggle(option: Option, event: Event): Promise<void> {
    const input = event.target as HTMLInputElement;
    this.busy.set(true);
    try {
      const updated: Project = await this.api.updateProject({ [option]: input.checked });
      this.session.replaceProject(updated);
      this.toasts.show(input.checked ? 'Activado' : 'Desactivado');
    } catch (error) {
      input.checked = !input.checked;
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }
}
