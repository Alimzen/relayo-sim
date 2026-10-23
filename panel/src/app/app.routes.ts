import { inject } from '@angular/core';
import { Router, type CanActivateFn, type Routes } from '@angular/router';
import { Session } from './core/session';

const signedIn: CanActivateFn = async (_route, state) => {
  const router = inject(Router);
  const ok = await inject(Session).ensure();
  return ok || router.createUrlTree(['/login'], { queryParams: { next: state.url } });
};

const signedOut: CanActivateFn = async () => {
  const router = inject(Router);
  const ok = await inject(Session).ensure();
  return !ok || router.createUrlTree(['/overview']);
};

const page = (title: string) => `${title} · Relayo Sim`;

export const routes: Routes = [
  {
    path: 'login',
    canActivate: [signedOut],
    loadComponent: () => import('./pages/auth/login').then((m) => m.LoginPage),
    title: page('Entrar'),
  },
  {
    path: 'signup',
    canActivate: [signedOut],
    loadComponent: () => import('./pages/auth/signup').then((m) => m.SignupPage),
    title: page('Crear cuenta'),
  },
  {
    path: 'forgot-password',
    canActivate: [signedOut],
    loadComponent: () => import('./pages/auth/forgot-password').then((m) => m.ForgotPasswordPage),
    title: page('Recuperar contraseña'),
  },
  {
    path: 'reset-password',
    loadComponent: () => import('./pages/auth/reset-password').then((m) => m.ResetPasswordPage),
    title: page('Nueva contraseña'),
  },
  {
    path: 'verify-email',
    loadComponent: () => import('./pages/auth/verify-email').then((m) => m.VerifyEmailPage),
    title: page('Confirmar email'),
  },
  {
    path: '',
    canActivate: [signedIn],
    loadComponent: () => import('./layout/shell').then((m) => m.Shell),
    children: [
      { path: 'overview', loadComponent: () => import('./pages/overview').then((m) => m.OverviewPage), title: page('Resumen') },
      { path: 'messages', loadComponent: () => import('./pages/messages').then((m) => m.MessagesPage), title: page('Mensajes') },
      {
        path: 'messages/:id',
        loadComponent: () => import('./pages/message-detail').then((m) => m.MessageDetailPage),
        title: page('Mensaje'),
      },
      { path: 'send', loadComponent: () => import('./pages/compose').then((m) => m.ComposePage), title: page('Enviar') },
      { path: 'scheduled', loadComponent: () => import('./pages/scheduled').then((m) => m.ScheduledPage), title: page('Programados') },
      { path: 'templates', loadComponent: () => import('./pages/templates').then((m) => m.TemplatesPage), title: page('Plantillas') },
      { path: 'scenarios', loadComponent: () => import('./pages/scenarios').then((m) => m.ScenariosPage), title: page('Escenarios') },
      { path: 'keys', loadComponent: () => import('./pages/keys').then((m) => m.KeysPage), title: page('Claves de API') },
      { path: 'connections', loadComponent: () => import('./pages/connections').then((m) => m.ConnectionsPage), title: page('Conexiones') },
      { path: 'domains', loadComponent: () => import('./pages/domains').then((m) => m.DomainsPage), title: page('Dominios') },
      { path: 'suppressions', loadComponent: () => import('./pages/suppressions').then((m) => m.SuppressionsPage), title: page('Supresiones') },
      { path: 'webhooks', loadComponent: () => import('./pages/webhooks').then((m) => m.WebhooksPage), title: page('Webhooks') },
      { path: 'settings', loadComponent: () => import('./pages/settings').then((m) => m.SettingsPage), title: page('Ajustes') },
      { path: 'account', loadComponent: () => import('./pages/account').then((m) => m.AccountPage), title: page('Cuenta') },
      { path: 'admin', loadComponent: () => import('./pages/admin').then((m) => m.AdminPage), title: page('Administración') },
      { path: '', pathMatch: 'full', redirectTo: 'overview' },
    ],
  },
  { path: '**', redirectTo: 'overview' },
];
