import { describe, expect, it } from 'vitest';
import type { Project } from '../src/domain.js';
import { LiveService } from '../src/live/live.service.js';
import { SecretBox } from '../src/live/secrets.js';
import { MemoryStore } from '../src/store/memory-store.js';
import { MemoryDispatcher } from '../src/webhooks/webhooks.js';

const OLD = Buffer.alloc(32, 1).toString('base64');
const NEW = Buffer.alloc(32, 2).toString('base64');

describe('secret box', () => {
  it('seals with the current key and opens with any configured key', () => {
    const old = new SecretBox(OLD);
    const sealed = old.seal({ apiKey: 'SG.x' });
    expect(sealed).toMatch(/^v1\./);
    expect(sealed).not.toContain('SG.x');

    expect(() => new SecretBox(NEW).open(sealed)).toThrow(/SECRETS_KEY/);
    const rotated = new SecretBox(NEW, [OLD]);
    expect(rotated.open(sealed)).toEqual({ apiKey: 'SG.x' });

    const resealed = rotated.reseal(sealed)!;
    expect(new SecretBox(NEW).open(resealed)).toEqual({ apiKey: 'SG.x' });
    expect(rotated.reseal(resealed)).toBeUndefined();
  });
});

describe('SECRETS_KEY rotation', () => {
  it('seals every stored secret with the new key, counting those no key opens', async () => {
    const store = new MemoryStore();
    const project: Project = { id: 'prj_1', name: 'P', webhookSecret: 'w', createdAt: new Date() };
    await store.createProject(project);
    const old = new SecretBox(OLD);
    const connection = {
      id: 'con_1',
      projectId: 'prj_1',
      name: 'SG',
      channel: 'email' as const,
      provider: 'sendgrid' as const,
      settings: {},
      secrets: old.seal({ apiKey: 'SG.x' }),
      priority: 0,
      inboundToken: 't1',
      createdAt: new Date(),
    };
    await store.createConnection(connection);
    await store.createConnection({ ...connection, id: 'con_2', inboundToken: 't2', secrets: new SecretBox('lost-key').seal({ apiKey: 'y' }) });
    await store.createDomain({
      id: 'dom_1',
      projectId: 'prj_1',
      domain: 'empresa.com',
      selector: 'relayo',
      dkimPublicKey: 'pub',
      dkimPrivateKey: old.seal('-----BEGIN PRIVATE KEY-----'),
      checks: { dkim: false, spf: false, dmarc: false },
      createdAt: new Date(),
    });

    const live = new LiveService(store, new MemoryDispatcher(), new SecretBox(NEW, [OLD]));
    expect(await live.resealSecrets()).toEqual({ resealed: 2, unreadable: 1 });
    expect(await live.resealSecrets()).toEqual({ resealed: 0, unreadable: 1 });

    const fresh = new SecretBox(NEW);
    expect(fresh.open((await store.getConnection('prj_1', 'con_1'))!.secrets)).toEqual({ apiKey: 'SG.x' });
    expect(fresh.open((await store.getDomain('prj_1', 'dom_1'))!.dkimPrivateKey)).toBe('-----BEGIN PRIVATE KEY-----');
  });
});
