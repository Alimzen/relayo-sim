import { Component, ElementRef, Injectable, booleanAttribute, effect, input, output, signal, viewChild } from '@angular/core';
import { LucideCheck, LucideCopy, LucideMail, LucideX } from '@lucide/angular';
import type { Tone } from '../core/events';

// --- Toasts -----------------------------------------------------------------------------------------

export interface Toast {
  id: number;
  text: string;
  kind: 'success' | 'error';
}

@Injectable({ providedIn: 'root' })
export class Toasts {
  readonly list = signal<Toast[]>([]);
  private next = 1;

  show(text: string, kind: Toast['kind'] = 'success'): void {
    const id = this.next++;
    this.list.update((l) => [...l, { id, text, kind }]);
    setTimeout(() => this.dismiss(id), kind === 'error' ? 6000 : 3500);
  }

  error(error: unknown): void {
    this.show(error instanceof Error ? error.message : String(error), 'error');
  }

  dismiss(id: number): void {
    this.list.update((l) => l.filter((t) => t.id !== id));
  }
}

@Component({
  selector: 'app-toasts',
  imports: [LucideX],
  template: `
    <div class="toasts" aria-live="polite">
      @for (toast of toasts.list(); track toast.id) {
        <div class="toast" [class.toast-error]="toast.kind === 'error'" role="status">
          <span>{{ toast.text }}</span>
          <button type="button" class="icon-button" (click)="toasts.dismiss(toast.id)" aria-label="Cerrar">
            <svg lucideX [size]="14"></svg>
          </button>
        </div>
      }
    </div>
  `,
})
export class ToastsHost {
  constructor(protected readonly toasts: Toasts) {}
}

// --- Badge ------------------------------------------------------------------------------------------

@Component({
  selector: 'app-badge',
  template: `<span class="badge" [attr.data-tone]="tone()"><span class="badge-dot" aria-hidden="true"></span><ng-content /></span>`,
})
export class Badge {
  readonly tone = input<Tone>('neutral');
}

// --- Copy button ------------------------------------------------------------------------------------

@Component({
  selector: 'app-copy',
  imports: [LucideCopy, LucideCheck],
  template: `
    <button type="button" class="icon-button" (click)="copy()" [attr.aria-label]="copied() ? 'Copiado' : label()" [title]="label()">
      @if (copied()) {
        <svg lucideCheck [size]="14"></svg>
      } @else {
        <svg lucideCopy [size]="14"></svg>
      }
    </button>
  `,
})
export class CopyButton {
  readonly value = input.required<string>();
  readonly label = input('Copiar');
  protected readonly copied = signal(false);

  protected async copy(): Promise<void> {
    try {
      await navigator.clipboard.writeText(this.value());
      this.copied.set(true);
      setTimeout(() => this.copied.set(false), 1500);
    } catch {
      // clipboard blocked: nothing to do
    }
  }
}

// --- Modal ------------------------------------------------------------------------------------------

/** Native <dialog>: focus trapping, Escape and the backdrop come from the browser. */
@Component({
  selector: 'app-modal',
  imports: [LucideX],
  template: `
    <dialog #dialog class="modal" (close)="closed.emit()" (click)="backdrop($event)" [attr.aria-labelledby]="titleId">
      <div class="modal-body">
        <header class="modal-head">
          <h2 [id]="titleId">{{ heading() }}</h2>
          <button type="button" class="icon-button" (click)="close()" aria-label="Cerrar"><svg lucideX [size]="16"></svg></button>
        </header>
        <ng-content />
      </div>
    </dialog>
  `,
})
export class Modal {
  readonly heading = input.required<string>();
  readonly open = input(false, { transform: booleanAttribute });
  readonly closed = output<void>();
  private readonly dialog = viewChild.required<ElementRef<HTMLDialogElement>>('dialog');
  protected readonly titleId = `modal-${Math.random().toString(36).slice(2)}`;

  constructor() {
    effect(() => {
      const el = this.dialog().nativeElement;
      if (this.open() && !el.open) el.showModal();
      if (!this.open() && el.open) el.close();
    });
  }

  close(): void {
    this.dialog().nativeElement.close();
  }

  protected backdrop(event: MouseEvent): void {
    if (event.target === this.dialog().nativeElement) this.close();
  }
}

// --- Empty state ------------------------------------------------------------------------------------

@Component({
  selector: 'app-empty',
  template: `
    <div class="empty">
      <div class="empty-icon" aria-hidden="true"><ng-content select="[icon]" /></div>
      <p class="empty-title">{{ heading() }}</p>
      <p class="empty-text"><ng-content /></p>
    </div>
  `,
})
export class EmptyState {
  readonly heading = input.required<string>();
}

// --- Brand ------------------------------------------------------------------------------------------

@Component({
  selector: 'app-brand',
  imports: [LucideMail],
  template: `
    <span class="brand-mark" aria-hidden="true"><svg lucideMail [size]="14" [strokeWidth]="2.25"></svg></span>
    <span>Relayo <span class="brand-tag">Sim</span></span>
  `,
  host: { class: 'brand' },
})
export class Brand {}
