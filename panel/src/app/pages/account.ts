import { Component, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { Router } from '@angular/router';
import { DomSanitizer, type SafeHtml } from '@angular/platform-browser';
import QRCode from 'qrcode';
import { Api } from '../core/api';
import { Session } from '../core/session';
import { Modal, Toasts } from '../ui/ui';

@Component({
  selector: 'app-account',
  imports: [FormsModule, Modal],
  template: `
    <div class="page page-narrow">
      <header class="page-head">
        <div>
          <h1>Cuenta</h1>
          <p>Tus datos, tu contraseña, y qué hacer con tu cuenta.</p>
        </div>
      </header>

      <div class="stack">
        <form class="card" (ngSubmit)="saveProfile()">
          <header class="card-head"><h2>Perfil</h2></header>
          <div class="card-body">
            <div class="field">
              <label for="name">Nombre</label>
              <input id="name" class="input" name="name" required autocomplete="name" [(ngModel)]="name" />
            </div>
            <div class="field field-last">
              <label for="email">Correo electrónico</label>
              <input id="email" class="input" name="email" [value]="session.user()?.email" disabled />
            </div>
          </div>
          <footer class="card-foot">
            <span></span>
            <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy() || !name.trim() || name.trim() === session.user()?.name">
              Guardar
            </button>
          </footer>
        </form>

        <form class="card" (ngSubmit)="changePassword()">
          <header class="card-head">
            <div>
              <h2>Contraseña</h2>
              <p class="muted small">Al cambiarla se cierran tus otras sesiones.</p>
            </div>
          </header>
          <div class="card-body">
            @if (error()) {
              <p class="form-error" role="alert">{{ error() }}</p>
            }
            <div class="field">
              <label for="current">Contraseña actual</label>
              <input id="current" class="input" type="password" name="current" autocomplete="current-password" required [(ngModel)]="current" />
            </div>
            <div class="field field-last">
              <label for="next">Contraseña nueva</label>
              <input id="next" class="input" type="password" name="next" autocomplete="new-password" required [(ngModel)]="next" />
              <span class="hint">Al menos {{ minPassword() }} caracteres.</span>
            </div>
          </div>
          <footer class="card-foot">
            <span></span>
            <button type="submit" class="btn btn-primary btn-sm" [disabled]="busy() || !current || !next">Cambiar contraseña</button>
          </footer>
        </form>

        <section class="card">
          <header class="card-head">
            <div>
              <h2>Verificación en dos pasos</h2>
              <p class="muted small">
                Además de la contraseña, un código de tu app de autenticación (Google Authenticator, 1Password, Authy…) al entrar.
              </p>
            </div>
            @if (session.user()?.twoFactor) {
              <span class="badge" data-tone="good"><span class="badge-dot" aria-hidden="true"></span>Activada</span>
            }
          </header>
          @if (recovery().length) {
            <div class="card-body">
              <div class="callout"><span>Guarda estos códigos de recuperación en un lugar seguro: sirven una vez cada uno si pierdes el móvil, y no se volverán a mostrar.</span></div>
              <ul class="recovery-codes">
                @for (c of recovery(); track c) {
                  <li><code>{{ c }}</code></li>
                }
              </ul>
            </div>
            <footer class="card-foot">
              <span></span>
              <button type="button" class="btn btn-sm btn-primary" (click)="recovery.set([])">Ya los he guardado</button>
            </footer>
          } @else if (setup(); as s) {
            <form class="card-body two-factor-setup" (ngSubmit)="enable2fa()">
              <div class="qr" [innerHTML]="qr()"></div>
              <div class="stack">
                <p class="text-2">Escanea el código con tu app, o escribe esta clave: <code class="secret-key">{{ s.secret }}</code></p>
                <div class="field field-last">
                  <label for="totp">Código de 6 cifras</label>
                  <input id="totp" class="input mono" name="totp" inputmode="numeric" autocomplete="one-time-code" maxlength="7" required [(ngModel)]="totp" />
                </div>
                <div class="row">
                  <button type="button" class="btn btn-sm" (click)="setup.set(null)">Cancelar</button>
                  <button type="submit" class="btn btn-sm btn-primary" [disabled]="busy() || !totp.trim()">Activar</button>
                </div>
              </div>
            </form>
          } @else {
            <footer class="card-foot">
              <span></span>
              @if (session.user()?.twoFactor) {
                <button type="button" class="btn btn-sm" (click)="disabling.set(true)">Desactivar</button>
              } @else {
                <button type="button" class="btn btn-sm btn-primary" (click)="start2fa()" [disabled]="busy()">Activar</button>
              }
            </footer>
          }
        </section>

        <section class="card">
          <header class="card-head">
            <div>
              <h2>Tus datos</h2>
              <p class="muted small">
                Descarga en JSON todo lo que guardamos de tu cuenta y de tus proyectos: ajustes, plantillas, supresiones y los
                mensajes que aún se conservan. Sin contraseñas ni credenciales.
              </p>
            </div>
          </header>
          <footer class="card-foot">
            <span></span>
            <button type="button" class="btn btn-sm" (click)="exportData()" [disabled]="busy()">Exportar mis datos</button>
          </footer>
        </section>

        <section class="card danger-card">
          <header class="card-head">
            <div>
              <h2>Eliminar la cuenta</h2>
              <p class="muted small">
                Se borran tu cuenta y los proyectos de los que eres dueño, con todo lo que contienen. Dejas de tener acceso a
                los proyectos a los que te invitaron. No se puede deshacer.
              </p>
            </div>
          </header>
          <footer class="card-foot">
            <span></span>
            <button type="button" class="btn btn-sm btn-danger" (click)="deleting.set(true)">Eliminar mi cuenta</button>
          </footer>
        </section>
      </div>
    </div>

    <app-modal heading="Desactivar la verificación en dos pasos" [open]="disabling()" (closed)="disabling.set(false)">
      <form (ngSubmit)="disable2fa()">
        <div class="field">
          <label for="off-password">Contraseña</label>
          <input id="off-password" class="input" type="password" name="offPassword" autocomplete="current-password" required [(ngModel)]="password" />
        </div>
        <div class="field">
          <label for="off-code">Código de la app o de recuperación</label>
          <input id="off-code" class="input mono" name="offCode" autocomplete="one-time-code" required [(ngModel)]="totp" />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" (click)="disabling.set(false)">Cancelar</button>
          <button type="submit" class="btn btn-danger" [disabled]="busy() || !password || !totp.trim()">Desactivar</button>
        </div>
      </form>
    </app-modal>

    <app-modal heading="Eliminar la cuenta" [open]="deleting()" (closed)="deleting.set(false)">
      <form (ngSubmit)="deleteAccount()">
        <p class="text-2 modal-lede">Escribe tu contraseña para confirmar. Te recomendamos exportar antes tus datos.</p>
        <div class="field">
          <label for="delete-password">Contraseña</label>
          <input id="delete-password" class="input" type="password" name="password" autocomplete="current-password" required [(ngModel)]="password" />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" (click)="deleting.set(false)">Cancelar</button>
          <button type="submit" class="btn btn-danger" [disabled]="busy() || !password">Eliminar para siempre</button>
        </div>
      </form>
    </app-modal>
  `,
})
export class AccountPage {
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly toasts = inject(Toasts);
  protected readonly busy = signal(false);
  protected readonly error = signal('');
  protected readonly minPassword = signal(10);
  protected name = this.session.user()?.name ?? '';
  protected current = '';
  protected next = '';
  protected password = '';
  protected readonly deleting = signal(false);
  protected readonly disabling = signal(false);
  protected readonly setup = signal<{ secret: string; otpauthUrl: string } | null>(null);
  protected readonly qr = signal<SafeHtml>('');
  protected readonly recovery = signal<string[]>([]);
  protected totp = '';
  private readonly sanitizer = inject(DomSanitizer);

  protected async start2fa(): Promise<void> {
    await this.run(async () => {
      const setup = await this.api.setupTwoFactor();
      // Our own SVG, drawn here from the otpauth link: nothing from outside goes into it.
      this.qr.set(this.sanitizer.bypassSecurityTrustHtml(await QRCode.toString(setup.otpauthUrl, { type: 'svg', margin: 1, width: 168 })));
      this.totp = '';
      this.setup.set(setup);
    });
  }

  protected async enable2fa(): Promise<void> {
    await this.run(async () => {
      const { recoveryCodes } = await this.api.enableTwoFactor(this.totp.trim());
      this.setup.set(null);
      this.recovery.set(recoveryCodes);
      this.session.user.update((u) => u && { ...u, twoFactor: true });
      this.toasts.show('Verificación en dos pasos activada');
    });
  }

  protected async disable2fa(): Promise<void> {
    await this.run(async () => {
      await this.api.disableTwoFactor(this.password, this.totp.trim());
      this.disabling.set(false);
      this.password = '';
      this.totp = '';
      this.session.user.update((u) => u && { ...u, twoFactor: false });
      this.toasts.show('Verificación en dos pasos desactivada');
    });
  }

  private async run(action: () => Promise<void>): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await action();
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }
  private readonly router = inject(Router);

  constructor() {
    this.api.authConfig().then(
      (c) => this.minPassword.set(c.minPassword),
      () => undefined,
    );
  }

  protected async saveProfile(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      const { user } = await this.api.updateMe(this.name.trim());
      this.session.user.set(user);
      this.name = user.name;
      this.toasts.show('Perfil guardado');
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected async exportData(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.exportAccount();
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected async deleteAccount(): Promise<void> {
    if (this.busy()) return;
    this.busy.set(true);
    try {
      await this.api.deleteAccount(this.password);
      this.session.clear();
      await this.router.navigateByUrl('/login');
      this.toasts.show('Tu cuenta se ha eliminado');
    } catch (error) {
      this.toasts.error(error);
    } finally {
      this.busy.set(false);
    }
  }

  protected async changePassword(): Promise<void> {
    if (this.busy()) return;
    if (this.next.length < this.minPassword()) {
      this.error.set(`La contraseña nueva debe tener al menos ${this.minPassword()} caracteres.`);
      return;
    }
    this.busy.set(true);
    this.error.set('');
    try {
      await this.api.changePassword(this.current, this.next);
      this.current = '';
      this.next = '';
      this.toasts.show('Contraseña cambiada');
    } catch (error) {
      this.error.set(error instanceof Error ? error.message : String(error));
    } finally {
      this.busy.set(false);
    }
  }
}
