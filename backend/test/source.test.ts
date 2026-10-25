import { env } from 'cloudflare:workers';
import { describe, expect, it } from 'vitest';
import { createApp } from '../src/app';
import { getDb } from '../src/db/client';
import { syncEvents } from '../src/db/schema';
import { artifactsHost, type GitHost, type HostTreeEntry } from '../src/lib/git-host';
import { call, fakeGoogle, postJson, signIn } from './helpers';

const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
const oid = (n: number) => n.toString(16).padStart(40, '0');

// A tiny object store per repository: commits point at trees, trees list entries, blobs are bytes.
function fakeHost() {
  const commits = new Map<string, { treeOid: string }>();
  const trees = new Map<string, HostTreeEntry[]>();
  const blobs = new Map<string, Uint8Array>();
  const tips = new Map<string, string>();
  let next = 1;
  const add = {
    blob(bytes: Uint8Array | string) {
      const id = oid(next++);
      blobs.set(id, typeof bytes === 'string' ? new TextEncoder().encode(bytes) : bytes);
      return id;
    },
    tree(entries: HostTreeEntry[]) {
      const id = oid(next++);
      trees.set(id, entries);
      return id;
    },
    commit(treeOid: string, branch?: string) {
      const id = oid(next++);
      commits.set(id, { treeOid });
      if (branch) tips.set(`refs/heads/${branch}`, id);
      return id;
    },
  };
  const host: GitHost = {
    ensure: async (name) => `https://acct.artifacts.cloudflare.net/git/gitdesk/${name}.git`,
    remove: async () => undefined,
    token: async () => ({ token: 'art_v1_token', expiresAt: Date.now() + 60_000 }),
    revokeAll: async () => 0,
    hasCommit: async (_name, id) => commits.has(id),
    tip: async (_name, ref) => tips.get(ref) ?? null,
    readCommit: async (_name, id) => {
      const commit = commits.get(id);
      return commit
        ? { oid: id, treeOid: commit.treeOid, author: 'Test', committedAt: 1, message: 'm' }
        : null;
    },
    readTree: async (_name, id) => trees.get(id) ?? null,
    readBlob: async (_name, id, max) => {
      const bytes = blobs.get(id);
      if (!bytes) return null;
      return { size: bytes.length, bytes: bytes.length > max ? null : bytes };
    },
  };
  return { host, add, tips };
}

const file = (name: string, id: string): HostTreeEntry => ({ name, mode: '100644', oid: id, type: 'blob' });
const dir = (name: string, id: string): HostTreeEntry => ({ name, mode: '40000', oid: id, type: 'tree' });

let nextIp = 160;

async function setup(options: { hosting?: boolean } = {}) {
  const google = await fakeGoogle();
  const fake = fakeHost();
  const app = createApp({
    google: google.provider,
    gitHost: options.hosting === false ? () => null : () => fake.host,
  });
  google.state.claims = { ...google.state.claims, sub: `owner-${crypto.randomUUID()}` };
  const owner = await signIn(app, google, `203.0.113.${nextIp++}`);
  google.state.claims = { ...google.state.claims, sub: `other-${crypto.randomUUID()}` };
  const other = await signIn(app, google, `203.0.113.${nextIp++}`);
  const res = await postJson(app, '/api/v1/repositories', { name: 'app' }, undefined, bearer(owner.access_token));
  const repo = ((await res.json()) as { repository: { id: string } }).repository;
  const get = (token: string, path: string) =>
    call(app, `/api/v1/repositories/${repo.id}${path}`, { headers: bearer(token) });
  return { fake, owner, other, repo, get };
}

describe('browsing hosted files', () => {
  it('lists one folder of the default branch, folders first, and pins the commit', async () => {
    const { fake, owner, get } = await setup();
    const src = fake.add.tree([file('main.ts', fake.add.blob('export {};\n'))]);
    const root = fake.add.tree([
      file('README.md', fake.add.blob('# app\n')),
      dir('src', src),
      file('a.txt', fake.add.blob('a')),
    ]);
    const commit = fake.add.commit(root, 'main');

    const res = await get(owner.access_token, '/tree?ref=HEAD');
    expect(res.status).toBe(200);
    const body = (await res.json()) as { commit: string; entries: { name: string; type: string; path: string }[] };
    expect(body.commit).toBe(commit);
    expect(body.entries.map((e) => [e.name, e.type])).toEqual([
      ['src', 'dir'],
      ['a.txt', 'file'],
      ['README.md', 'file'],
    ]);

    const nested = await get(owner.access_token, `/tree?ref=${commit}&path=src`);
    const inner = (await nested.json()) as { entries: { path: string }[] };
    expect(inner.entries.map((e) => e.path)).toEqual(['src/main.ts']);
  });

  it('answers 404 to another account, the same as a missing repository', async () => {
    const { fake, other, get } = await setup();
    fake.add.commit(fake.add.tree([]), 'main');
    const res = await get(other.access_token, '/tree?ref=main');
    expect(res.status).toBe(404);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('NOT_FOUND');
  });

  it('says which part is missing: the branch, or a folder in the commit', async () => {
    const { fake, owner, get } = await setup();
    const commit = fake.add.commit(fake.add.tree([]), 'main');
    const branch = await get(owner.access_token, '/tree?ref=gone');
    expect(((await branch.json()) as { error: { code: string } }).error.code).toBe('REF_NOT_FOUND');
    const folder = await get(owner.access_token, `/tree?ref=${commit}&path=nope`);
    expect(folder.status).toBe(404);
    expect(((await folder.json()) as { error: { code: string } }).error.code).toBe('PATH_NOT_FOUND');
  });

  it('refuses paths that climb out, name .git or have empty parts', async () => {
    const { fake, owner, get } = await setup();
    fake.add.commit(fake.add.tree([]), 'main');
    for (const path of ['../x', 'a/../b', '.git/config', '.GIT./config', 'a//b', '/abs', 'a\\b'])
      expect((await get(owner.access_token, `/tree?ref=main&path=${encodeURIComponent(path)}`)).status).toBe(400);
  });

  it('pages a large folder from one commit even after the branch moves', async () => {
    const { fake, owner, get } = await setup();
    const many = Array.from({ length: 501 }, (_, i) => file(`f${i}.txt`, fake.add.blob(String(i))));
    const first = fake.add.commit(fake.add.tree(many), 'main');
    const page1 = (await (await get(owner.access_token, '/tree?ref=main')).json()) as {
      commit: string;
      entries: unknown[];
      nextCursor: string;
    };
    expect(page1.entries).toHaveLength(500);
    expect(page1.commit).toBe(first);
    fake.add.commit(fake.add.tree([]), 'main');
    const page2 = (await (
      await get(owner.access_token, `/tree?ref=main&cursor=${page1.nextCursor}`)
    ).json()) as { commit: string; entries: unknown[]; nextCursor: null };
    expect(page2.commit).toBe(first);
    expect(page2.entries).toHaveLength(1);
    expect(page2.nextCursor).toBeNull();
  });

  it('shows text, and names binary, undecodable, image and oversized blobs', async () => {
    const { fake, owner, get } = await setup();
    fake.add.commit(fake.add.tree([]), 'main');
    const text = fake.add.blob('hello\n');
    const binary = fake.add.blob(new Uint8Array([1, 0, 2]));
    const latin1 = fake.add.blob(new Uint8Array([0x63, 0x61, 0x66, 0xe9]));
    const png = fake.add.blob(new Uint8Array([0x89, 0x50, 0x4e, 0x47]));
    const big = fake.add.blob('x'.repeat(1024 * 1024 + 1));
    const read = async (id: string, path: string, max = 1) =>
      (await get(owner.access_token, `/blobs/${id}?path=${path}&max=${max}`)).json() as Promise<Record<string, unknown>>;
    expect(await read(text, 'a.txt')).toMatchObject({ kind: 'text', text: 'hello\n', size: 6 });
    expect(await read(binary, 'a.bin')).toMatchObject({ kind: 'binary', reason: 'binary' });
    expect(await read(latin1, 'a.txt')).toMatchObject({ kind: 'binary', reason: 'encoding' });
    expect(await read(png, 'logo.png')).toMatchObject({ kind: 'image', mime: 'image/png', base64: 'iVBORw==' });
    expect(await read(big, 'big.txt')).toMatchObject({ kind: 'too-large', size: 1024 * 1024 + 1 });
    expect(await read(big, 'big.txt', 2)).toMatchObject({ kind: 'text' });
    expect((await get(owner.access_token, `/blobs/${oid(9999)}?path=a.txt`)).status).toBe(404);
    const raw = (await (
      await get(owner.access_token, `/blobs/${binary}?path=a.bin&raw=1`)
    ).json()) as Record<string, unknown>;
    expect(raw).toMatchObject({ kind: 'raw', size: 3, base64: 'AQAC' });
  });

  it('lists the default branch and the branches pushes reported, with their tips', async () => {
    const { fake, owner, repo, get } = await setup();
    const tree = fake.add.tree([]);
    const main = fake.add.commit(tree, 'main');
    const feature = fake.add.commit(tree, 'feature');
    const accountId = (owner as unknown as { account: { id: string } }).account.id;
    await getDb(env.DB)
      .insert(syncEvents)
      .values(
        ['refs/heads/feature', 'refs/heads/deleted'].map((ref) => ({
          operationId: crypto.randomUUID(),
          repositoryId: repo.id,
          accountId,
          kind: 'push' as const,
          ref,
          oldOid: null,
          newOid: main,
          result: 'confirmed' as const,
          tip: null,
          createdAt: 1,
        })),
      );
    const body = (await (await get(owner.access_token, '/branches')).json()) as {
      defaultBranch: string;
      branches: { name: string; oid: string }[];
    };
    expect(body.defaultBranch).toBe('main');
    expect(body.branches).toEqual([
      { name: 'main', oid: main },
      { name: 'feature', oid: feature },
    ]);
  });

  it('says hosting is off instead of failing', async () => {
    const { owner, get } = await setup({ hosting: false });
    const res = await get(owner.access_token, '/tree?ref=main');
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('GIT_HOSTING_UNAVAILABLE');
  });
});

describe('artifacts host reads', () => {
  it('maps tree entries, gives a size without bytes past the limit, and treats MEMORY_LIMIT as too large', async () => {
    const disposed: string[] = [];
    const tooBig = Object.assign(new Error('memory'), { code: 'MEMORY_LIMIT' });
    let blobCall = 0;
    const artifacts = {
      get: async (name: string) => ({
        readTree: async () => [{ name: 'a', mode: '100644', hash: oid(1), type: 'blob' }],
        readBlob: async () => {
          blobCall++;
          if (blobCall === 1) return new Blob(['hello']);
          if (blobCall === 2) return new Blob(['x'.repeat(20)]);
          throw tooBig;
        },
        [Symbol.dispose]: () => disposed.push(name),
      }),
    };
    const host = artifactsHost(artifacts as unknown as Artifacts);
    expect(await host.readTree('r', oid(2))).toEqual([{ name: 'a', mode: '100644', oid: oid(1), type: 'blob' }]);
    const small = await host.readBlob('r', oid(1), 10);
    expect(small?.size).toBe(5);
    expect(new TextDecoder().decode(small!.bytes!)).toBe('hello');
    expect(await host.readBlob('r', oid(1), 10)).toEqual({ size: 20, bytes: null });
    expect(await host.readBlob('r', oid(1), 10)).toEqual({ size: null, bytes: null });
    expect(disposed).toEqual(['r', 'r', 'r', 'r']);
  });
});
