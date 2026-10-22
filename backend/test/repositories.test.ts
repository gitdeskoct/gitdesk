import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { getDb } from '../src/db/client';
import { repositories } from '../src/db/schema';
import {
  MAX_REPOSITORIES_PER_ACCOUNT,
  resumeLifecycle,
  STALE_LIFECYCLE_MS,
} from '../src/modules/repositories/repositories';
import { call, fakeGoogle, postJson, signIn } from './helpers';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

type Remote = {
  id: string;
  name: string;
  description: string | null;
  visibility: string;
  updatedAt: number;
};
type Page = { repositories: Remote[]; nextCursor: string | null };

// AUTH_LIMITER counts sign-ins per IP, so each test signs in from its own pair of addresses.
let nextIp = 40;

async function twoAccounts() {
  const google = await fakeGoogle();
  const app = createApp({ google: google.provider });
  google.state.claims = { ...google.state.claims, sub: `owner-${crypto.randomUUID()}` };
  const owner = await signIn(app, google, `198.51.100.${nextIp++}`);
  google.state.claims = { ...google.state.claims, sub: `other-${crypto.randomUUID()}` };
  const other = await signIn(app, google, `198.51.100.${nextIp++}`);
  return { app, owner, other };
}

const create = (
  app: ReturnType<typeof createApp>,
  token: string,
  body: unknown,
  headers: Record<string, string> = {},
) => postJson(app, '/api/v1/repositories', body, undefined, { ...bearer(token), ...headers });

const send = (
  app: ReturnType<typeof createApp>,
  token: string,
  method: string,
  path: string,
  body?: unknown,
) =>
  call(app, path, {
    method,
    body: body === undefined ? undefined : JSON.stringify(body),
    headers: { 'content-type': 'application/json', ...bearer(token) },
  });

const list = async (app: ReturnType<typeof createApp>, token: string, query: string) => {
  const res = await call(app, `/api/v1/repositories?${query}`, { headers: bearer(token) });
  return { status: res.status, body: (await res.json()) as Page };
};

describe('remote repositories', () => {
  it('requires a signed-in session', async () => {
    const { app } = await twoAccounts();
    expect((await call(app, '/api/v1/dashboard/overview')).status).toBe(401);
    expect((await call(app, '/api/v1/repositories')).status).toBe(401);
    expect((await postJson(app, '/api/v1/repositories', { name: 'x' })).status).toBe(401);
  });

  it('creates a private repository and reports it in the overview', async () => {
    const { app, owner } = await twoAccounts();
    const res = await create(app, owner.access_token, {
      name: 'reading-list',
      description: 'Books',
    });
    expect(res.status).toBe(201);
    const { repository } = (await res.json()) as { repository: Remote };
    expect(repository).toMatchObject({
      name: 'reading-list',
      description: 'Books',
      visibility: 'private',
    });

    const overview = await call(app, '/api/v1/dashboard/overview', {
      headers: bearer(owner.access_token),
    });
    expect(overview.headers.get('cache-control')).toBe('no-store');
    const body = (await overview.json()) as { total: number; recent: Remote[] };
    expect(body.total).toBe(1);
    expect(body.recent.map((r) => r.id)).toEqual([repository.id]);
  });

  it('keeps names unique per account, ignoring case', async () => {
    const { app, owner, other } = await twoAccounts();
    expect((await create(app, owner.access_token, { name: 'Notes' })).status).toBe(201);
    const again = await create(app, owner.access_token, { name: 'notes' });
    expect(again.status).toBe(409);
    expect(await again.json()).toMatchObject({ error: { code: 'NAME_TAKEN' } });
    // Another account may use the same name.
    expect((await create(app, other.access_token, { name: 'notes' })).status).toBe(201);
  });

  it('rejects names that are not safe folder names and unknown fields', async () => {
    const { app, owner, other } = await twoAccounts();
    for (const name of ['', '.hidden', 'a b', '../up', 'x.git', 'a/b', 'x'.repeat(101)]) {
      expect((await create(app, owner.access_token, { name })).status).toBe(400);
    }
    // Windows reserved names; a second account because WRITE_LIMITER counts rejected writes too.
    for (const name of ['con', 'NUL', 'Aux.txt', 'com1', 'LPT9.md']) {
      expect((await create(app, other.access_token, { name })).status).toBe(400);
    }
    expect(
      (await create(app, owner.access_token, { name: 'ok', ownerAccountId: 'someone' })).status,
    ).toBe(400);
    expect(
      (await create(app, owner.access_token, { name: 'ok', description: 'two\nlines' })).status,
    ).toBe(400);
  });

  it("never shows one account another account's repository", async () => {
    const { app, owner, other } = await twoAccounts();
    const res = await create(app, owner.access_token, { name: 'secret' });
    const { repository } = (await res.json()) as { repository: Remote };

    const own = await call(app, `/api/v1/repositories/${repository.id}`, {
      headers: bearer(owner.access_token),
    });
    expect(own.status).toBe(200);

    const foreign = await call(app, `/api/v1/repositories/${repository.id}`, {
      headers: bearer(other.access_token),
    });
    expect(foreign.status).toBe(404);

    const list = await call(app, '/api/v1/repositories', { headers: bearer(other.access_token) });
    expect(((await list.json()) as { repositories: Remote[] }).repositories).toEqual([]);
    const overview = await call(app, '/api/v1/dashboard/overview', {
      headers: bearer(other.access_token),
    });
    expect(await overview.json()).toMatchObject({ total: 0, recent: [] });
  });

  it('pages through the list with a cursor', async () => {
    const { app, owner } = await twoAccounts();
    for (const name of ['one', 'two', 'three']) {
      expect((await create(app, owner.access_token, { name })).status).toBe(201);
    }
    const first = await call(app, '/api/v1/repositories?limit=2', {
      headers: bearer(owner.access_token),
    });
    const page1 = (await first.json()) as { repositories: Remote[]; nextCursor: string | null };
    expect(page1.repositories).toHaveLength(2);
    expect(page1.nextCursor).toBeTruthy();

    const second = await call(app, `/api/v1/repositories?limit=2&cursor=${page1.nextCursor}`, {
      headers: bearer(owner.access_token),
    });
    const page2 = (await second.json()) as { repositories: Remote[]; nextCursor: string | null };
    expect(page2.repositories).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
    const names = [...page1.repositories, ...page2.repositories].map((r) => r.name).sort();
    expect(names).toEqual(['one', 'three', 'two']);

    expect(
      (await call(app, '/api/v1/repositories?limit=500', { headers: bearer(owner.access_token) }))
        .status,
    ).toBe(400);
  });

  it('sorts by name and rejects cursors that do not decode for the sort', async () => {
    const { app, owner } = await twoAccounts();
    for (const name of ['beta', 'Alpha', 'gamma']) {
      expect((await create(app, owner.access_token, { name })).status).toBe(201);
    }
    const page1 = await list(app, owner.access_token, 'sort=name&limit=2');
    expect(page1.body.repositories.map((r) => r.name)).toEqual(['Alpha', 'beta']);
    const page2 = await list(
      app,
      owner.access_token,
      `sort=name&limit=2&cursor=${page1.body.nextCursor}`,
    );
    expect(page2.body.repositories.map((r) => r.name)).toEqual(['gamma']);
    expect(page2.body.nextCursor).toBeNull();

    const updated = await list(app, owner.access_token, 'limit=1');
    for (const query of [
      'cursor=abc',
      `cursor=${btoa('{"not":"a tuple"}').replace(/=+$/, '')}`,
      `sort=name&cursor=${updated.body.nextCursor}`,
      `cursor=${page1.body.nextCursor}`,
      'sort=size',
    ]) {
      const res = await list(app, owner.access_token, query);
      expect(res.status).toBe(400);
      expect(res.body).toMatchObject({ error: { code: 'VALIDATION_FAILED' } });
    }
  });

  it('never creates more than the cap, even when creates race', async () => {
    const { app, owner } = await twoAccounts();
    const db = getDb(env.DB);
    const now = Date.now();
    const rows = Array.from({ length: MAX_REPOSITORIES_PER_ACCOUNT - 1 }, (_, i) => ({
      id: crypto.randomUUID(),
      ownerAccountId: owner.account.id,
      name: `seed-${i}`,
      nameKey: `seed-${i}`,
      createdAt: now,
      updatedAt: now,
    }));
    // D1 caps a statement at 100 bound parameters, so seed in chunks.
    for (let i = 0; i < rows.length; i += 8) {
      await db.insert(repositories).values(rows.slice(i, i + 8));
    }

    const results = await Promise.all(
      ['race-1', 'race-2', 'race-3'].map((name) => create(app, owner.access_token, { name })),
    );
    expect(results.map((r) => r.status).sort()).toEqual([201, 403, 403]);
    expect(await results.find((r) => r.status === 403)!.json()).toMatchObject({
      error: { code: 'LIMIT_REACHED' },
    });
  });

  it('only stores private repositories', async () => {
    const { owner } = await twoAccounts();
    const now = Date.now();
    await expect(
      getDb(env.DB)
        .insert(repositories)
        .values({
          id: crypto.randomUUID(),
          ownerAccountId: owner.account.id,
          name: 'open',
          nameKey: 'open',
          visibility: 'public' as 'private',
          createdAt: now,
          updatedAt: now,
        }),
    ).rejects.toThrow();
  });

  it('returns the original repository when a create is retried with the same key', async () => {
    const { app, owner, other } = await twoAccounts();
    const key = { 'idempotency-key': crypto.randomUUID() };
    const first = await create(app, owner.access_token, { name: 'retry' }, key);
    const second = await create(app, owner.access_token, { name: 'retry' }, key);
    expect(first.status).toBe(201);
    expect(second.status).toBe(201);
    expect(await second.json()).toEqual(await first.json());

    expect((await create(app, owner.access_token, { name: 'retry' })).status).toBe(409);
    // Keys are per account.
    expect((await create(app, other.access_token, { name: 'retry' }, key)).status).toBe(201);
    const badKey = { 'idempotency-key': 'nope' };
    expect((await create(app, owner.access_token, { name: 'x' }, badKey)).status).toBe(400);
  });

  it('updates name and description for the owner only', async () => {
    const { app, owner, other } = await twoAccounts();
    const res = await create(app, owner.access_token, { name: 'draft' });
    const { repository } = (await res.json()) as { repository: Remote };
    await create(app, owner.access_token, { name: 'taken' });
    const path = `/api/v1/repositories/${repository.id}`;
    const patch = (token: string, body: unknown) => send(app, token, 'PATCH', path, body);

    const renamed = await patch(owner.access_token, { name: 'Final', description: 'Done' });
    expect(renamed.status).toBe(200);
    const body = (await renamed.json()) as { repository: Remote };
    expect(body.repository).toMatchObject({ id: repository.id, name: 'Final', description: 'Done' });
    expect(body.repository.updatedAt).toBeGreaterThanOrEqual(repository.updatedAt);

    expect(await (await patch(owner.access_token, { description: '' })).json()).toMatchObject({
      repository: { name: 'Final', description: null },
    });
    // A case-only rename keeps the same name key.
    expect((await patch(owner.access_token, { name: 'final' })).status).toBe(200);

    const conflict = await patch(owner.access_token, { name: 'TAKEN' });
    expect(conflict.status).toBe(409);
    expect(await conflict.json()).toMatchObject({ error: { code: 'NAME_TAKEN' } });
    expect((await patch(other.access_token, { name: 'mine' })).status).toBe(404);
    expect((await patch(owner.access_token, {})).status).toBe(400);
    expect((await patch(owner.access_token, { visibility: 'public' })).status).toBe(400);
  });

  it('deletes for the owner only', async () => {
    const { app, owner, other } = await twoAccounts();
    const res = await create(app, owner.access_token, { name: 'gone' });
    const { repository } = (await res.json()) as { repository: Remote };
    const path = `/api/v1/repositories/${repository.id}`;
    expect((await send(app, other.access_token, 'DELETE', path)).status).toBe(404);
    expect((await send(app, owner.access_token, 'DELETE', path)).status).toBe(204);
    expect((await send(app, owner.access_token, 'DELETE', path)).status).toBe(404);
    expect((await call(app, path, { headers: bearer(owner.access_token) })).status).toBe(404);
    // The name is free again.
    expect((await create(app, owner.access_token, { name: 'gone' })).status).toBe(201);
  });
});

// An R2 binding whose `op` always fails, to drive the partial-failure paths.
const brokenStorage = (op: 'put' | 'delete') =>
  new Proxy(env.REPO_STORAGE, {
    get(target, key) {
      if (key === op) return () => Promise.reject(new Error('storage unavailable'));
      const value = Reflect.get(target, key) as unknown;
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });

const sendWith = (
  app: ReturnType<typeof createApp>,
  storage: R2Bucket,
  token: string,
  method: string,
  path: string,
  body?: unknown,
) =>
  app.request(
    path,
    {
      method,
      body: body === undefined ? undefined : JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...bearer(token) },
    },
    { ...env, REPO_STORAGE: storage },
  );

type Lifecycle = Remote & { status: string; createdAt: number };

const created = async (res: Response) => ((await res.json()) as { repository: Lifecycle }).repository;

describe('remote repository lifecycle', () => {
  it('provisions storage under an opaque prefix and never exposes the key', async () => {
    const { app, owner } = await twoAccounts();
    const res = await create(app, owner.access_token, { name: 'stored' });
    expect(res.status).toBe(201);
    const repository = await created(res);
    expect(repository.status).toBe('ready');
    expect(Object.keys(repository)).not.toContain('storageKey');
    const marker = await env.REPO_STORAGE.get(`repositories/${repository.id}/meta.json`);
    expect(await marker?.json()).toEqual({
      repositoryId: repository.id,
      createdAt: repository.createdAt,
    });
  });

  it('keeps a repository whose storage failed as failed, and a retry makes it ready', async () => {
    const { app, owner, other } = await twoAccounts();
    const res = await sendWith(
      app,
      brokenStorage('put'),
      owner.access_token,
      'POST',
      '/api/v1/repositories',
      { name: 'flaky' },
    );
    expect(res.status).toBe(201);
    const repository = await created(res);
    expect(repository.status).toBe('failed');

    const path = `/api/v1/repositories/${repository.id}/provision`;
    expect((await send(app, other.access_token, 'POST', path)).status).toBe(404);
    const retried = await send(app, owner.access_token, 'POST', path);
    expect(retried.status).toBe(200);
    expect(await retried.json()).toMatchObject({
      repository: { id: repository.id, status: 'ready' },
    });
    // Provisioning a ready repository changes nothing.
    expect((await send(app, owner.access_token, 'POST', path)).status).toBe(200);

    const activity = await call(app, `/api/v1/repositories/${repository.id}/activity`, {
      headers: bearer(owner.access_token),
    });
    const rows = ((await activity.json()) as { activity: { type: string }[] }).activity;
    expect(rows.map((row) => row.type)).toEqual(
      expect.arrayContaining(['repository.provisioning_failed', 'repository.provisioned']),
    );
  });

  it('removes stored data before the row, and resumes a deletion that stopped', async () => {
    const { app, owner } = await twoAccounts();
    const keep = await created(await create(app, owner.access_token, { name: 'keep' }));
    const repository = await created(await create(app, owner.access_token, { name: 'doomed' }));
    await env.REPO_STORAGE.put(`repositories/${repository.id}/objects/pack-1`, 'data');
    const path = `/api/v1/repositories/${repository.id}`;

    const stalled = await sendWith(app, brokenStorage('delete'), owner.access_token, 'DELETE', path);
    expect(stalled.status).toBe(202);
    expect(await stalled.json()).toMatchObject({ repository: { status: 'deleting' } });
    const rename = await send(app, owner.access_token, 'PATCH', path, { name: 'saved' });
    expect(rename.status).toBe(409);
    expect(await rename.json()).toMatchObject({ error: { code: 'INVALID_STATE' } });
    expect((await send(app, owner.access_token, 'POST', `${path}/provision`)).status).toBe(409);

    expect((await send(app, owner.access_token, 'DELETE', path)).status).toBe(204);
    const left = await env.REPO_STORAGE.list({ prefix: `repositories/${repository.id}/` });
    expect(left.objects).toEqual([]);
    expect(await env.REPO_STORAGE.head(`repositories/${keep.id}/meta.json`)).not.toBeNull();
    expect((await call(app, path, { headers: bearer(owner.access_token) })).status).toBe(404);
  });

  it("lists one repository's activity for its owner only", async () => {
    const { app, owner, other } = await twoAccounts();
    const repository = await created(await create(app, owner.access_token, { name: 'mine' }));
    await create(app, owner.access_token, { name: 'unrelated' });
    const path = `/api/v1/repositories/${repository.id}/activity`;
    expect((await call(app, path, { headers: bearer(other.access_token) })).status).toBe(404);
    const res = await call(app, path, { headers: bearer(owner.access_token) });
    const rows = ((await res.json()) as { activity: { repositoryName: string }[] }).activity;
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((row) => row.repositoryName === 'mine')).toBe(true);
  });

  it('fails stale provisioning and finishes stale deletions in the daily job', async () => {
    const { owner } = await twoAccounts();
    const db = getDb(env.DB);
    const old = Date.now() - STALE_LIFECYCLE_MS - 1000;
    const stuck = { provisioning: crypto.randomUUID(), deleting: crypto.randomUUID() } as const;
    for (const status of ['provisioning', 'deleting'] as const) {
      const id = stuck[status];
      await db.insert(repositories).values({
        id,
        ownerAccountId: owner.account.id,
        name: status,
        nameKey: status,
        createdAt: old,
        updatedAt: old,
        status,
        statusAt: old,
        storageKey: `repositories/${id}/`,
      });
    }
    await env.REPO_STORAGE.put(`repositories/${stuck.deleting}/meta.json`, '{}');

    await resumeLifecycle(db, env.REPO_STORAGE, Date.now());

    const rows = await db
      .select()
      .from(repositories)
      .where(eq(repositories.ownerAccountId, owner.account.id));
    expect(rows.map((row) => [row.id, row.status])).toEqual([[stuck.provisioning, 'failed']]);
    expect(await env.REPO_STORAGE.head(`repositories/${stuck.deleting}/meta.json`)).toBeNull();
  });
});
