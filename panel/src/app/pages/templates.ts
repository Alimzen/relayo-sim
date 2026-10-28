import { Component, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideCircleAlert, LucideFileText, LucideInfo, LucidePlus, LucideTrash, LucideTriangleAlert } from '@lucide/angular';
import { Api } from '../core/api';
import { timeAgo } from '../core/format';
import { checkEmail, defaultDesign, designText, readDesign, renderDesign, type EmailDesign } from '../core/email-design';
import type { Template, TemplatePreview } from '../core/types';
import { DesignEditor } from '../ui/design-editor';
import { EmailPreview } from '../ui/email-preview';
import { CopyButton, EmptyState, Modal, Toasts } from '../ui/ui';

type Draft = {
  alias: string;
  name: string;
  channel: 'email' | 'sms';
  subject: string;
  html: string;
  text: string;
  body: string;
  /** Built with the visual editor: html and text come from it. */
  design: EmailDesign | null;
};

const EMPTY: Draft = { alias: '', name: '', channel: 'email', subject: '', html: '', text: '', body: '', design: null };
/** Same syntax as the server: {{name}}, {{user.name}}, {{{raw}}}. */
const TAG = /\{\{\{?\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*\}?\}\}/g;

/** Saved emails and SMS: edited here, sent with { template, variables }. */
@Component({
  selector: 'app-templates',
  imports: [
    FormsModule,
    CopyButton,
    DesignEditor,
    EmailPreview,
    EmptyState,
    Modal,
    LucideCircleAlert,
    LucideFileText,
    LucideInfo,
    LucidePlus,
    LucideTrash,
    LucideTriangleAlert,
  ],
  template: `
    <div class="page">
      <header class="page-head">
        <div>
          <h1>Plantillas</h1>
          <p>
            Correos y SMS guardados con variables <code>{{ example }}</code>. Envíalos con
            <code>template</code> y <code>variables</code>, y cambia el contenido aquí sin desplegar tu aplicación.
          </p>
        </div>
        <button type="button" class="btn btn-primary" (click)="startNew()"><svg lucidePlus [size]="15"></svg>Nueva plantilla</button>
      </header>

      @if (editing()) {
        <form class="template-editor" (ngSubmit)="save()">
          <section class="card">
            <header class="card-head">
              <h2>{{ editing()!.id ? 'Editar «' + editing()!.alias + '»' : 'Nueva plantilla' }}</h2>
              @if (!editing()!.id) {
                <div class="segmented" role="group" aria-label="Canal">
                  <button type="button" [attr.aria-pressed]="draft.channel === 'email'" (click)="draft.channel = 'email'; refresh()">Email</button>
                  <button type="button" [attr.aria-pressed]="draft.channel === 'sms'" (click)="draft.channel = 'sms'; refresh()">SMS</button>
                </div>
              }
            </header>
            <div class="card-body">
              <div class="two-col">
                <div class="field">
                  <label for="t-alias">Alias</label>
                  <input id="t-alias" class="input mono" name="alias" required [(ngModel)]="draft.alias" placeholder="bienvenida" />
                  <span class="hint">El nombre con el que la envías: minúsculas, números, «-» y «_».</span>
                </div>
                <div class="field">
                  <label for="t-name">Nombre <span class="muted">(opcional)</span></label>
                  <input id="t-name" class="input" name="name" [(ngModel)]="draft.name" placeholder="Correo de bienvenida" />
                </div>
              </div>
              @if (draft.channel === 'email') {
                <div class="field">
                  <label for="t-subject">Asunto</label>
                  <input id="t-subject" class="input" name="subject" required [(ngModel)]="draft.subject" (ngModelChange)="refresh()" />
                </div>
                <div class="field">
                  <span class="label">Contenido</span>
                  <div class="segmented" role="group" aria-label="Editor">
                    <button type="button" [attr.aria-pressed]="!!draft.design" (click)="toVisual()">Visual</button>
                    <button type="button" [attr.aria-pressed]="!draft.design" (click)="toHtml()">HTML</button>
                  </div>
                </div>
                @if (draft.design) {
                  <app-design-editor [design]="draft.design" (changed)="onDesign($event)" />
                } @else {
                  <div class="field">
                    <label for="t-html">HTML</label>
                    <textarea id="t-html" class="input textarea mono" name="html" rows="10" [(ngModel)]="draft.html" (ngModelChange)="refresh()"></textarea>
                    <span class="hint">Las variables se escapan; usa <code>{{ raw }}</code> para insertar HTML tal cual.</span>
                  </div>
                  <div class="field">
                    <label for="t-text">Texto <span class="muted">(recomendado, para clientes sin HTML)</span></label>
                    <textarea id="t-text" class="input textarea" name="text" rows="5" [(ngModel)]="draft.text" (ngModelChange)="refresh()"></textarea>
                  </div>
                }
              } @else {
                <div class="field">
                  <label for="t-body">Mensaje</label>
                  <textarea id="t-body" class="input textarea" name="body" rows="4" maxlength="1600" required [(ngModel)]="draft.body" (ngModelChange)="refresh()"></textarea>
                </div>
              }
            </div>
            <footer class="card-foot">
              <button type="button" class="btn btn-sm" (click)="editing.set(null)">Cancelar</button>
              <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy()">Guardar</button>
            </footer>
          </section>

          <section class="card">
            <header class="card-head"><h2>Vista previa</h2></header>
            <div class="card-body">
              @if (variables().length) {
                <div class="field">
                  <label for="t-vars">Valores de ejemplo</label>
                  <textarea id="t-vars" class="input textarea mono" name="vars" rows="4" [(ngModel)]="sample" (ngModelChange)="refresh()"></textarea>
                  @if (sampleError()) {
                    <span class="hint danger-text">{{ sampleError() }}</span>
                  } @else if (missing().length) {
                    <span class="hint">Sin valor: {{ missing().join(', ') }}. Un envío sin ellas se rechaza.</span>
                  }
                </div>
              }
              @if (draft.channel === 'email') {
                <p class="preview-subject"><span class="muted">Asunto:</span> {{ rendered().subject }}</p>
                @if (rendered().html) {
                  <app-email-preview [html]="rendered().html!" />
                } @else {
                  <pre class="delivery-pre">{{ rendered().text }}</pre>
                }
                @if (checks().length) {
                  <p class="label template-snippet-label">Antes de enviar</p>
                  <ul class="checks">
                    @for (c of checks(); track c.text) {
                      <li [class]="'check-' + c.level">
                        @switch (c.level) {
                          @case ('error') {
                            <svg lucideCircleAlert [size]="15" aria-label="Error"></svg>
                          }
                          @case ('warning') {
                            <svg lucideTriangleAlert [size]="15" aria-label="Aviso"></svg>
                          }
                          @default {
                            <svg lucideInfo [size]="15" aria-label="Consejo"></svg>
                          }
                        }
                        <span>{{ c.text }}</span>
                      </li>
                    }
                  </ul>
                }
              } @else {
                <div class="sms-bubble">{{ rendered().body }}</div>
              }
              <p class="label template-snippet-label">Envío</p>
              <div class="secret snippet"><code>{{ snippet() }}</code><app-copy [value]="snippet()" label="Copiar" /></div>
            </div>
          </section>
        </form>
      } @else {
        <section class="card">
          @if (templates() === null) {
            <div class="card-body stack"><div class="skeleton"></div><div class="skeleton"></div></div>
          } @else if (templates()!.length === 0) {
            <app-empty heading="Sin plantillas">
              <svg icon lucideFileText [size]="20"></svg>
              Guarda aquí tus correos de bienvenida, facturas o códigos de verificación, y envíalos solo con sus variables.
            </app-empty>
          } @else {
            <div class="table-wrap">
              <table class="table">
                <thead>
                  <tr><th>Alias</th><th>Canal</th><th>Variables</th><th>Cambiada</th><th><span class="sr-only">Acciones</span></th></tr>
                </thead>
                <tbody>
                  @for (t of templates(); track t.id) {
                    <tr class="clickable" (click)="edit(t)" tabindex="0" (keydown.enter)="edit(t)">
                      <td class="cell-main"><code>{{ t.alias }}</code>@if (t.name !== t.alias) {<div class="muted small">{{ t.name }}</div>}</td>
                      <td><span class="chip">{{ t.channel === 'email' ? 'Email' : 'SMS' }}</span></td>
                      <td class="muted small">{{ t.variables.join(', ') || '—' }}</td>
                      <td class="nowrap muted small">{{ ago(t.updatedAt) }}</td>
                      <td>
                        <button type="button" class="icon-button" (click)="$event.stopPropagation(); removing.set(t)" [attr.aria-label]="'Eliminar ' + t.alias" title="Eliminar">
                          <svg lucideTrash [size]="15"></svg>
                        </button>
                      </td>
                    </tr>
                  }
                </tbody>
              </table>
            </div>
          }
        </section>
      }
    </div>

    <app-modal heading="Pasar al editor visual" [open]="replacing()" (closed)="replacing.set(false)">
      <p class="text-2">El editor visual empieza con un diseño nuevo y sustituye el HTML y el texto que tienes ahora.</p>
      <div class="modal-actions">
        <button type="button" class="btn" (click)="replacing.set(false)">Cancelar</button>
        <button type="button" class="btn btn-primary" (click)="startVisual()">Empezar en visual</button>
      </div>
    </app-modal>

    <app-modal heading="Eliminar plantilla" [open]="!!removing()" (closed)="removing.set(null)">
      <p class="text-2">Los envíos con <code>template: "{{ removing()?.alias }}"</code> empezarán a fallar con un 404.</p>
      <div class="modal-actions">
        <button type="button" class="btn" (click)="removing.set(null)">Cancelar</button>
        <button type="button" class="btn btn-danger" (click)="remove()" [disabled]="busy()">Eliminar</button>
      </div>
    </app-modal>
  `,
})
export class TemplatesPage {
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly example = '{{nombre}}';
  protected readonly raw = '{{{html}}}';
  protected readonly templates = signal<Template[] | null>(null);
  protected readonly editing = signal<{ id?: string; alias: string } | null>(null);
  protected readonly removing = signal<Template | null>(null);
  protected readonly replacing = signal(false);
  protected readonly busy = signal(false);
  protected readonly ago = (value: string) => timeAgo(value);
  protected draft: Draft = { ...EMPTY };
  protected sample = '{}';
  private readonly version = signal(0);
  protected readonly sampleError = signal('');

  /** The draft's variables, in order of first use: the editor fills the sample with them. */
  protected readonly variables = computed(() => {
    this.version();
    const d = this.draft;
    const names = new Set<string>();
    for (const text of [d.subject, d.html, d.text, d.body]) for (const m of text.matchAll(TAG)) names.add(m[1]!);
    return [...names];
  });

  /** Rendered in the browser with the same rules as the server, so the preview follows every keystroke. */
  protected readonly preview = computed<TemplatePreview>(() => {
    this.version();
    const d = this.draft;
    let values: Record<string, unknown> = {};
    try {
      values = JSON.parse(this.sample || '{}') as Record<string, unknown>;
    } catch {
      // the error is shown next to the field
    }
    const missing = new Set<string>();
    const rendered =
      d.channel === 'sms'
        ? { body: fill(d.body, values, false, missing) }
        : {
            subject: fill(d.subject, values, false, missing),
            ...(d.html && { html: fill(d.html, values, true, missing) }),
            ...(d.text && { text: fill(d.text, values, false, missing) }),
          };
    return { rendered, missing: [...missing] };
  });
  protected readonly rendered = computed(() => this.preview().rendered as { subject?: string; html?: string; text?: string; body?: string });
  protected readonly missing = computed(() => this.preview().missing);
  protected readonly checks = computed(() => {
    this.version();
    return this.draft.channel === 'email' ? checkEmail(this.draft.subject, this.draft.html, this.draft.design) : [];
  });

  protected readonly snippet = computed(() => {
    this.version();
    let values: unknown = {};
    try {
      values = JSON.parse(this.sample || '{}');
    } catch {
      // keep {}
    }
    const alias = this.draft.alias.trim() || 'alias';
    return this.draft.channel === 'sms'
      ? `relayo.sms.send({ to: { address: '+34600111222' }, template: '${alias}', variables: ${JSON.stringify(values)} })`
      : `POST /v1/messages { "from": "…", "to": ["…"], "template": "${alias}", "variables": ${JSON.stringify(values)} }`;
  });

  constructor() {
    void this.load();
  }

  protected startNew(): void {
    // New emails start in the visual editor.
    this.draft = { ...EMPTY };
    this.useDesign(defaultDesign());
    this.sample = '{}';
    this.editing.set({ alias: '' });
    this.refresh();
  }

  protected edit(t: Template): void {
    this.draft = {
      alias: t.alias,
      name: t.name,
      channel: t.channel,
      subject: t.subject ?? '',
      html: t.html ?? '',
      text: t.text ?? '',
      body: t.body ?? '',
      design: readDesign(t.design),
    };
    this.sample = JSON.stringify(Object.fromEntries(t.variables.filter((v) => v !== 'unsubscribe_url').map((v) => [v, ''])), null, 2);
    this.editing.set({ id: t.id, alias: t.alias });
    this.refresh();
  }

  /** Builds the HTML and the text from the design, at every change. */
  protected onDesign(design: EmailDesign): void {
    this.useDesign(design);
    this.refresh();
  }

  protected toVisual(): void {
    if (this.draft.design) return;
    if (this.draft.html.trim() || this.draft.text.trim()) this.replacing.set(true);
    else this.startVisual();
  }

  protected startVisual(): void {
    this.replacing.set(false);
    this.onDesign(defaultDesign());
  }

  /** From now on the HTML is edited by hand, starting from what the design produced. */
  protected toHtml(): void {
    this.draft = { ...this.draft, design: null };
    this.refresh();
  }

  private useDesign(design: EmailDesign): void {
    this.draft = { ...this.draft, design, html: renderDesign(design), text: designText(design) };
  }

  /** Recomputes the preview, and adds new variables to the sample so they can be filled in. */
  protected refresh(): void {
    try {
      const values = JSON.parse(this.sample || '{}') as Record<string, unknown>;
      this.sampleError.set('');
      this.version.update((v) => v + 1);
      const added = this.variables().filter((v) => !v.includes('.') && v !== 'unsubscribe_url' && !(v in values));
      if (added.length) this.sample = JSON.stringify({ ...values, ...Object.fromEntries(added.map((v) => [v, ''])) }, null, 2);
    } catch {
      this.sampleError.set('Los valores deben ser un objeto JSON, como {"nombre": "Ana"}');
    }
    this.version.update((v) => v + 1);
  }

  protected async save(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    const d = this.draft;
    const body: Record<string, unknown> =
      d.channel === 'sms'
        ? { alias: d.alias, name: d.name, channel: d.channel, body: d.body }
        : { alias: d.alias, name: d.name, channel: d.channel, subject: d.subject, html: d.html, text: d.text, design: d.design };
    try {
      const id = this.editing()?.id;
      const saved = id ? await this.api.updateTemplate(id, body) : await this.api.createTemplate(body);
      this.toasts.show(`Plantilla «${saved.alias}» guardada`);
      this.editing.set(null);
      await this.load();
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected async remove(): Promise<void> {
    const t = this.removing();
    if (!t || this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.deleteTemplate(t.id);
      this.removing.set(null);
      await this.load();
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  private async load(): Promise<void> {
    try {
      this.templates.set(await this.api.templates());
    } catch (error) {
      this.templates.update((t) => t ?? []);
      this.toasts.error(error);
    }
  }
}

function lookup(values: Record<string, unknown>, path: string): unknown {
  let value: unknown = values;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

function fill(text: string, values: Record<string, unknown>, html: boolean, missing: Set<string>): string {
  return text.replace(/\{\{(\{)?\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*\}?\}\}/g, (_, raw: string | undefined, path: string) => {
    // Filled per recipient by Relayo when a real email goes out.
    if (path === 'unsubscribe_url' && !lookup(values, path)) return '#';
    const value = lookup(values, path);
    if (value === undefined || value === null || value === '') {
      missing.add(path);
      return '';
    }
    const string = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return html && !raw ? string.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!) : string;
  });
}
