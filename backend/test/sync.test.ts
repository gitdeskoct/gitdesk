import { env } from 'cloudflare:workers';
import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { getDb } from '../src/db/client';
import { syncEvents } from '../src/db/schema';
import { purgeExpired } from '../src/jobs/cleanup';
import type { GitHost } from '../src/lib/git-host';
import { call, fakeGoogle, postJson, signIn } from './helpers';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);

// What Artifacts holds per repository: the commits it stores and each branch tip.
function fakeHost(fail = false) {
  const stored = new Map<string, { commits: Set<string>; tips: Map<string, string> }>();
  const host: GitHost = {
    async ensure(name) {
      if (!stored.has(name)) stored.set(name, { commits: new Set(), tips: new Map() });
      return `https://acct.artifacts.cloudflare.net/git/gitdesk/${name}.git`;
    },
    async remove(name) {
      stored.delete(name);
    },
    async token() {
      return { token: 'art_v1_token', expiresAt: Date.now() + 60_000 };
    },
    async revokeAll() {
      return 0;
    },
    async hasCommit(name, oid) {
      if (fail) throw Object.assign(new Error('down'), { code: 'UPSTREAM_UNAVAILABLE' });
      return stored.get(name)?.commits.has(oid) ?? false;
    },
    async tip(name, ref) {
      return stored.get(name)?.tips.get(ref) ?? null;
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
  return { host, stored };
}

let nextIp = 40;

async function setup(options: { hosting?: boolean; fail?: boolean } = {}) {
  const google = await fakeGoogle();
  const fake = fakeHost(options.fail);
  const app = createApp({
    google: google.provider,
    gitHost: options.hosting === false ? () => null : () => fake.host,
  });
  google.state.claims = { ...google.state.claims, sub: `owner-${crypto.randomUUID()}` };
  const owner = await signIn(app, google, `203.0.113.${nextIp++}`);
  google.state.claims = { ...google.state.claims, sub: `other-${crypto.randomUUID()}` };
  const other = await signIn(app, google, `203.0.113.${nextIp++}`);
  const create = async (name: string) => {
    const res = await postJson(app, '/api/v1/repositories', { name }, undefined, bearer(owner.access_token));
    return ((await res.json()) as { repository: { id: string } }).repository;
  };
  const report = (token: string, id: string, body: unknown) =>
    call(app, `/api/v1/repositories/${id}/sync-events`, {
      method: 'POST',
      body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', ...bearer(token) },
    });
  return { fake, owner, other, create, report, app };
}

const push = (overrides: Record<string, unknown> = {}) => ({
  operationId: crypto.randomUUID(),
  kind: 'push',
  ref: 'refs/heads/main',
  oldOid: null,
  newOid: A,
  ...overrides,
});

describe('sync events', () => {
  it('confirms a push whose commit Artifacts stores, and reports the tip', async () => {
    const { fake, owner, create, report } = await setup();
    const repo = await create('app');
    fake.stored.get(repo.id)!.commits.add(A);
    fake.stored.get(repo.id)!.tips.set('refs/heads/main', A);
    const res = await report(owner.access_token, repo.id, push());
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ event: { result: 'confirmed', tip: A } });

    const missing = await report(owner.access_token, repo.id, push({ newOid: B }));
    expect(await missing.json()).toEqual({ event: { result: 'unverified', tip: A } });
  });

  it('records one row per operation, however often it is reported', async () => {
    const { fake, owner, create, report } = await setup();
    const repo = await create('app');
    fake.stored.get(repo.id)!.commits.add(A);
    const body = push();
    for (let i = 0; i < 3; i++) expect((await report(owner.access_token, repo.id, body)).status).toBe(200);
    const rows = await getDb(env.DB)
      .select()
      .from(syncEvents)
      .where(eq(syncEvents.operationId, body.operationId));
    expect(rows).toHaveLength(1);

    const second = await create('second');
    const reused = await report(owner.access_token, second.id, body);
    expect(reused.status).toBe(409);
  });

  it('leaves a push unverified with hosting off or Artifacts down', async () => {
    const off = await setup({ hosting: false });
    const offRepo = await off.create('app');
    expect(await (await off.report(off.owner.access_token, offRepo.id, push())).json()).toEqual({
      event: { result: 'unverified', tip: null },
    });
    const down = await setup({ fail: true });
    const downRepo = await down.create('app');
    expect(await (await down.report(down.owner.access_token, downRepo.id, push())).json()).toEqual({
      event: { result: 'unverified', tip: null },
    });
  });

  it("refuses another account's repository and malformed reports", async () => {
    const { owner, other, create, report } = await setup();
    const repo = await create('app');
    expect((await report(other.access_token, repo.id, push())).status).toBe(404);
    for (const bad of [
      push({ ref: 'refs/tags/v1' }),
      push({ ref: 'refs/heads/../main' }),
      push({ newOid: 'not-an-oid' }),
      push({ kind: 'fetch' }),
      { ...push(), extra: true },
    ])
      expect((await report(owner.access_token, repo.id, bad)).status).toBe(400);
  });

  it('purges records older than half a year', async () => {
    const { fake, owner, create, report } = await setup();
    const repo = await create('app');
    fake.stored.get(repo.id)!.commits.add(A);
    const body = push();
    await report(owner.access_token, repo.id, body);
    const db = getDb(env.DB);
    await purgeExpired(db, Date.now() + 181 * 24 * 60 * 60_000);
    expect(await db.select().from(syncEvents).where(eq(syncEvents.operationId, body.operationId))).toHaveLength(0);
  });

  it("lists the account's pushes newest first, a page at a time, and never another account's", async () => {
    const { fake, owner, other, create, report, app } = await setup();
    const repo = await create('app');
    fake.stored.get(repo.id)!.commits.add(A);
    await report(owner.access_token, repo.id, push());
    await report(owner.access_token, repo.id, push({ newOid: B }));
    const get = (token: string, query: string) =>
      call(app, `/api/v1/sync-events${query}`, { headers: bearer(token) });

    const first = await get(owner.access_token, '?limit=1');
    const page1 = (await first.json()) as {
      events: { newOid: string; result: string; repositoryName: string }[];
      nextCursor: string | null;
    };
    expect(page1.events).toHaveLength(1);
    expect(page1.events[0]).toMatchObject({ repositoryName: 'app' });
    expect(page1.nextCursor).toBeTruthy();
    const page2 = (await (
      await get(owner.access_token, `?limit=1&cursor=${page1.nextCursor}`)
    ).json()) as { events: { newOid: string }[]; nextCursor: string | null };
    expect(page2.events).toHaveLength(1);
    expect(page2.events[0]!.newOid).not.toBe(page1.events[0]!.newOid);
    expect(page2.nextCursor).toBeNull();

    const unverified = (await (
      await get(owner.access_token, '?result=unverified')
    ).json()) as { events: { newOid: string }[] };
    expect(unverified.events.map((e) => e.newOid)).toEqual([B]);

    expect(
      ((await (await get(other.access_token, '')).json()) as { events: unknown[] }).events,
    ).toEqual([]);
    expect((await get(owner.access_token, '?cursor=bad!')).status).toBe(400);
  });

  it('counts pushes per week for the last 8 weeks', async () => {
    const { fake, owner, create, report, app } = await setup();
    const repo = await create('app');
    fake.stored.get(repo.id)!.commits.add(A);
    await report(owner.access_token, repo.id, push());
    await report(owner.access_token, repo.id, push({ newOid: B }));
    const res = await call(app, '/api/v1/sync-events/stats', {
      headers: bearer(owner.access_token),
    });
    const { weeks } = (await res.json()) as {
      weeks: { start: number; confirmed: number; unverified: number }[];
    };
    expect(weeks).toHaveLength(8);
    expect(weeks[7]).toMatchObject({ confirmed: 1, unverified: 1 });
    expect(weeks.slice(0, 7).every((w) => w.confirmed + w.unverified === 0)).toBe(true);
    expect(new Date(weeks[7]!.start).getUTCDay()).toBe(1);
  });
});
