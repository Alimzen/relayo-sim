import { Component, ElementRef, computed, inject, signal } from '@angular/core';
import { FormsModule } from '@angular/forms';
import { NavigationEnd, Router, RouterLink, RouterLinkActive, RouterOutlet } from '@angular/router';
import {
  LucideChevronsUpDown,
  LucideClock,
  LucideFileText,
  LucideFlaskConical,
  LucideKeyRound,
  LucideLayoutDashboard,
  LucideGlobe,
  LucideLink,
  LucideLogOut,
  LucidePlug,
  LucideShieldBan,
  LucideZap,
  LucideMail,
  LucideMenu,
  LucidePlus,
  LucideSend,
  LucideSettings,
  LucideShieldCheck,
  LucideTriangleAlert,
  LucideUser,
  LucideUsers,
  LucideHistory,
  LucideGauge,
  LucideInbox,
  LucideWebhook,
} from '@lucide/angular';
import { Api } from '../core/api';
import { initials } from '../core/format';
import { Session } from '../core/session';
import { Brand, CopyButton, Modal, Toasts } from '../ui/ui';

@Component({
  selector: 'app-shell',
  imports: [
    FormsModule,
    RouterOutlet,
    RouterLink,
    RouterLinkActive,
    Brand,
    Modal,
    CopyButton,
    LucideChevronsUpDown,
    LucideClock,
    LucideFileText,
    LucideFlaskConical,
    LucideKeyRound,
    LucideLayoutDashboard,
    LucideGlobe,
    LucideLink,
    LucideLogOut,
    LucidePlug,
    LucideShieldBan,
    LucideZap,
    LucideMail,
    LucideMenu,
    LucidePlus,
    LucideSend,
    LucideSettings,
    LucideShieldCheck,
    LucideTriangleAlert,
    LucideUser,
    LucideUsers,
    LucideHistory,
    LucideGauge,
    LucideInbox,
    LucideWebhook,
  ],
  host: { '(document:click)': 'outside($event)', '(document:keydown.escape)': 'closeMenus()' },
  template: `
    <div class="shell">
      @if (drawer()) {
        <div class="scrim" (click)="drawer.set(false)" aria-hidden="true"></div>
      }
      <aside class="sidebar" [class.open]="drawer()" aria-label="Navegación">
        <a routerLink="/overview" class="brand-link"><app-brand /></a>

        <div class="switcher">
          <button
            type="button"
            class="switcher-button"
            (click)="toggle('projects', $event)"
            [attr.aria-expanded]="menu() === 'projects'"
            aria-haspopup="menu"
          >
            <span class="avatar project-avatar" aria-hidden="true">{{ initials(project()?.name ?? '?') }}</span>
            <span class="switcher-text">
              <small>Proyecto</small>
              <span class="truncate">{{ project()?.name ?? 'Sin proyecto' }}</span>
            </span>
            <svg lucideChevronsUpDown [size]="14" class="muted"></svg>
          </button>
          @if (menu() === 'projects') {
            <div class="menu menu-down" role="menu">
              <p class="menu-label">Tus proyectos</p>
              @for (p of session.projects(); track p.id) {
                <button
                  type="button"
                  class="menu-item"
                  role="menuitemradio"
                  [attr.aria-checked]="p.id === project()?.id"
                  (click)="switchTo(p.id)"
                >
                  <span class="avatar project-avatar" aria-hidden="true">{{ initials(p.name) }}</span>
                  <span class="truncate">{{ p.name }}</span>
                  @if (p.role && p.role !== 'owner') {
                    <small class="menu-note">{{ p.role === 'admin' ? 'admin' : 'miembro' }}</small>
                  }
                </button>
              }
              <div class="menu-sep"></div>
              <button type="button" class="menu-item" role="menuitem" (click)="openModal('create')">
                <svg lucidePlus [size]="15"></svg>Nuevo proyecto
              </button>
              <button type="button" class="menu-item" role="menuitem" (click)="openModal('claim')">
                <svg lucideLink [size]="15"></svg>Vincular proyecto existente
              </button>
            </div>
          }
        </div>

        <div class="mode-switch" role="group" aria-label="Modo">
          <button type="button" [attr.aria-pressed]="session.mode() === 'test'" (click)="setMode('test')">Prueba</button>
          <button type="button" [attr.aria-pressed]="session.mode() === 'live'" (click)="setMode('live')" class="mode-live">En vivo</button>
        </div>

        <nav>
          <a class="nav-link" routerLink="/overview" routerLinkActive="active"><svg lucideLayoutDashboard [size]="16"></svg>Resumen</a>
          <a class="nav-link" routerLink="/messages" routerLinkActive="active"><svg lucideMail [size]="16"></svg>Mensajes</a>
          <a class="nav-link" routerLink="/deliverability" routerLinkActive="active"><svg lucideGauge [size]="16"></svg>Entregabilidad</a>
          <a class="nav-link" routerLink="/inbox" routerLinkActive="active"><svg lucideInbox [size]="16"></svg>Recibidos</a>
          <a class="nav-link" routerLink="/send" routerLinkActive="active"><svg lucideSend [size]="16"></svg>Enviar</a>
          <a class="nav-link" routerLink="/templates" routerLinkActive="active"><svg lucideFileText [size]="16"></svg>Plantillas</a>
          <a class="nav-link" routerLink="/scheduled" routerLinkActive="active"><svg lucideClock [size]="16"></svg>Programados</a>
          <a class="nav-link" routerLink="/scenarios" routerLinkActive="active"><svg lucideFlaskConical [size]="16"></svg>Escenarios</a>
          <p class="nav-section">Proyecto</p>
          @if (projectAdmin()) {
            <a class="nav-link" routerLink="/keys" routerLinkActive="active"><svg lucideKeyRound [size]="16"></svg>Claves de API</a>
            <a class="nav-link" routerLink="/connections" routerLinkActive="active"><svg lucidePlug [size]="16"></svg>Conexiones</a>
            <a class="nav-link" routerLink="/domains" routerLinkActive="active"><svg lucideGlobe [size]="16"></svg>Dominios</a>
          }
          <a class="nav-link" routerLink="/suppressions" routerLinkActive="active"><svg lucideShieldBan [size]="16"></svg>Supresiones</a>
          @if (projectAdmin()) {
            <a class="nav-link" routerLink="/webhooks" routerLinkActive="active"><svg lucideWebhook [size]="16"></svg>Webhooks</a>
          }
          <a class="nav-link" routerLink="/activity" routerLinkActive="active"><svg lucideHistory [size]="16"></svg>Actividad</a>
          <a class="nav-link" routerLink="/team" routerLinkActive="active"><svg lucideUsers [size]="16"></svg>Equipo</a>
          <a class="nav-link" routerLink="/settings" routerLinkActive="active"><svg lucideSettings [size]="16"></svg>Ajustes</a>
          @if (session.user()?.admin) {
            <p class="nav-section">Plataforma</p>
            <a class="nav-link" routerLink="/admin" routerLinkActive="active"><svg lucideShieldCheck [size]="16"></svg>Administración</a>
          }
        </nav>

        <div class="sidebar-foot user-button">
          <button
            type="button"
            class="user-trigger"
            (click)="toggle('user', $event)"
            [attr.aria-expanded]="menu() === 'user'"
            aria-haspopup="menu"
          >
            <span class="avatar" aria-hidden="true">{{ initials(session.user()?.name ?? '') }}</span>
            <span class="user-text">
              <span class="truncate">{{ session.user()?.name }}</span>
              <small class="truncate">{{ session.user()?.email }}</small>
            </span>
          </button>
          @if (menu() === 'user') {
            <div class="menu menu-up" role="menu">
              <a class="menu-item" role="menuitem" routerLink="/account"><svg lucideUser [size]="15"></svg>Cuenta</a>
              <button type="button" class="menu-item" role="menuitem" (click)="logout()"><svg lucideLogOut [size]="15"></svg>Salir</button>
            </div>
          }
        </div>
      </aside>

      <div class="main">
        <header class="mobile-bar">
          <button type="button" class="icon-button" (click)="drawer.set(true)" aria-label="Abrir menú"><svg lucideMenu [size]="18"></svg></button>
          <app-brand />
        </header>
        @if (session.user() && !session.user()!.emailVerified) {
          <div class="verify-banner" role="status">
            <svg lucideMail [size]="14"></svg>
            <span>Confirma tu email (<strong>{{ session.user()!.email }}</strong>) para usar el modo en vivo.</span>
            <button type="button" class="link-button" (click)="resend()" [disabled]="busy()">Reenviar enlace</button>
          </div>
        }
        @if (session.mode() === 'live') {
          <div class="live-banner" role="status">
            <svg lucideZap [size]="14"></svg>
            Modo en vivo: ves los envíos reales, entregados por tus conexiones.
          </div>
        }
        @if (project(); as current) {
          <!-- Keyed by project and mode: switching either recreates the page, so it loads that data. -->
          @for (id of [current.id + ':' + session.mode()]; track id) {
            <router-outlet />
          }
        } @else {
          <div class="page">
            <div class="card card-pad">
              <h2>No tienes proyectos</h2>
              <p class="muted no-projects">Crea uno para empezar a enviar mensajes al simulador, o vincula uno que ya tengas.</p>
              <div class="row">
                <button type="button" class="btn btn-primary" (click)="openModal('create')"><svg lucidePlus [size]="15"></svg>Nuevo proyecto</button>
                <button type="button" class="btn" (click)="openModal('claim')"><svg lucideLink [size]="15"></svg>Vincular proyecto</button>
              </div>
            </div>
          </div>
        }
      </div>
    </div>

    <app-modal heading="Nuevo proyecto" [open]="modal() === 'create'" (closed)="closeModal()">
      @if (created(); as key) {
        <div class="callout"><svg lucideTriangleAlert [size]="15"></svg><span>Copia la clave ahora: no se volverá a mostrar.</span></div>
        <div class="field modal-gap">
          <span class="label">Clave de API</span>
          <div class="secret"><code>{{ key }}</code><app-copy [value]="key" label="Copiar clave" /></div>
        </div>
        <div class="modal-actions"><button type="button" class="btn btn-primary" (click)="closeModal()">Hecho</button></div>
      } @else {
        <form (ngSubmit)="create()">
          <div class="field">
            <label for="project-name">Nombre</label>
            <input id="project-name" class="input" name="name" required [(ngModel)]="newName" placeholder="Mi aplicación" />
          </div>
          <div class="modal-actions">
            <button type="button" class="btn" (click)="closeModal()">Cancelar</button>
            <button type="submit" class="btn btn-primary" [disabled]="busy() || !newName.trim()">Crear proyecto</button>
          </div>
        </form>
      }
    </app-modal>

    <app-modal heading="Vincular proyecto existente" [open]="modal() === 'claim'" (closed)="closeModal()">
      <form (ngSubmit)="claim()">
        <p class="muted modal-lede">
          Los proyectos creados antes de las cuentas no tienen dueño. Pega una de sus claves de API para añadirlo a tu cuenta.
        </p>
        <div class="field">
          <label for="claim-key">Clave de API</label>
          <input
            id="claim-key"
            class="input mono"
            name="apiKey"
            required
            autocomplete="off"
            [(ngModel)]="claimKey"
            placeholder="rly_test_… o sim_live_…"
          />
        </div>
        <div class="modal-actions">
          <button type="button" class="btn" (click)="closeModal()">Cancelar</button>
          <button type="submit" class="btn btn-primary" [disabled]="busy() || !claimKey.trim()">Vincular</button>
        </div>
      </form>
    </app-modal>
  `,
})
export class Shell {
  protected readonly session = inject(Session);
  private readonly api = inject(Api);
  private readonly router = inject(Router);
  private readonly toasts = inject(Toasts);
  private readonly host = inject<ElementRef<HTMLElement>>(ElementRef);
  protected readonly initials = initials;
  protected readonly project = computed(() => this.session.project());
  /** Members (not admins) do not see keys, connections, domains or webhooks: the API refuses them those. */
  protected readonly projectAdmin = computed(() => this.project()?.role !== 'member');
  protected readonly menu = signal<'projects' | 'user' | null>(null);
  protected readonly drawer = signal(false);
  protected readonly modal = signal<'create' | 'claim' | null>(null);
  protected readonly busy = signal(false);
  protected readonly created = signal<string | null>(null);
  protected newName = '';
  protected claimKey = '';

  constructor() {
    this.router.events.subscribe((event) => {
      if (event instanceof NavigationEnd) {
        this.drawer.set(false);
        this.menu.set(null);
      }
    });
  }

  protected toggle(menu: 'projects' | 'user', event: Event): void {
    event.stopPropagation();
    this.menu.update((current) => (current === menu ? null : menu));
  }

  protected outside(event: Event): void {
    if (!this.menu()) return;
    const open = this.host.nativeElement.querySelector('.menu');
    const target = event.target as Node | null;
    if (!open || !target || !open.contains(target)) this.menu.set(null);
  }

  protected closeMenus(): void {
    this.menu.set(null);
  }

  protected setMode(mode: 'test' | 'live'): void {
    if (mode === this.session.mode()) return;
    this.session.setMode(mode);
    if (this.router.url.startsWith('/messages/')) void this.router.navigateByUrl('/messages');
  }

  protected async switchTo(id: string): Promise<void> {
    this.menu.set(null);
    if (id === this.project()?.id) return;
    this.session.select(id);
    if (this.router.url.startsWith('/messages/')) await this.router.navigateByUrl('/messages');
  }

  protected openModal(modal: 'create' | 'claim'): void {
    this.menu.set(null);
    this.drawer.set(false);
    this.newName = '';
    this.claimKey = '';
    this.created.set(null);
    this.modal.set(modal);
  }

  protected closeModal(): void {
    this.modal.set(null);
    this.created.set(null);
  }

  protected async create(): Promise<void> {
    await this.run(async () => {
      const { apiKey, ...project } = await this.api.createProject(this.newName.trim());
      this.session.addProject(project);
      this.created.set(apiKey);
      this.toasts.show(`Proyecto «${project.name}» creado`);
    });
  }

  protected async claim(): Promise<void> {
    await this.run(async () => {
      const project = await this.api.claimProject(this.claimKey.trim());
      this.session.addProject(project);
      this.closeModal();
      this.toasts.show(`Proyecto «${project.name}» vinculado a tu cuenta`);
    });
  }

  protected async resend(): Promise<void> {
    await this.run(async () => {
      await this.api.resendVerification();
      this.toasts.show('Enlace enviado: revisa tu bandeja de entrada');
    });
  }

  protected async logout(): Promise<void> {
    this.menu.set(null);
    try {
      await this.api.logout();
    } catch {
      // the session is dropped locally either way
    }
    this.session.clear();
    await this.router.navigateByUrl('/login');
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
}
