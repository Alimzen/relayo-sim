import 'reflect-metadata';
import type { INestApplication } from '@nestjs/common';
import type { AddressInfo } from 'node:net';
import { NestFactory } from '@nestjs/core';
import { SMTPServer } from 'smtp-server';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { AppModule } from '../src/app.module.js';

let app: INestApplication;
let base = '';
let smtp: SMTPServer;
const inbox: string[] = [];

beforeAll(async () => {
  smtp = new SMTPServer({
    authOptional: true,
    disabledCommands: ['STARTTLS', 'AUTH'],
    logger: false,
    onData(stream, _session, callback) {
      const chunks: Buffer[] = [];
      stream.on('data', (c: Buffer) => chunks.push(c));
      stream.on('end', () => {
        inbox.push(Buffer.concat(chunks).toString('utf8').replace(/=\r?\n/g, '').replace(/=3D/g, '='));
        callback();
      });
    },
  });
  await new Promise<void>((resolve) => smtp.listen(0, '127.0.0.1', resolve));
  const port = (smtp.server.address() as AddressInfo).port;
  app = await NestFactory.create(
    AppModule.forRoot({
      httpPort: 0,
      host: '127.0.0.1',
      timeScale: 0,
      maxHangMs: 300,
      signup: true,
      secureCookies: false,
      publicUrl: 'https://relayo.test',
      mail: { url: `smtp://127.0.0.1:${port}/?ignoreTLS=true`, from: 'Relayo <no-reply@relayo.test>' },
    }),
    { logger: false },
  );
  await app.listen(0, '127.0.0.1');
  base = await app.getUrl();
});

afterAll(async () => {
  await app.close();
  await new Promise<void>((resolve) => smtp.close(() => resolve()));
});

/** A browser: its own session cookie and the project it works on. */
function person() {
  let cookie = '';
  const me = {
    projectId: '',
    async call(method: string, path: string, body?: unknown) {
      const response = await fetch(`${base}${path}`, {
        method,
        headers: { 'content-type': 'application/json', cookie, 'x-relayo-client': 'panel', 'x-relayo-project': me.projectId },
        ...(body !== undefined && { body: JSON.stringify(body) }),
      });
      cookie = response.headers.get('set-cookie')?.split(';')[0] ?? cookie;
      return response;
    },
    async signup(email: string, name: string) {
      const response = await me.call('POST', '/v1/auth/signup', { email, name, password: 'una-clave-larga-1' });
      me.projectId = ((await response.json()) as { projects: Array<{ id: string }> }).projects[0]!.id;
    },
  };
  return me;
}

const inviteToken = (email: string) => {
  const mail = [...inbox].reverse().find((m) => m.includes(`To: ${email}`) && m.includes('/invite?token='))!;
  return /\/invite\?token=([\w-]+)/.exec(mail)![1]!;
};

describe('teams', () => {
  it('invites people by email, with roles that limit what members can do', async () => {
    const ana = person();
    await ana.signup('ana@empresa.com', 'Ana');
    const project = ana.projectId;

    const invited = await ana.call('POST', '/v1/project/team/invites', { email: 'Luis@Empresa.com', role: 'member' });
    expect(invited.status).toBe(201);
    expect(await invited.json()).toMatchObject({ email: 'luis@empresa.com', role: 'member' });
    const token = inviteToken('luis@empresa.com');
    expect(inbox.at(-1)).toContain('Ana te invita');

    const described = (await (await fetch(`${base}/v1/invites/${token}`)).json()) as Record<string, unknown>;
    expect(described).toMatchObject({ project: 'Mi primer proyecto', email: 'luis@empresa.com', role: 'member', invitedBy: 'Ana' });

    // Someone else cannot accept it.
    const eva = person();
    await eva.signup('eva@empresa.com', 'Eva');
    expect((await eva.call('POST', '/v1/invites/accept', { token })).status).toBe(403);

    const luis = person();
    await luis.signup('luis@empresa.com', 'Luis');
    const accepted = await luis.call('POST', '/v1/invites/accept', { token });
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ project: { id: project, role: 'member' }, emailVerified: true });
    expect((await luis.call('POST', '/v1/invites/accept', { token })).status).toBe(404);

    const projects = (await (await luis.call('GET', '/v1/projects')).json()) as { data: Array<{ id: string; role: string }> };
    expect(projects.data).toEqual(expect.arrayContaining([expect.objectContaining({ id: project, role: 'member' })]));

    // As a member: sees and sends, but no keys, credentials or settings.
    luis.projectId = project;
    expect((await luis.call('GET', '/v1/messages')).status).toBe(200);
    expect((await luis.call('POST', '/v1/project/templates', { alias: 'hola', subject: 'Hola', text: 'Hola' })).status).toBe(201);
    const keys = await luis.call('GET', '/v1/project/keys');
    expect(keys.status).toBe(403);
    expect(((await keys.json()) as { message: string }).message).toContain('administradores');
    expect((await luis.call('PATCH', '/v1/project', { name: 'Mío' })).status).toBe(403);
    expect((await luis.call('POST', '/v1/project/team/invites', { email: 'x@empresa.com' })).status).toBe(403);

    const team = (await (await luis.call('GET', '/v1/project/team')).json()) as { members: Array<{ email: string; role: string }> };
    expect(team.members.map((m) => [m.email, m.role])).toEqual([
      ['ana@empresa.com', 'owner'],
      ['luis@empresa.com', 'member'],
    ]);

    // Promoted to admin: keys and settings open up; the owner still cannot be removed.
    const luisId = ((await (await luis.call('GET', '/v1/auth/me')).json()) as { user: { id: string } }).user.id;
    expect((await ana.call('PATCH', `/v1/project/team/members/${luisId}`, { role: 'admin' })).status).toBe(204);
    expect((await luis.call('GET', '/v1/project/keys')).status).toBe(200);
    const anaId = ((await (await ana.call('GET', '/v1/auth/me')).json()) as { user: { id: string } }).user.id;
    expect((await luis.call('DELETE', `/v1/project/team/members/${anaId}`)).status).toBe(400);
    expect((await ana.call('PATCH', `/v1/project/team/members/${anaId}`, { role: 'member' })).status).toBe(400);

    // Removed: no access any more.
    expect((await ana.call('DELETE', `/v1/project/team/members/${luisId}`)).status).toBe(204);
    expect((await luis.call('GET', '/v1/messages')).status).toBe(404);
  });

  it('lets members leave, and admins revoke pending invitations', async () => {
    const ana = person();
    await ana.signup('ana2@empresa.com', 'Ana');
    await ana.call('POST', '/v1/project/team/invites', { email: 'luis2@empresa.com', role: 'admin' });
    const pending = await ana.call('POST', '/v1/project/team/invites', { email: 'otro@empresa.com' });
    const { id } = (await pending.json()) as { id: string };

    const team = (await (await ana.call('GET', '/v1/project/team')).json()) as { invites: Array<{ email: string }> };
    expect(team.invites.map((i) => i.email).sort()).toEqual(['luis2@empresa.com', 'otro@empresa.com']);
    expect((await ana.call('DELETE', `/v1/project/team/invites/${id}`)).status).toBe(204);
    expect((await fetch(`${base}/v1/invites/${inviteToken('otro@empresa.com')}`)).status).toBe(404);

    const luis = person();
    await luis.signup('luis2@empresa.com', 'Luis');
    await luis.call('POST', '/v1/invites/accept', { token: inviteToken('luis2@empresa.com') });
    luis.projectId = ana.projectId;
    expect((await luis.call('DELETE', '/v1/project/team/members/me')).status).toBe(204);
    expect((await luis.call('GET', '/v1/messages')).status).toBe(404);

    // Already in the project: no new invitation.
    const anaEmail = await ana.call('POST', '/v1/project/team/invites', { email: 'ana2@empresa.com' });
    expect(anaEmail.status).toBe(409);
  });
});
