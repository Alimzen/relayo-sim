import { HttpClient, HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom, tap } from 'rxjs';
import type { WebhookDelivery, WebhookDeliveryDetail, WebhookStats, ManagedAccess, ManagedRequest, ApiKey, Connection, Provider, SendingDomain, Suppression, MessageContent, MessageDetail, Project, ProjectStats, ProjectUsage, Scenario, SimMessage, User } from './types';

/** Sent with every request: the simulator refuses state-changing session requests without it (CSRF). */
export const CLIENT_HEADER = 'X-Relayo-Client';
export const PROJECT_HEADER = 'X-Relayo-Project';
export const MODE_HEADER = 'X-Relayo-Mode';

let currentMode: 'test' | 'live' = 'test';
/** The mode the panel shows: test (simulated) or live (real delivery). Set by the session. */
export function setCurrentMode(mode: 'test' | 'live'): void {
  currentMode = mode;
}

/** Error with the API's own message, ready to show. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
  }
}

let currentProjectId: string | null = null;
/** The project every project-scoped request is about. Set by the session. */
export function setCurrentProjectId(id: string | null): void {
  currentProjectId = id;
}

/** Adds the panel headers and sends the session cookie. A 401 sends the user to the sign-in page. */
export const panelInterceptor: HttpInterceptorFn = (req, next) => {
  const router = inject(Router);
  const headers: Record<string, string> = { [CLIENT_HEADER]: 'panel' };
  if (currentProjectId && !req.headers.has(PROJECT_HEADER)) headers[PROJECT_HEADER] = currentProjectId;
  if (!req.headers.has(MODE_HEADER)) headers[MODE_HEADER] = currentMode;
  return next(req.clone({ setHeaders: headers, withCredentials: true })).pipe(
    tap({
      error: (error: unknown) => {
        const auth = req.url.startsWith('/v1/auth/');
        if (error instanceof HttpErrorResponse && error.status === 401 && !auth && !router.url.startsWith('/login')) {
          void router.navigate(['/login'], { queryParams: { next: router.url } });
        }
      },
    }),
  );
};

@Injectable({ providedIn: 'root' })
export class Api {
  private readonly http = inject(HttpClient);

  // Auth
  authConfig = () => this.call<{ signup: boolean; minPassword: number }>('GET', '/v1/auth/config');
  me = () => this.call<{ user: User; projects: Project[] }>('GET', '/v1/auth/me');
  login = (email: string, password: string) =>
    this.call<{ user: User; projects: Project[] }>('POST', '/v1/auth/login', { email, password });
  signup = (name: string, email: string, password: string) =>
    this.call<{ user: User; projects: Project[] }>('POST', '/v1/auth/signup', { name, email, password });
  logout = () => this.call<void>('POST', '/v1/auth/logout');
  forgotPassword = (email: string) => this.call<void>('POST', '/v1/auth/forgot', { email });
  resetPassword = (token: string, password: string) =>
    this.call<{ user: User; projects: Project[] }>('POST', '/v1/auth/reset', { token, password });
  updateMe = (name: string) => this.call<{ user: User }>('PATCH', '/v1/auth/me', { name });
  changePassword = (current: string, next: string) => this.call<void>('POST', '/v1/auth/password', { current, next });
  verifyEmail = (token: string) => this.call<{ user: User }>('POST', '/v1/auth/verify', { token });
  resendVerification = () => this.call<void>('POST', '/v1/auth/verify/resend');

  // Platform admin
  managedRequests = () => this.call<{ data: ManagedRequest[] }>('GET', '/v1/admin/managed').then((r) => r.data);
  decideManagedAccess = (projectId: string, decision: 'approved' | 'denied') =>
    this.call<Project>('POST', `/v1/admin/managed/${encodeURIComponent(projectId)}`, { decision });

  // Projects
  projects = () => this.call<{ data: Project[] }>('GET', '/v1/projects').then((r) => r.data);
  createProject = (name: string) => this.call<Project & { apiKey: string }>('POST', '/v1/projects', { name });
  claimProject = (apiKey: string) => this.call<Project>('POST', '/v1/projects/claim', { apiKey });
  updateProject = (changes: { name?: string; webhookUrl?: string | null; reportsSmtpUrl?: string | null }) =>
    this.call<Project>('PATCH', '/v1/project', changes);
  usage = () => this.call<ProjectUsage>('GET', '/v1/project/usage');
  stats = (days: number) => this.call<ProjectStats>('GET', `/v1/project/stats?days=${days}`);
  keys = () => this.call<{ data: ApiKey[] }>('GET', '/v1/project/keys').then((r) => r.data);
  createKey = (name: string, mode: 'test' | 'live') => this.call<ApiKey & { apiKey: string }>('POST', '/v1/project/keys', { name, mode });

  // Live delivery
  providers = () => this.call<{ data: Provider[] }>('GET', '/v1/project/providers').then((r) => r.data);
  connections = () => this.call<{ data: Connection[] }>('GET', '/v1/project/connections').then((r) => r.data);
  createConnection = (body: { name: string; provider: string; values: Record<string, string> }) =>
    this.call<Connection>('POST', '/v1/project/connections', body);
  updateConnection = (id: string, body: { name?: string; values?: Record<string, string> }) =>
    this.call<Connection>('PATCH', `/v1/project/connections/${encodeURIComponent(id)}`, body);
  deleteConnection = (id: string) => this.call<void>('DELETE', `/v1/project/connections/${encodeURIComponent(id)}`);
  reorderConnections = (ids: string[]) => this.call<void>('POST', '/v1/project/connections/order', { ids });
  testConnection = (id: string, body: { to: string; from?: string }) =>
    this.call<{ id: string }>('POST', `/v1/project/connections/${encodeURIComponent(id)}/test`, body);
  domains = () => this.call<{ available: boolean; access: ManagedAccess | null; data: SendingDomain[] }>('GET', '/v1/project/domains');
  requestManagedAccess = () => this.call<{ access: ManagedAccess }>('POST', '/v1/project/managed-access');
  addDomain = (domain: string) => this.call<SendingDomain>('POST', '/v1/project/domains', { domain });
  verifyDomain = (id: string) => this.call<SendingDomain>('POST', `/v1/project/domains/${encodeURIComponent(id)}/verify`);
  deleteDomain = (id: string) => this.call<void>('DELETE', `/v1/project/domains/${encodeURIComponent(id)}`);
  suppressions = () => this.call<{ data: Suppression[] }>('GET', '/v1/project/suppressions').then((r) => r.data);
  addSuppression = (address: string) => this.call<void>('POST', '/v1/project/suppressions', { address });
  removeSuppression = (address: string) => this.call<void>('DELETE', `/v1/project/suppressions/${encodeURIComponent(address)}`);
  revokeKey = (id: string) => this.call<void>('DELETE', `/v1/project/keys/${encodeURIComponent(id)}`);
  webhookSecret = () => this.call<{ webhookSecret: string }>('GET', '/v1/project/webhook-secret');
  rotateWebhookSecret = () => this.call<{ webhookSecret: string }>('POST', '/v1/project/webhook-secret/rotate');
  webhookDeliveries = (query: { limit?: number; before?: string; status?: 'failed' } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined) params.set(key, String(value));
    return this.call<{ data: WebhookDelivery[] }>('GET', `/v1/project/webhook/deliveries?${params}`).then((r) => r.data);
  };
  webhookDelivery = (id: string) => this.call<WebhookDeliveryDetail>('GET', `/v1/project/webhook/deliveries/${encodeURIComponent(id)}`);
  redeliverWebhook = (id: string) => this.call<WebhookDelivery>('POST', `/v1/project/webhook/deliveries/${encodeURIComponent(id)}/redeliver`);
  testWebhook = () => this.call<WebhookDelivery>('POST', '/v1/project/webhook/test');
  webhookStats = () => this.call<WebhookStats>('GET', '/v1/project/webhook/stats');

  // Messages
  scenarios = () => this.call<{ data: Scenario[] }>('GET', '/v1/scenarios').then((r) => r.data);
  messages = (query: { limit?: number; before?: string; q?: string; status?: string; channel?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
    return this.call<{ data: SimMessage[] }>('GET', `/v1/messages?${params}`).then((r) => r.data);
  };
  message = (id: string) => this.call<MessageDetail>('GET', `/v1/messages/${encodeURIComponent(id)}`);
  sendSms = (body: { from?: string; to: string[]; body: string }) =>
    this.call<{ id: string }>('POST', '/v1/sms', body, { [MODE_HEADER]: 'test' });
  content = (id: string) => this.call<MessageContent>('GET', `/v1/messages/${encodeURIComponent(id)}/content`);
  /** A file of a message (the original `.eml` or an attachment), fetched with the session and saved by the browser. */
  download = async (path: string, filename: string): Promise<void> => {
    let blob: Blob;
    try {
      blob = await firstValueFrom(this.http.get(path, { responseType: 'blob' }));
    } catch (error) {
      throw toApiError(error);
    }
    const url = URL.createObjectURL(blob);
    const link = Object.assign(document.createElement('a'), { href: url, download: filename });
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  /** Scenario sends are always simulated, whatever mode the panel shows. */
  send = (body: { from: string; to: string[]; subject: string; text: string; html?: string; headers?: Record<string, string> }) =>
    this.call<{ id: string }>('POST', '/v1/messages', body, { [MODE_HEADER]: 'test' });
  /** A message in the mode the panel shows: simulated in test mode, delivered for real in live mode. */
  sendMessage = (body: { from: string | { address: string; name: string }; to: string[]; subject: string; text?: string; html?: string }) =>
    this.call<{ id: string }>('POST', '/v1/messages', body);
  sendSmsMessage = (body: { from?: string; to: string[]; body: string }) => this.call<{ id: string }>('POST', '/v1/sms', body);
  report = async (messageId: string, eventId: string): Promise<string> => {
    const url = `/v1/messages/${encodeURIComponent(messageId)}/events/${encodeURIComponent(eventId)}/report`;
    try {
      return await firstValueFrom(this.http.get(url, { responseType: 'text' }));
    } catch (error) {
      throw toApiError(error);
    }
  };

  private async call<T>(method: string, url: string, body?: unknown, headers?: Record<string, string>): Promise<T> {
    try {
      return await firstValueFrom(this.http.request<T>(method, url, { body, ...(headers && { headers }) }));
    } catch (error) {
      throw toApiError(error);
    }
  }
}

function toApiError(error: unknown): ApiError {
  if (error instanceof HttpErrorResponse) {
    const message = (error.error as { message?: string | string[] } | null)?.message;
    if (Array.isArray(message)) return new ApiError(message.join('; '), error.status);
    if (typeof message === 'string' && message) return new ApiError(message, error.status);
    if (error.status === 0) return new ApiError('No se puede conectar con Relayo Sim.', 0);
    return new ApiError(`Error ${error.status}`, error.status);
  }
  return new ApiError(error instanceof Error ? error.message : String(error), 0);
}
