import { Injectable, computed, inject, signal } from '@angular/core';
import { Api, setCurrentMode, setCurrentProjectId } from './api';
import type { Project, User } from './types';

const PROJECT_STORAGE = 'relayo-sim.project';
const MODE_STORAGE = 'relayo-sim.mode';

/** Who is signed in, their projects and the one being worked on. */
@Injectable({ providedIn: 'root' })
export class Session {
  private readonly api = inject(Api);
  readonly user = signal<User | null>(null);
  readonly projects = signal<Project[]>([]);
  private readonly projectId = signal<string | null>(null);
  readonly project = computed<Project | null>(() => this.projects().find((p) => p.id === this.projectId()) ?? this.projects()[0] ?? null);
  private loaded: Promise<boolean> | null = null;
  /** Test (simulated) or live (real delivery) data in the panel. */
  readonly mode = signal<'test' | 'live'>(readMode());

  constructor() {
    setCurrentMode(this.mode());
  }

  setMode(mode: 'test' | 'live'): void {
    this.mode.set(mode);
    setCurrentMode(mode);
    try {
      localStorage.setItem(MODE_STORAGE, mode);
    } catch {
      // storage unavailable: the choice lasts until reload
    }
  }

  /** Loads the session once; resolves to whether someone is signed in. */
  ensure(): Promise<boolean> {
    this.loaded ??= this.api.me().then(
      ({ user, projects }) => {
        this.set(user, projects);
        return true;
      },
      () => false,
    );
    return this.loaded;
  }

  set(user: User, projects: Project[]): void {
    this.user.set(user);
    this.projects.set(projects);
    this.loaded = Promise.resolve(true);
    this.select(readStored() ?? projects[0]?.id ?? null);
  }

  select(projectId: string | null): void {
    const exists = this.projects().some((p) => p.id === projectId);
    const id = exists ? projectId : (this.projects()[0]?.id ?? null);
    this.projectId.set(id);
    setCurrentProjectId(id);
    try {
      if (id) localStorage.setItem(PROJECT_STORAGE, id);
    } catch {
      // storage unavailable: the choice lasts until reload
    }
  }

  addProject(project: Project): void {
    this.projects.update((list) => [...list.filter((p) => p.id !== project.id), project]);
    this.select(project.id);
  }

  replaceProject(project: Project): void {
    this.projects.update((list) => list.map((p) => (p.id === project.id ? project : p)));
  }

  clear(): void {
    this.user.set(null);
    this.projects.set([]);
    this.projectId.set(null);
    setCurrentProjectId(null);
    this.loaded = Promise.resolve(false);
  }
}

function readMode(): 'test' | 'live' {
  try {
    return localStorage.getItem(MODE_STORAGE) === 'live' ? 'live' : 'test';
  } catch {
    return 'test';
  }
}

function readStored(): string | null {
  try {
    return localStorage.getItem(PROJECT_STORAGE);
  } catch {
    return null;
  }
}
