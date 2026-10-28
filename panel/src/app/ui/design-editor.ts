import { Component, computed, input, output, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { LucideArrowDown, LucideArrowUp, LucideCopy, LucidePlus, LucideTrash } from '@lucide/angular';
import { BLOCK_LABELS, blockId, newBlock, type Block, type BlockType, type EmailDesign } from '../core/email-design';

const ADDABLE: BlockType[] = ['heading', 'text', 'button', 'image', 'divider', 'spacer', 'footer'];

/** The visual editor: the email's blocks in order, the selected one's settings, and the theme. */
@Component({
  selector: 'app-design-editor',
  imports: [FormsModule, LucideArrowDown, LucideArrowUp, LucideCopy, LucidePlus, LucideTrash],
  template: `
    <div class="design-editor">
      <ol class="design-blocks" aria-label="Bloques del correo">
        @for (b of design().blocks; track b.id; let i = $index, last = $last) {
          <li class="design-block" [class.selected]="b.id === selectedId()">
            <button type="button" class="design-block-main" (click)="selectedId.set(b.id)" [attr.aria-pressed]="b.id === selectedId()">
              <span class="chip">{{ labels[b.type] }}</span>
              <span class="truncate muted small">{{ summary(b) }}</span>
            </button>
            <span class="design-block-actions">
              <button type="button" class="icon-button" (click)="move(i, -1)" [disabled]="i === 0" aria-label="Subir" title="Subir"><svg lucideArrowUp [size]="14"></svg></button>
              <button type="button" class="icon-button" (click)="move(i, 1)" [disabled]="last" aria-label="Bajar" title="Bajar"><svg lucideArrowDown [size]="14"></svg></button>
              <button type="button" class="icon-button" (click)="duplicate(i)" aria-label="Duplicar" title="Duplicar"><svg lucideCopy [size]="14"></svg></button>
              <button type="button" class="icon-button" (click)="remove(i)" aria-label="Quitar" title="Quitar"><svg lucideTrash [size]="14"></svg></button>
            </span>
          </li>
        } @empty {
          <li class="muted small">Sin bloques: añade el primero.</li>
        }
      </ol>

      <div class="design-add" role="group" aria-label="Añadir bloque">
        @for (t of addable; track t) {
          <button type="button" class="btn btn-sm" (click)="add(t)"><svg lucidePlus [size]="13"></svg>{{ labels[t] }}</button>
        }
      </div>

      @if (selected(); as b) {
        <fieldset class="design-props">
          <legend class="label">{{ labels[b.type] }}</legend>
          @switch (b.type) {
            @case ('heading') {
              <div class="field">
                <label for="d-text">Texto</label>
                <input id="d-text" class="input" [ngModel]="b.text" (ngModelChange)="set(b, { text: $event })" />
              </div>
              <div class="two-col">
                <div class="field">
                  <label for="d-size">Tamaño</label>
                  <select id="d-size" class="input" [ngModel]="b.size" (ngModelChange)="set(b, { size: $event })">
                    <option value="large">Grande</option>
                    <option value="medium">Mediano</option>
                  </select>
                </div>
                <div class="field">
                  <label for="d-align">Alineación</label>
                  <select id="d-align" class="input" [ngModel]="b.align" (ngModelChange)="set(b, { align: $event })">
                    <option value="left">Izquierda</option>
                    <option value="center">Centro</option>
                    <option value="right">Derecha</option>
                  </select>
                </div>
              </div>
            }
            @case ('text') {
              <div class="field">
                <label for="d-text">Texto</label>
                <textarea id="d-text" class="input textarea" rows="6" [ngModel]="b.text" (ngModelChange)="set(b, { text: $event })"></textarea>
                <span class="hint">Una línea en blanco separa párrafos. <code>**negrita**</code>, <code>*cursiva*</code>, <code>[texto](https://…)</code> y variables <code>{{ tag }}</code>.</span>
              </div>
              <div class="field">
                <label for="d-align">Alineación</label>
                <select id="d-align" class="input" [ngModel]="b.align" (ngModelChange)="set(b, { align: $event })">
                  <option value="left">Izquierda</option>
                  <option value="center">Centro</option>
                  <option value="right">Derecha</option>
                </select>
              </div>
            }
            @case ('button') {
              <div class="two-col">
                <div class="field">
                  <label for="d-label">Texto</label>
                  <input id="d-label" class="input" [ngModel]="b.label" (ngModelChange)="set(b, { label: $event })" />
                </div>
                <div class="field">
                  <label for="d-align">Alineación</label>
                  <select id="d-align" class="input" [ngModel]="b.align" (ngModelChange)="set(b, { align: $event })">
                    <option value="left">Izquierda</option>
                    <option value="center">Centro</option>
                    <option value="right">Derecha</option>
                  </select>
                </div>
              </div>
              <div class="field">
                <label for="d-url">Enlace</label>
                <input id="d-url" class="input mono" [ngModel]="b.url" (ngModelChange)="set(b, { url: $event })" placeholder="https://…" />
              </div>
            }
            @case ('image') {
              <div class="field">
                <label for="d-src">URL de la imagen</label>
                <input id="d-src" class="input mono" [ngModel]="b.src" (ngModelChange)="set(b, { src: $event })" placeholder="https://…/logo.png" />
              </div>
              <div class="field">
                <label for="d-alt">Texto alternativo</label>
                <input id="d-alt" class="input" [ngModel]="b.alt" (ngModelChange)="set(b, { alt: $event })" placeholder="Lo que se lee si la imagen no carga" />
              </div>
              <div class="two-col">
                <div class="field">
                  <label for="d-width">Ancho (px)</label>
                  <input id="d-width" class="input" type="number" min="40" max="536" [ngModel]="b.width" (ngModelChange)="set(b, { width: +$event })" />
                </div>
                <div class="field">
                  <label for="d-align">Alineación</label>
                  <select id="d-align" class="input" [ngModel]="b.align" (ngModelChange)="set(b, { align: $event })">
                    <option value="left">Izquierda</option>
                    <option value="center">Centro</option>
                    <option value="right">Derecha</option>
                  </select>
                </div>
              </div>
              <div class="field">
                <label for="d-link">Enlace <span class="muted">(opcional)</span></label>
                <input id="d-link" class="input mono" [ngModel]="b.url" (ngModelChange)="set(b, { url: $event })" placeholder="https://…" />
              </div>
            }
            @case ('spacer') {
              <div class="field">
                <label for="d-height">Alto (px)</label>
                <input id="d-height" class="input" type="number" min="4" max="120" [ngModel]="b.height" (ngModelChange)="set(b, { height: +$event })" />
              </div>
            }
            @case ('footer') {
              <div class="field">
                <label for="d-text">Texto</label>
                <textarea id="d-text" class="input textarea" rows="3" [ngModel]="b.text" (ngModelChange)="set(b, { text: $event })"></textarea>
              </div>
              <label class="check">
                <input type="checkbox" [ngModel]="b.unsubscribe" (ngModelChange)="set(b, { unsubscribe: $event })" />Enlace «Darse de baja»
                (<code>{{ unsubscribeTag }}</code>, que Relayo rellena en cada envío real)
              </label>
            }
            @default {
              <p class="muted small">Una línea fina entre bloques; no tiene ajustes.</p>
            }
          }
        </fieldset>
      }

      <fieldset class="design-props">
        <legend class="label">Estilo</legend>
        <div class="design-colors">
          <label>Fondo <input type="color" [ngModel]="design().theme.background" (ngModelChange)="theme({ background: $event })" /></label>
          <label>Correo <input type="color" [ngModel]="design().theme.surface" (ngModelChange)="theme({ surface: $event })" /></label>
          <label>Texto <input type="color" [ngModel]="design().theme.text" (ngModelChange)="theme({ text: $event })" /></label>
          <label>Botones <input type="color" [ngModel]="design().theme.accent" (ngModelChange)="theme({ accent: $event })" /></label>
        </div>
        <div class="two-col">
          <div class="field">
            <label for="d-font">Tipografía</label>
            <select id="d-font" class="input" [ngModel]="design().theme.font" (ngModelChange)="theme({ font: $event })">
              <option value="sans">Sin serifa (Arial, Helvetica)</option>
              <option value="serif">Con serifa (Georgia)</option>
            </select>
          </div>
          <div class="field">
            <label for="d-pre">Preheader</label>
            <input id="d-pre" class="input" maxlength="140" [ngModel]="design().theme.preheader" (ngModelChange)="theme({ preheader: $event })" placeholder="Lo que la bandeja muestra tras el asunto" />
          </div>
        </div>
      </fieldset>
    </div>
  `,
})
export class DesignEditor {
  readonly design = input.required<EmailDesign>();
  readonly changed = output<EmailDesign>();
  protected readonly labels = BLOCK_LABELS;
  protected readonly addable = ADDABLE;
  protected readonly tag = '{{nombre}}';
  protected readonly unsubscribeTag = '{{unsubscribe_url}}';
  protected readonly selectedId = signal<string | null>(null);
  protected readonly selected = computed(() => this.design().blocks.find((b) => b.id === this.selectedId()) ?? null);

  protected summary(b: Block): string {
    switch (b.type) {
      case 'heading':
      case 'text':
      case 'footer':
        return b.text;
      case 'button':
        return `${b.label} → ${b.url}`;
      case 'image':
        return b.alt || b.src;
      case 'spacer':
        return `${b.height} px`;
      default:
        return '';
    }
  }

  protected add(type: BlockType): void {
    const block = newBlock(type);
    const blocks = [...this.design().blocks];
    const at = blocks.findIndex((b) => b.id === this.selectedId());
    // After the selected block, or before the footer, or at the end.
    const footer = blocks.findIndex((b) => b.type === 'footer');
    const index = at >= 0 ? at + 1 : footer >= 0 && type !== 'footer' ? footer : blocks.length;
    blocks.splice(index, 0, block);
    this.emit(blocks);
    this.selectedId.set(block.id);
  }

  protected set(block: Block, changes: Partial<Block>): void {
    this.emit(this.design().blocks.map((b) => (b.id === block.id ? ({ ...b, ...changes } as Block) : b)));
  }

  protected move(index: number, by: -1 | 1): void {
    const blocks = [...this.design().blocks];
    const [block] = blocks.splice(index, 1);
    blocks.splice(index + by, 0, block!);
    this.emit(blocks);
  }

  protected duplicate(index: number): void {
    const blocks = [...this.design().blocks];
    const copy = { ...blocks[index]!, id: blockId() };
    blocks.splice(index + 1, 0, copy);
    this.emit(blocks);
    this.selectedId.set(copy.id);
  }

  protected remove(index: number): void {
    const blocks = [...this.design().blocks];
    const [gone] = blocks.splice(index, 1);
    if (gone?.id === this.selectedId()) this.selectedId.set(null);
    this.emit(blocks);
  }

  protected theme(changes: Partial<EmailDesign['theme']>): void {
    this.changed.emit({ ...this.design(), theme: { ...this.design().theme, ...changes } });
  }

  private emit(blocks: Block[]): void {
    this.changed.emit({ ...this.design(), blocks });
  }
}
