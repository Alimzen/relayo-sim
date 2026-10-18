import { inject } from '@angular/core';
import { Router, type Routes } from '@angular/router';
import { SimApi } from './api.service';

const signedIn = () => inject(SimApi).signedIn() || inject(Router).parseUrl('/login');

export const routes: Routes = [
  { path: 'login', loadComponent: () => import('./pages/login').then((m) => m.LoginPage), title: 'Entrar · Relayo Sim' },
  {
    path: 'messages',
    canActivate: [signedIn],
    loadComponent: () => import('./pages/messages').then((m) => m.MessagesPage),
    title: 'Mensajes · Relayo Sim',
  },
  {
    path: 'messages/:id',
    canActivate: [signedIn],
    loadComponent: () => import('./pages/message-detail').then((m) => m.MessageDetailPage),
    title: 'Mensaje · Relayo Sim',
  },
  {
    path: 'scenarios',
    canActivate: [signedIn],
    loadComponent: () => import('./pages/scenarios').then((m) => m.ScenariosPage),
    title: 'Escenarios · Relayo Sim',
  },
  {
    path: 'settings',
    canActivate: [signedIn],
    loadComponent: () => import('./pages/settings').then((m) => m.SettingsPage),
    title: 'Proyecto · Relayo Sim',
  },
  { path: '', pathMatch: 'full', redirectTo: 'messages' },
  { path: '**', redirectTo: 'messages' },
];
