import { HttpClient, HttpErrorResponse, type HttpInterceptorFn } from '@angular/common/http';
import { Injectable, inject } from '@angular/core';
import { Router } from '@angular/router';
import { firstValueFrom, tap } from 'rxjs';
import type { ApiKey, MessageDetail, Project, ProjectStats, Scenario, SimMessage, User } from './types';

/** Sent with every request: the simulator refuses state-changing session requests without it (CSRF). */
export const CLIENT_HEADER = 'X-Relayo-Client';
export const PROJECT_HEADER = 'X-Relayo-Project';

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
  updateMe = (name: string) => this.call<{ user: User }>('PATCH', '/v1/auth/me', { name });
  changePassword = (current: string, next: string) => this.call<void>('POST', '/v1/auth/password', { current, next });

  // Projects
  projects = () => this.call<{ data: Project[] }>('GET', '/v1/projects').then((r) => r.data);
  createProject = (name: string) => this.call<Project & { apiKey: string }>('POST', '/v1/projects', { name });
  claimProject = (apiKey: string) => this.call<Project>('POST', '/v1/projects/claim', { apiKey });
  updateProject = (changes: { name?: string; webhookUrl?: string | null; reportsSmtpUrl?: string | null }) =>
    this.call<Project>('PATCH', '/v1/project', changes);
  stats = (days: number) => this.call<ProjectStats>('GET', `/v1/project/stats?days=${days}`);
  keys = () => this.call<{ data: ApiKey[] }>('GET', '/v1/project/keys').then((r) => r.data);
  createKey = (name: string) => this.call<ApiKey & { apiKey: string }>('POST', '/v1/project/keys', { name });
  revokeKey = (id: string) => this.call<void>('DELETE', `/v1/project/keys/${encodeURIComponent(id)}`);
  webhookSecret = () => this.call<{ webhookSecret: string }>('GET', '/v1/project/webhook-secret');
  rotateWebhookSecret = () => this.call<{ webhookSecret: string }>('POST', '/v1/project/webhook-secret/rotate');

  // Messages
  scenarios = () => this.call<{ data: Scenario[] }>('GET', '/v1/scenarios').then((r) => r.data);
  messages = (query: { limit?: number; before?: string; q?: string; status?: string } = {}) => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(query)) if (value !== undefined && value !== '') params.set(key, String(value));
    return this.call<{ data: SimMessage[] }>('GET', `/v1/messages?${params}`).then((r) => r.data);
  };
  message = (id: string) => this.call<MessageDetail>('GET', `/v1/messages/${encodeURIComponent(id)}`);
  send = (body: { from: string; to: string[]; subject: string; text: string; headers?: Record<string, string> }) =>
    this.call<{ id: string }>('POST', '/v1/messages', body);
  report = async (messageId: string, eventId: string): Promise<string> => {
    const url = `/v1/messages/${encodeURIComponent(messageId)}/events/${encodeURIComponent(eventId)}/report`;
    try {
      return await firstValueFrom(this.http.get(url, { responseType: 'text' }));
    } catch (error) {
      throw toApiError(error);
    }
  };

  private async call<T>(method: string, url: string, body?: unknown): Promise<T> {
    try {
      return await firstValueFrom(this.http.request<T>(method, url, { body }));
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
