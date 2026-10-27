import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { getDb } from '../src/db/client';
import { repositories } from '../src/db/schema';
import { artifactsHost, assertRemote, gitHostFor, type GitHost } from '../src/lib/git-host';
import { call, fakeGoogle, postJson, signIn } from './helpers';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const REMOTE = 'https://acct.artifacts.cloudflare.net/git/gitdesk/';

// An in-memory git host that records what the Worker asked of it.
function fakeHost() {
  const repos = new Map<string, { branch: string; tokens: number }>();
  const issued: { name: string; scope: string; ttl: number }[] = [];
  const state = { failEnsure: false };
  const host: GitHost = {
    async ensure(name, branch) {
      if (state.failEnsure) throw new Error('host down');
      if (!repos.has(name)) repos.set(name, { branch, tokens: 0 });
      return `${REMOTE}${name}.git`;
    },
    async remove(name) {
      repos.delete(name);
    },
    async token(name, scope, ttl) {
      const repo = repos.get(name);
      if (!repo) throw new Error('no such repository');
      repo.tokens++;
      issued.push({ name, scope, ttl });
      return { token: `art_v1_${'a'.repeat(40)}?expires=1`, expiresAt: Date.now() + ttl * 1000 };
    },
    async revokeAll(name) {
      const repo = repos.get(name);
      const count = repo?.tokens ?? 0;
      if (repo) repo.tokens = 0;
      return count;
    },
    async hasCommit() {
      return false;
    },
    async tip() {
      return null;
    },
    async readCommit() {
      return null;
    },
    async readTree() {
      return null;
    },
    async readBlob() {
      return null;
    },
  };
  return { host, repos, issued, state };
}

let nextIp = 120;

async function setup(withHost = true) {
  const google = await fakeGoogle();
  const fake = fakeHost();
  const app = createApp({ google: google.provider, gitHost: withHost ? () => fake.host : () => null });
  google.state.claims = { ...google.state.claims, sub: `owner-${crypto.randomUUID()}` };
  const owner = await signIn(app, google, `198.51.100.${nextIp++}`);
  google.state.claims = { ...google.state.claims, sub: `other-${crypto.randomUUID()}` };
  const other = await signIn(app, google, `198.51.100.${nextIp++}`);
  const send = (token: string, method: string, path: string, body?: unknown) =>
    call(app, path, {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...bearer(token) },
    });
  const create = async (name: string) => {
    const res = await postJson(app, '/api/v1/repositories', { name }, undefined, bearer(owner.access_token));
    return ((await res.json()) as { repository: { id: string; status: string; gitUrl: string | null } })
      .repository;
  };
  return { app, fake, owner, other, send, create };
}

const credentials = (path: string, scope = 'read', lifetime = 900) => ({
  path: `${path}/git-credentials`,
  body: { scope, lifetime },
});

describe('git hosting', () => {
  it('gives a provisioned repository a Git URL named by its id, never by its name', async () => {
    const { fake, create } = await setup();
    const repository = await create('secret-project');
    expect(repository.status).toBe('ready');
    expect(repository.gitUrl).toBe(`${REMOTE}${repository.id}.git`);
    expect(repository.gitUrl).not.toContain('secret-project');
    expect(fake.repos.get(repository.id)?.branch).toBe('main');
  });

  it('marks provisioning failed when the git host fails, and a retry finishes it', async () => {
    const { fake, create, send, owner } = await setup();
    fake.state.failEnsure = true;
    const repository = await create('flaky');
    expect(repository.status).toBe('failed');
    expect(repository.gitUrl).toBeNull();
    fake.state.failEnsure = false;
    const res = await send(owner.access_token, 'POST', `/api/v1/repositories/${repository.id}/provision`);
    const retried = ((await res.json()) as { repository: typeof repository }).repository;
    expect(retried.status).toBe('ready');
    expect(retried.gitUrl).toBe(`${REMOTE}${repository.id}.git`);
  });

  it('gives a repository made before hosting a Git URL on its first credentials request', async () => {
    const { fake, owner, send } = await setup();
    const id = crypto.randomUUID();
    const now = Date.now();
    await getDb(env.DB).insert(repositories).values({
      id,
      ownerAccountId: owner.account.id,
      name: 'older',
      nameKey: 'older',
      createdAt: now,
      updatedAt: now,
      status: 'ready',
      statusAt: now,
      storageKey: `repositories/${id}/`,
    });
    const { path, body } = credentials(`/api/v1/repositories/${id}`);
    const res = await send(owner.access_token, 'POST', path, body);
    expect(res.status).toBe(200);
    expect(fake.repos.has(id)).toBe(true);
    const [row] = await getDb(env.DB).select().from(repositories).where(eq(repositories.id, id));
    expect(row?.gitRemote).toBe(`${REMOTE}${id}.git`);
  });

  it('issues scoped, short-lived tokens to the owner only and never caches them', async () => {
    const { fake, create, send, owner, other } = await setup();
    const repository = await create('tokens');
    const { path, body } = credentials(`/api/v1/repositories/${repository.id}`, 'write', 900);

    const res = await send(owner.access_token, 'POST', path, body);
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const issued = (await res.json()) as Record<string, unknown>;
    expect(Object.keys(issued).sort()).toEqual(['expiresAt', 'remote', 'scope', 'token']);
    expect(issued.remote).toBe(repository.gitUrl);
    expect(issued.scope).toBe('write');
    expect(fake.issued).toEqual([{ name: repository.id, scope: 'write', ttl: 900 }]);

    // Another account gets the same answer as a missing repository.
    expect((await send(other.access_token, 'POST', path, body)).status).toBe(404);
    expect(fake.issued).toHaveLength(1);
  });

  it('refuses lifetimes and scopes outside the fixed steps', async () => {
    const { create, send, owner } = await setup();
    const repository = await create('steps');
    const path = `/api/v1/repositories/${repository.id}/git-credentials`;
    for (const body of [
      { scope: 'read', lifetime: 31_536_000 },
      { scope: 'admin', lifetime: 900 },
      { scope: 'read', lifetime: 900, extra: true },
    ]) {
      expect((await send(owner.access_token, 'POST', path, body)).status).toBe(400);
    }
  });

  it('says hosting is off instead of failing when the deployment has no git host', async () => {
    const { create, send, owner } = await setup(false);
    const repository = await create('no-hosting');
    expect(repository.status).toBe('ready');
    expect(repository.gitUrl).toBeNull();
    const { path, body } = credentials(`/api/v1/repositories/${repository.id}`);
    const res = await send(owner.access_token, 'POST', path, body);
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      'GIT_HOSTING_UNAVAILABLE',
    );
    const overview = await send(owner.access_token, 'GET', '/api/v1/dashboard/overview');
    expect(((await overview.json()) as { gitHosting: boolean }).gitHosting).toBe(false);
  });

  it('revokes every token for a repository', async () => {
    const { create, send, owner, other } = await setup();
    const repository = await create('revoke');
    const { path, body } = credentials(`/api/v1/repositories/${repository.id}`);
    await send(owner.access_token, 'POST', path, body);
    await send(owner.access_token, 'POST', path, body);
    expect((await send(other.access_token, 'DELETE', path)).status).toBe(404);
    const res = await send(owner.access_token, 'DELETE', path);
    expect(await res.json()).toEqual({ revoked: 2 });
  });

  it('deletes the Git repository with the account repository', async () => {
    const { fake, create, send, owner } = await setup();
    const repository = await create('gone');
    expect(fake.repos.has(repository.id)).toBe(true);
    const res = await send(owner.access_token, 'DELETE', `/api/v1/repositories/${repository.id}`);
    expect(res.status).toBe(204);
    expect(fake.repos.has(repository.id)).toBe(false);
  });

  it('reports a git host failure as a 502 without leaking its detail', async () => {
    const { fake, create, send, owner } = await setup();
    const repository = await create('broken-host');
    fake.host.token = () => Promise.reject(new Error('internal stack detail'));
    const { path, body } = credentials(`/api/v1/repositories/${repository.id}`);
    const res = await send(owner.access_token, 'POST', path, body);
    expect(res.status).toBe(502);
    expect(await res.text()).not.toContain('internal stack detail');
  });
});

describe('artifacts host', () => {
  type Created = { remote: string; token: string };
  const binding = (overrides: Partial<Record<string, unknown>> = {}) => {
    const disposed: string[] = [];
    const handle = (name: string) => ({
      info: async () => ({ remote: `${REMOTE}${name}.git` }),
      createToken: async (scope: string, ttl: number) => ({
        id: 't1',
        plaintext: `art_v1_x?expires=${ttl}`,
        scope,
        expiresAt: '2026-10-22T12:00:00.000Z',
      }),
      listTokens: async () => ({ total: 2, tokens: [{ id: 'a' }, { id: 'b' }] }),
      revokeToken: async () => true,
      [Symbol.dispose]: () => disposed.push(name),
    });
    const artifacts = {
      create: async (name: string): Promise<Created> => ({ remote: `${REMOTE}${name}.git`, token: 'x' }),
      get: async (name: string) => handle(name),
      delete: async () => true,
      ...overrides,
    };
    return { host: artifactsHost(artifacts as unknown as Artifacts), disposed };
  };

  it('reads the existing remote when the repository already exists', async () => {
    const exists = Object.assign(new Error('exists'), { code: 'ALREADY_EXISTS' });
    const { host, disposed } = binding({ create: () => Promise.reject(exists) });
    expect(await host.ensure('r1', 'main')).toBe(`${REMOTE}r1.git`);
    expect(disposed).toEqual(['r1']);
  });

  it('passes other create errors through', async () => {
    const down = Object.assign(new Error('down'), { code: 'INTERNAL_ERROR' });
    const { host } = binding({ create: () => Promise.reject(down) });
    await expect(host.ensure('r1', 'main')).rejects.toThrow('down');
  });

  it('refuses a remote that is not plain https', async () => {
    for (const bad of ['http://h/r.git', 'https://x:secret@h/r.git', 'https://h/r.git?t=1']) {
      const { host } = binding({ create: async () => ({ remote: bad, token: 'x' }) });
      await expect(host.ensure('r1', 'main')).rejects.toThrow();
    }
    expect(assertRemote(`${REMOTE}r1.git`)).toBe(`${REMOTE}r1.git`);
  });

  it('asks Artifacts for a branch tip by its short name', async () => {
    const asked: (string | undefined)[] = [];
    const { host, disposed } = binding({
      get: async (name: string) => ({
        // Like the real service: a short name resolves, refs/heads/... finds nothing.
        log: async ({ ref }: { ref?: string }) => {
          asked.push(ref);
          return ref === 'main' ? [{ hash: 'a'.repeat(40) }] : [];
        },
        [Symbol.dispose]: () => disposed.push(name),
      }),
    });
    expect(await host.tip('r1', 'refs/heads/main')).toBe('a'.repeat(40));
    expect(await host.tip('r1', 'refs/heads/gone')).toBeNull();
    expect(asked).toEqual(['main', 'gone']);
    expect(disposed).toEqual(['r1', 'r1']);
  });

  it('mints tokens and revokes them, releasing each handle', async () => {
    const { host, disposed } = binding();
    const token = await host.token('r1', 'read', 900);
    expect(token.token).toBe('art_v1_x?expires=900');
    expect(token.expiresAt).toBe(Date.parse('2026-10-22T12:00:00.000Z'));
    expect(await host.revokeAll('r1')).toBe(2);
    expect(disposed).toEqual(['r1', 'r1']);
  });
});

describe('choosing the git host', () => {
  const base = { ...env, GIT_HOSTING: 'local', LOCAL_GIT_SECRET: 'local-secret-0123456789' };

  it('uses the local development host only on this machine and with a real secret', () => {
    expect(gitHostFor({ ...base, LOCAL_GIT_HOST: 'http://127.0.0.1:9444' })).not.toBeNull();
    expect(gitHostFor({ ...base, LOCAL_GIT_HOST: 'https://git.example.com' })).toBeNull();
    expect(gitHostFor({ ...base, LOCAL_GIT_HOST: 'http://10.0.0.5:9444' })).toBeNull();
    expect(gitHostFor({ ...base, LOCAL_GIT_HOST: 'http://127.0.0.1:9444', LOCAL_GIT_SECRET: 'short' })).toBeNull();
  });

  it('stays off without a setting, and without the Artifacts binding', () => {
    expect(gitHostFor({ ...env, GIT_HOSTING: 'off' })).toBeNull();
    expect(gitHostFor({ ...env, GIT_HOSTING: 'artifacts', ARTIFACTS: undefined })).toBeNull();
  });

  it('reads tree entries and blobs from the local host in the same shape as Artifacts', async () => {
    const id = 'a'.repeat(40);
    const answers: Record<string, unknown> = {
      [`/repos/r1/objects/${id}/tree`]: { entries: [{ name: 'a.ts', mode: '100644', hash: 'b'.repeat(40), type: 'blob' }] },
      [`/repos/r1/objects/${id}/blob`]: { blob: { size: 5, base64: btoa('hello') } },
    };
    const seen: string[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      seen.push(new Headers(init?.headers).get('x-local-git-secret') ?? '');
      return Response.json(answers[url.pathname] ?? null);
    }) as typeof fetch;
    try {
      const host = gitHostFor({ ...base, LOCAL_GIT_HOST: 'http://127.0.0.1:9444' })!;
      expect(await host.readTree('r1', id)).toEqual([{ name: 'a.ts', mode: '100644', oid: 'b'.repeat(40), type: 'blob' }]);
      const blob = await host.readBlob('r1', id, 10);
      expect(blob?.size).toBe(5);
      expect(new TextDecoder().decode(blob!.bytes!)).toBe('hello');
      expect(seen.every((secret) => secret === base.LOCAL_GIT_SECRET)).toBe(true);
    } finally {
      globalThis.fetch = original;
    }
  });
});
