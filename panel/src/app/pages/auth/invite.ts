import { Component, computed, inject, input, signal, type OnInit } from '@angular/core';
import { Router, RouterLink } from '@angular/router';
import { Api } from '../../core/api';
import { Session } from '../../core/session';
import type { InviteInfo } from '../../core/types';
import { Brand } from '../../ui/ui';

/** An invitation link: what it is for, and accepting it with the right account. */
@Component({
  selector: 'app-invite',
  imports: [RouterLink, Brand],
  template: `
    <main class="auth">
      <a href="/" class="brand-link" aria-label="Relayo, inicio"><app-brand /></a>
      <div class="card auth-card">
        @if (error()) {
          <h1>Invitación no válida</h1>
          <p class="lede">{{ error() }}</p>
          <a class="btn btn-primary btn-block" routerLink="/overview">Ir al panel</a>
        } @else if (info(); as i) {
          <h1>Únete a «{{ i.project }}»</h1>
          <p class="lede">
            {{ i.invitedBy || 'Alguien' }} te invita como {{ i.role === 'admin' ? 'administrador' : 'miembro' }}. La invitación es para
            <strong>{{ i.email }}</strong>.
          </p>
          @if (!signedIn()) {
            <a class="btn btn-primary btn-block" routerLink="/signup" [queryParams]="{ next: here(), email: i.email, invite: token() }">Crear cuenta con ese email</a>
            <p class="auth-alt">¿Ya tienes cuenta? <a routerLink="/login" [queryParams]="{ next: here() }">Entrar</a></p>
          } @else if (wrongAccount()) {
            <p class="form-error" role="alert">Has entrado como {{ session.user()?.email }}. Sal y entra con {{ i.email }} para aceptarla.</p>
          } @else {
            <button type="button" class="btn btn-primary btn-block" (click)="accept()" [disabled]="busy()">
              {{ busy() ? 'Uniéndote…' : 'Aceptar la invitación' }}
            </button>
          }
        } @else {
          <h1>Cargando la invitación…</h1>
          <div class="skeleton"></div>
        }
      </div>
    </main>
  `,
})
export class InvitePage implements OnInit {
  readonly token = input<string>();
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  protected readonly session = inject(Session);
  protected readonly info = signal<InviteInfo | null>(null);
  protected readonly error = signal('');
  protected readonly busy = signal(false);
  protected readonly signedIn = signal(false);
  protected readonly wrongAccount = computed(() => {
    const email = this.session.user()?.email;
    return !!email && !!this.info() && email.toLowerCase() !== this.info()!.email;
  });

  protected here(): string {
    return `/invite?token=${encodeURIComponent(this.token() ?? '')}`;
  }

  async ngOnInit(): Promise<void> {
    const token = this.token();
    if (!token) {
      this.error.set('Abre el enlace tal como llegó en el correo.');
      return;
    }
    const [info, signedIn] = await Promise.all([this.api.describeInvite(token).catch((e: unknown) => e as Error), this.session.ensure()]);
    this.signedIn.set(signedIn);
    if (info instanceof Error) this.error.set(info.message);
    else this.info.set(info);
  }

  protected async accept(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const { project, emailVerified } = await this.api.acceptInvite(this.token()!);
      this.session.addProject(project);
      const user = this.session.user();
      if (user && emailVerified && !user.emailVerified) this.session.user.set({ ...user, emailVerified: true });
      await this.router.navigateByUrl('/overview');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
