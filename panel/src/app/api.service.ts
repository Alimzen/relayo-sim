import { HttpClient, HttpErrorResponse } from '@angular/common/http';
import { Injectable, computed, inject, signal } from '@angular/core';
import { firstValueFrom } from 'rxjs';

export interface Scenario {
  name: string;
  description: string;
  example: string;
}

export interface Recipient {
  address: string;
  scenario: { name: string; param?: string; source: 'address' | 'header' | 'default' };
}

export interface SimEvent {
  id: string;
  type: string;
  recipient: string;
  timestamp: string;
  messageId: string;
  providerMessageId: string;
  metadata?: Record<string, string>;
  bounceType?: 'hard' | 'soft' | 'block';
  reason?: string;
  smtpCode?: number;
  enhancedCode?: string;
  diagnostic?: string;
  url?: string;
  raw?: unknown;
}

export interface SimMessage {
  id: string;
  via: 'smtp' | 'api';
  relayoMessageId?: string;
  from: string;
  recipients: Recipient[];
  subject: string;
  metadata?: Record<string, string>;
  tags?: string[];
  createdAt: string;
}

export interface MessageDetail extends SimMessage {
  events: SimEvent[];
}

export interface Project {
  id: string;
  name: string;
  webhookUrl: string | null;
  createdAt: string;
}

export interface SendRequest {
  from: string;
  to: string[];
  subject: string;
  text: string;
  headers?: Record<string, string>;
  metadata?: Record<string, string>;
}

const KEY_STORAGE = 'relayo-sim.apiKey';

/** Talks to the Relayo Sim API with the project API key kept for this browser session. */
@Injectable({ providedIn: 'root' })
export class SimApi {
  private readonly http = inject(HttpClient);
  private readonly key = signal<string | null>(readKey());
  readonly signedIn = computed(() => this.key() !== null);

  async signIn(apiKey: string): Promise<Project> {
    const project = await this.request<Project>('GET', '/v1/project', undefined, apiKey.trim());
    this.key.set(apiKey.trim());
    try {
      sessionStorage.setItem(KEY_STORAGE, apiKey.trim());
    } catch {
      // storage unavailable: the key lives until the tab is reloaded
    }
    return project;
  }

  signOut(): void {
    this.key.set(null);
    try {
      sessionStorage.removeItem(KEY_STORAGE);
    } catch {
      // ignore
    }
  }

  scenarios() {
    return this.request<{ data: Scenario[] }>('GET', '/v1/scenarios').then((r) => r.data);
  }

  messages(limit = 50) {
    return this.request<{ data: SimMessage[] }>('GET', `/v1/messages?limit=${limit}`).then((r) => r.data);
  }

  message(id: string) {
    return this.request<MessageDetail>('GET', `/v1/messages/${encodeURIComponent(id)}`);
  }

  project() {
    return this.request<Project>('GET', '/v1/project');
  }

  updateProject(changes: { name?: string; webhookUrl?: string }) {
    return this.request<Project>('PATCH', '/v1/project', changes);
  }

  send(body: SendRequest) {
    return this.request<{ id: string; status: string }>('POST', '/v1/messages', body);
  }

  private async request<T>(method: string, url: string, body?: unknown, apiKey = this.key()): Promise<T> {
    try {
      return await firstValueFrom(
        this.http.request<T>(method, url, {
          body,
          headers: apiKey ? { Authorization: `Bearer ${apiKey}` } : {},
        }),
      );
    } catch (error) {
      if (error instanceof HttpErrorResponse && error.status === 401 && apiKey === this.key()) this.signOut();
      throw new Error(errorMessage(error));
    }
  }
}

function readKey(): string | null {
  try {
    return sessionStorage.getItem(KEY_STORAGE);
  } catch {
    return null;
  }
}

function errorMessage(error: unknown): string {
  if (error instanceof HttpErrorResponse) {
    const message = (error.error as { message?: string | string[] } | null)?.message;
    if (Array.isArray(message)) return message.join('; ');
    if (message) return message;
    if (error.status === 0) return 'No se puede conectar con Relayo Sim';
    return `Error ${error.status}`;
  }
  return error instanceof Error ? error.message : String(error);
}
