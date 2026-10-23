import { randomUUID } from 'node:crypto';
import type { Project, Template } from '../domain.js';
import type { SimStore } from '../store/store.js';

/** A template problem, with the message for the API (422 for missing variables, 400 otherwise). */
export class TemplateError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 | 422,
  ) {
    super(message);
  }
}

const ALIAS = /^[a-z0-9][a-z0-9_-]{0,63}$/;
/** `{{ name }}`, `{{ user.name }}`, and `{{{ html }}}` for values already in HTML. */
const TAG = /\{\{(\{)?\s*([A-Za-z_][\w]*(?:\.[A-Za-z_][\w]*)*)\s*\}?\}\}/g;

export type Variables = Record<string, unknown>;

/** The variable names a text uses, in order of first use. */
export function variablesOf(...texts: Array<string | undefined>): string[] {
  const names = new Set<string>();
  for (const text of texts) for (const match of (text ?? '').matchAll(TAG)) names.add(match[2]!);
  return [...names];
}

function lookup(variables: Variables, path: string): unknown {
  let value: unknown = variables;
  for (const part of path.split('.')) {
    if (value === null || typeof value !== 'object' || !Object.hasOwn(value, part)) return undefined;
    value = (value as Record<string, unknown>)[part];
  }
  return value;
}

const escapeHtml = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/**
 * Fills a text's variables. In HTML, values are escaped unless written with three braces. A variable with no
 * value is reported in `missing` rather than left empty: a half-filled email is worse than an error.
 */
export function fill(text: string, variables: Variables, html = false, missing?: Set<string>): string {
  return text.replace(TAG, (_, raw: string | undefined, path: string) => {
    const value = lookup(variables, path);
    if (value === undefined || value === null) {
      missing?.add(path);
      return '';
    }
    const string = typeof value === 'object' ? JSON.stringify(value) : String(value);
    return html && !raw ? escapeHtml(string) : string;
  });
}

function render(template: Template, variables: Variables): { rendered: RenderedEmail | RenderedSms; missing: Set<string> } {
  const missing = new Set<string>();
  if (template.channel === 'sms') return { rendered: { body: fill(template.body ?? '', variables, false, missing) }, missing };
  return {
    rendered: {
      subject: fill(template.subject ?? '', variables, false, missing),
      ...(template.html && { html: fill(template.html, variables, true, missing) }),
      ...(template.text && { text: fill(template.text, variables, false, missing) }),
    },
    missing,
  };
}

export interface RenderedEmail {
  subject: string;
  html?: string;
  text?: string;
}

export interface RenderedSms {
  body: string;
}

/** Templates of a project: saved emails and SMS that sends fill with variables. */
export class TemplatesService {
  constructor(private readonly store: SimStore) {}

  async create(project: Project, input: Record<string, unknown>): Promise<Template> {
    const channel = input.channel === 'sms' ? 'sms' : 'email';
    const now = new Date();
    const template: Template = {
      id: `tpl_${randomUUID()}`,
      projectId: project.id,
      alias: this.alias(input.alias),
      name: this.name(input.name, input.alias),
      channel,
      ...this.content(channel, input),
      createdAt: now,
      updatedAt: now,
    };
    if (await this.store.getTemplate(project.id, template.alias)) throw new TemplateError(`Ya hay una plantilla con el alias «${template.alias}»`, 409);
    await this.store.createTemplate(template);
    return template;
  }

  async update(project: Project, ref: string, input: Record<string, unknown>): Promise<Template> {
    const current = await this.get(project, ref);
    const alias = input.alias === undefined ? current.alias : this.alias(input.alias);
    if (alias !== current.alias && (await this.store.getTemplate(project.id, alias))) {
      throw new TemplateError(`Ya hay una plantilla con el alias «${alias}»`, 409);
    }
    // Missing fields keep their value; fields sent empty are cleared.
    const { subject: _s, html: _h, text: _t, body: _b, ...rest } = current;
    const next: Template = {
      ...rest,
      alias,
      name: input.name === undefined ? current.name : this.name(input.name, alias),
      ...this.content(current.channel, { ...current, ...input }),
      updatedAt: new Date(),
    };
    await this.store.updateTemplate(next);
    return next;
  }

  async get(project: Project, ref: string): Promise<Template> {
    const template = await this.store.getTemplate(project.id, ref);
    if (!template) throw new TemplateError(`No hay ninguna plantilla «${ref}» en este proyecto`, 404);
    return template;
  }

  async renderEmail(project: Project, ref: string, variables: Variables = {}): Promise<RenderedEmail> {
    const template = await this.get(project, ref);
    if (template.channel !== 'email') throw new TemplateError(`La plantilla «${template.alias}» es de SMS`, 400);
    const { rendered, missing } = render(template, variables);
    this.check(template, missing);
    return rendered as RenderedEmail;
  }

  async renderSms(project: Project, ref: string, variables: Variables = {}): Promise<RenderedSms> {
    const template = await this.get(project, ref);
    if (template.channel !== 'sms') throw new TemplateError(`La plantilla «${template.alias}» es de email`, 400);
    const { rendered, missing } = render(template, variables);
    this.check(template, missing);
    return rendered as RenderedSms;
  }

  /** For the editor: the template filled as far as the variables go, and which ones are missing. */
  async preview(project: Project, ref: string, variables: Variables = {}): Promise<{ rendered: RenderedEmail | RenderedSms; missing: string[] }> {
    const { rendered, missing } = render(await this.get(project, ref), variables);
    return { rendered, missing: [...missing] };
  }

  private check(template: Template, missing: Set<string>): void {
    if (missing.size) {
      throw new TemplateError(`Faltan variables para la plantilla «${template.alias}»: ${[...missing].join(', ')}`, 422);
    }
  }

  private alias(value: unknown): string {
    const alias = typeof value === 'string' ? value.trim().toLowerCase() : '';
    if (!ALIAS.test(alias)) throw new TemplateError('El alias usa minúsculas, números, «-» y «_» (por ejemplo, «bienvenida»)', 400);
    return alias;
  }

  private name(value: unknown, fallback: unknown): string {
    const name = typeof value === 'string' && value.trim() ? value.trim() : String(fallback ?? '');
    if (name.length > 80) throw new TemplateError('El nombre puede tener hasta 80 caracteres', 400);
    return name;
  }

  private content(channel: 'email' | 'sms', input: Record<string, unknown>): Pick<Template, 'subject' | 'html' | 'text' | 'body'> {
    const text = (key: string, max: number) => {
      const value = input[key];
      if (value === undefined || value === null || value === '') return undefined;
      if (typeof value !== 'string') throw new TemplateError(`«${key}» debe ser texto`, 400);
      if (value.length > max) throw new TemplateError(`«${key}» puede tener hasta ${max} caracteres`, 400);
      return value;
    };
    if (channel === 'sms') {
      const body = text('body', 1600);
      if (!body) throw new TemplateError('Una plantilla de SMS necesita el texto del mensaje', 400);
      return { body };
    }
    const subject = text('subject', 500);
    const html = text('html', 500_000);
    const plain = text('text', 200_000);
    if (!subject) throw new TemplateError('Una plantilla de email necesita asunto', 400);
    if (!html && !plain) throw new TemplateError('Una plantilla de email necesita HTML o texto', 400);
    return { subject, ...(html && { html }), ...(plain && { text: plain }) };
  }
}
