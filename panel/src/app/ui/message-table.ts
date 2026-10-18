import { Component, booleanAttribute, inject, input } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { lookOf, scenarioLabel, type StatusLook } from '../core/events';
import { fullDate, timeAgo } from '../core/format';
import type { SimMessage } from '../core/types';
import { Badge } from './ui';

const QUEUED: StatusLook = { label: 'En cola', tone: 'neutral' };

@Component({
  selector: 'app-message-table',
  imports: [RouterLink, Badge],
  template: `
    <div class="table-wrap">
      <table class="table">
        <thead>
          <tr>
            <th>Estado</th>
            <th>Destinatario</th>
            <th class="hide-sm">Asunto</th>
            <th class="hide-sm">Escenario</th>
            @if (!compact()) {
              <th class="hide-sm">Vía</th>
            }
            <th>Enviado</th>
          </tr>
        </thead>
        <tbody>
          @for (m of messages(); track m.id) {
            <tr class="clickable" (click)="open(m)">
              <td><app-badge [tone]="look(m).tone">{{ look(m).label }}</app-badge></td>
              <td class="cell-recipient">
                <a class="cell-main row-link" [routerLink]="['/messages', m.id]">{{ m.recipients[0]?.address ?? '—' }}</a>
                @if (m.recipients.length > 1) {
                  <span class="muted"> +{{ m.recipients.length - 1 }}</span>
                }
              </td>
              <td class="hide-sm cell-subject"><span class="truncate">{{ m.subject || '(sin asunto)' }}</span></td>
              <td class="hide-sm"><span class="chip mono">{{ scenario(m) }}</span></td>
              @if (!compact()) {
                <td class="hide-sm muted">{{ m.via === 'smtp' ? 'SMTP' : 'API' }}</td>
              }
              <td class="muted nowrap" [title]="full(m.createdAt)">{{ ago(m.createdAt) }}</td>
            </tr>
          }
        </tbody>
      </table>
    </div>
  `,
})
export class MessageTable {
  readonly messages = input.required<SimMessage[]>();
  readonly compact = input(false, { transform: booleanAttribute });
  private readonly router = inject(Router);

  protected look(m: SimMessage): StatusLook {
    return m.latest ? lookOf(m.latest) : QUEUED;
  }

  protected scenario(m: SimMessage): string {
    return scenarioLabel(m.recipients[0]);
  }

  protected ago(value: string): string {
    return timeAgo(value);
  }

  protected full(value: string): string {
    return fullDate(value);
  }

  protected open(m: SimMessage): void {
    void this.router.navigate(['/messages', m.id]);
  }
}
