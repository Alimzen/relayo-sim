import { randomBytes, randomUUID } from 'node:crypto';
import type { Project, ProjectInvite, ProjectMember, ProjectRole, User } from '../domain.js';
import type { SimStore } from '../store/store.js';
import { hashToken } from './accounts.service.js';
import type { MailToSend } from './mailer.js';

export const INVITE_DAYS = 7;
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/** A team problem, with its (Spanish, user-facing) message. */
export class TeamError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 403 | 404 | 409,
  ) {
    super(message);
  }
}

export const isAdminRole = (role: ProjectRole | undefined) => role === 'owner' || role === 'admin';

export interface TeamView {
  members: Array<{ userId: string; name: string; email: string; role: ProjectRole; since: Date }>;
  invites: Array<Pick<ProjectInvite, 'id' | 'email' | 'role' | 'expiresAt' | 'createdAt'>>;
}

/**
 * The people of a project: its owner, the members it invited, and the pending invitations. Admins manage
 * them; anyone but the owner can leave.
 */
export class TeamService {
  constructor(
    private readonly store: SimStore,
    private readonly mail: (mail: MailToSend) => Promise<void>,
    private readonly publicUrl = '',
  ) {}

  /** The project with this id and the user's role in it, if they have access. */
  async access(user: User, projectId: string | undefined): Promise<{ project: Project; role: ProjectRole } | undefined> {
    if (!projectId) return undefined;
    const project = await this.store.getProject(projectId);
    if (!project) return undefined;
    if (project.ownerId === user.id) return { project, role: 'owner' };
    const member = await this.store.getMember(projectId, user.id);
    return member ? { project, role: member.role } : undefined;
  }

  async view(project: Project): Promise<TeamView> {
    const owner = project.ownerId ? await this.store.getUser(project.ownerId) : undefined;
    const members = await this.store.listMembers(project.id);
    const users = await Promise.all(members.map((m) => this.store.getUser(m.userId)));
    return {
      members: [
        ...(owner ? [{ userId: owner.id, name: owner.name, email: owner.email, role: 'owner' as const, since: project.createdAt }] : []),
        ...members.flatMap((m, i) => {
          const user = users[i];
          return user ? [{ userId: user.id, name: user.name, email: user.email, role: m.role, since: m.createdAt }] : [];
        }),
      ],
      invites: (await this.store.listInvites(project.id)).map(({ id, email, role, expiresAt, createdAt }) => ({ id, email, role, expiresAt, createdAt })),
    };
  }

  /** Emails a link to join the project. A new invitation to the same email replaces the previous one. */
  async invite(project: Project, inviter: User, input: { email?: unknown; role?: unknown }): Promise<ProjectInvite> {
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    if (!EMAIL.test(email)) throw new TeamError('Introduce un email válido.', 400);
    const role = memberRole(input.role ?? 'member');
    const existing = await this.store.findUserByEmail(email);
    if (existing && (await this.access(existing, project.id))) throw new TeamError(`${email} ya tiene acceso a este proyecto.`, 409);

    for (const old of await this.store.listInvites(project.id)) {
      if (old.email === email) await this.store.deleteInvite(project.id, old.id);
    }
    const token = randomBytes(32).toString('base64url');
    const now = new Date();
    const invite: ProjectInvite = {
      id: `inv_${randomUUID()}`,
      projectId: project.id,
      email,
      role,
      tokenHash: hashToken(token),
      invitedBy: inviter.id,
      expiresAt: new Date(now.getTime() + INVITE_DAYS * 86_400_000),
      createdAt: now,
    };
    await this.store.createInvite(invite);
    await this.mail(inviteEmail(invite, project, inviter, `${this.publicUrl}/invite?token=${token}`));
    return invite;
  }

  async revokeInvite(project: Project, id: string): Promise<void> {
    if (!(await this.store.deleteInvite(project.id, id))) throw new TeamError('Invitación no encontrada.', 404);
  }

  async changeRole(project: Project, userId: string, role: unknown): Promise<void> {
    if (userId === project.ownerId) throw new TeamError('El rol del dueño del proyecto no se puede cambiar.', 400);
    if (!(await this.store.updateMemberRole(project.id, userId, memberRole(role)))) throw new TeamError('Esa persona no es miembro del proyecto.', 404);
  }

  /** Admins remove anyone but the owner; anyone but the owner can remove themselves (leave). */
  async remove(project: Project, actor: User, actorRole: ProjectRole, userId: string): Promise<void> {
    if (userId === project.ownerId) throw new TeamError('El dueño no se puede quitar del proyecto.', 400);
    if (userId !== actor.id && !isAdminRole(actorRole)) throw new TeamError('Solo los administradores del proyecto pueden quitar a otras personas.', 403);
    if (!(await this.store.removeMember(project.id, userId))) throw new TeamError('Esa persona no es miembro del proyecto.', 404);
  }

  /** What the invitation page shows before signing in. */
  async describe(token: string): Promise<{ project: string; email: string; role: ProjectInvite['role']; invitedBy: string; expiresAt: Date }> {
    const invite = token ? await this.store.findInvite(hashToken(token)) : undefined;
    const project = invite && (await this.store.getProject(invite.projectId));
    if (!invite || !project) throw new TeamError('La invitación no existe o ha caducado. Pide otra.', 404);
    const inviter = await this.store.getUser(invite.invitedBy);
    return { project: project.name, email: invite.email, role: invite.role, invitedBy: inviter?.name ?? '', expiresAt: invite.expiresAt };
  }

  /**
   * Joins the project of an invitation, for the account it was sent to. The link reached that inbox, so an
   * unconfirmed email counts as confirmed.
   */
  async accept(user: User, token: unknown): Promise<{ project: Project; role: ProjectRole; verified: boolean }> {
    const invite = typeof token === 'string' && token ? await this.store.findInvite(hashToken(token)) : undefined;
    if (!invite) throw new TeamError('La invitación no existe o ha caducado. Pide otra.', 404);
    if (invite.email !== user.email.toLowerCase()) {
      throw new TeamError(`Esta invitación es para ${invite.email}: entra con esa cuenta para aceptarla.`, 403);
    }
    const project = await this.store.getProject(invite.projectId);
    if (!project) throw new TeamError('El proyecto ya no existe.', 404);
    const current = await this.access(user, project.id);
    if (!current) {
      const member: ProjectMember = { projectId: project.id, userId: user.id, role: invite.role, createdAt: new Date() };
      await this.store.addMember(member);
    }
    await this.store.deleteInvite(project.id, invite.id);
    const verified = !user.emailVerifiedAt;
    if (verified) await this.store.updateUser(user.id, { emailVerifiedAt: new Date() });
    return { project, role: current?.role ?? invite.role, verified };
  }
}

function memberRole(value: unknown): ProjectMember['role'] {
  if (value !== 'admin' && value !== 'member') throw new TeamError('El rol debe ser «admin» o «member».', 400);
  return value;
}

function inviteEmail(invite: ProjectInvite, project: Project, inviter: User, link: string): MailToSend {
  const escape = (s: string) => s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]!);
  const role = invite.role === 'admin' ? 'administrador' : 'miembro';
  const lines = [
    `${inviter.name} te invita a «${project.name}» en Relayo, como ${role}.`,
    `La invitación caduca en ${INVITE_DAYS} días. Si no tienes cuenta, créala con este email (${invite.email}).`,
  ];
  return {
    to: invite.email,
    subject: `${inviter.name} te invita a «${project.name}» en Relayo`,
    text: ['Hola:', '', lines[0]!, '', link, '', lines[1]!].join('\n'),
    html: `<div style="font-family:system-ui,sans-serif;max-width:480px;color:#18181b;line-height:1.5">
<p>Hola:</p>
<p>${escape(lines[0]!)}</p>
<p><a href="${escape(link)}" style="display:inline-block;background:#18181b;color:#fff;padding:10px 16px;border-radius:6px;text-decoration:none">Ver la invitación</a></p>
<p style="color:#71717a;font-size:13px">${escape(lines[1]!)}</p>
</div>`,
  };
}
