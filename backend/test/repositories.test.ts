import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { call, fakeGoogle, postJson, signIn } from './helpers';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });

type Remote = { id: string; name: string; description: string | null; visibility: string };

async function twoAccounts() {
  const google = await fakeGoogle();
  const app = createApp({ google: google.provider });
  google.state.claims = { ...google.state.claims, sub: `owner-${crypto.randomUUID()}` };
  const owner = await signIn(app, google, '198.51.100.40');
  google.state.claims = { ...google.state.claims, sub: `other-${crypto.randomUUID()}` };
  const other = await signIn(app, google, '198.51.100.41');
  return { app, owner, other };
}

const create = (app: ReturnType<typeof createApp>, token: string, body: unknown) =>
  postJson(app, '/api/v1/repositories', body, undefined, bearer(token));

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
    const { app, owner } = await twoAccounts();
    for (const name of ['', '.hidden', 'a b', '../up', 'x.git', 'a/b', 'x'.repeat(101)]) {
      expect((await create(app, owner.access_token, { name })).status).toBe(400);
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
});
