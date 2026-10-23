import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { openDatabase } from '../db/database';
import { createPullService } from '../pulls/pull-service';
import { createRepositoryService } from '../repos/repository-service';
import { createRepositoryStore } from '../repos/repository-store';
import {
  classifyPushError,
  createWorkspaceService,
  syncCodeFor,
} from '../repos/workspace-service';
import { createJournal } from './journal';
import { createSyncService } from './sync-service';

// Real Git against a local bare remote, the way the app runs it.
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
  process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
});

let dir: string;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gitdesk-sync-'));
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  rmSync(dir, { recursive: true, force: true });
});

function commit(root: string, file: string, text: string, message: string) {
  writeFileSync(path.join(root, file), text);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD');
}

// A bare remote with one commit and two clones of it: "app" (gitdesk's) and "other" (someone else).
function world() {
  const bare = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  const clone = (name: string) => {
    const root = path.join(dir, name);
    // Set at clone time, so the checkout itself never rewrites line endings.
    git(dir, 'clone', '-q', '-c', 'core.autocrlf=false', bare, root);
    return root;
  };
  const seed = clone('seed');
  commit(seed, 'shared.txt', 'one\n', 'Initial');
  git(seed, 'push', '-q', 'origin', 'main');
  return { bare, app: clone('app'), other: clone('other') };
}

async function setup(roots: string[]) {
  const db = openDatabase(path.join(dir, 'test.db'));
  cleanups.push(() => db.close());
  const store = createRepositoryStore(db);
  const settings = { ...DEFAULT_SETTINGS, watchRepositories: false };
  let picked = roots[0]!;
  const repos = createRepositoryService({
    store,
    remote: { create: vi.fn(), update: vi.fn() },
    settings: () => ({ ...settings, autoHostedRemote: false }),
    emit: vi.fn(),
    desktop: {
      pickDirectory: async () => picked,
      openPath: async () => '',
      copyText: vi.fn(),
      trashItem: vi.fn(),
      protectedPaths: () => [],
    },
  });
  cleanups.push(() => repos.dispose());
  const ids: string[] = [];
  for (const root of roots) {
    picked = root;
    const added = await repos.add();
    if (added.status !== 'added') throw new Error('not added');
    ids.push(added.repository.id);
  }
  const journal = createJournal(db);
  const ws = createWorkspaceService({
    store,
    journal,
    refresh: (repoId) => repos.refresh(repoId),
    addActivity: (repoId, type, detail) =>
      store.addActivity(repoId, type, detail, Date.now()),
    settings: () => settings,
    watcher: {
      watch: vi.fn(),
      unwatch: vi.fn(),
      watching: () => null,
      dispose: vi.fn(),
    },
    desktop: {
      trashItem: vi.fn(),
      showItemInFolder: vi.fn(),
      openPath: vi.fn(async () => ''),
      copyText: vi.fn(),
      isOnline: () => true,
    },
  });
  cleanups.push(() => ws.dispose());
  const sync = createSyncService({
    store,
    journal,
    workspace: ws,
    addActivity: (repoId, type, detail) =>
      store.addActivity(repoId, type, detail, Date.now()),
    refresh: (repoId) => repos.refresh(repoId),
    log: { warn: vi.fn() },
  });
  const pulls = createPullService({
    db,
    store,
    workspace: ws,
    recordsFor: () => {
      throw new Error('no records in these tests');
    },
    author: async () => ({ accountId: null, name: 'Test', avatarUrl: null }),
    viewed: { list: () => [], set: vi.fn() },
    addActivity: (repoId, type, detail) =>
      store.addActivity(repoId, type, detail, Date.now()),
    refresh: (repoId) => repos.refresh(repoId),
    log: { warn: vi.fn() },
  });
  return { ids, ws, sync, journal, pulls, store, db };
}

const job = () => crypto.randomUUID();

describe('sync status', () => {
  it('names each state from Git, not from counts alone', async () => {
    const { bare, app, other } = world();
    const { ids, sync, ws } = await setup([app]);
    const id = ids[0]!;
    const state = async () => (await sync.overview(id)).state;

    expect(await state()).toBe('up-to-date');
    commit(app, 'mine.txt', 'm\n', 'Mine');
    await ws.fetch({ id, remote: 'origin', jobId: job() });
    expect(await sync.overview(id)).toMatchObject({
      state: 'ahead',
      ahead: 1,
      behind: 0,
    });

    commit(other, 'theirs.txt', 't\n', 'Theirs');
    git(other, 'push', '-q', 'origin', 'main');
    await ws.fetch({ id, remote: 'origin', jobId: job() });
    const diverged = await sync.overview(id);
    expect(diverged).toMatchObject({
      state: 'diverged',
      ahead: 1,
      behind: 1,
      upstream: 'origin/main',
      stale: false,
    });
    expect(diverged.fetchedAt).not.toBeNull();
    expect(diverged.recent[0]).toMatchObject({
      kind: 'fetch',
      state: 'completed',
    });

    git(app, 'switch', '-q', '-c', 'feature');
    await ws.fetch({ id, remote: 'origin', jobId: job() });
    expect(await state()).toBe('no-upstream');

    git(app, 'push', '-q', '-u', 'origin', 'feature');
    git(bare, 'branch', '-D', 'feature');
    git(app, 'fetch', '-q', '--prune', 'origin');
    await ws.fetch({ id, remote: 'origin', jobId: job() });
    expect(await state()).toBe('gone');
  });

  it('compares outgoing and incoming commits', async () => {
    const { app, other } = world();
    const { ids, sync, ws } = await setup([app]);
    const id = ids[0]!;
    commit(app, 'mine.txt', 'm\n', 'Mine');
    commit(other, 'theirs.txt', 't\n', 'Theirs');
    git(other, 'push', '-q', 'origin', 'main');
    await ws.fetch({ id, remote: 'origin', jobId: job() });
    const result = await sync.compare(id);
    expect(result.upstream).toBe('origin/main');
    expect(result.outgoing?.commits.map((c) => c.subject)).toEqual(['Mine']);
    expect(result.incoming?.commits.map((c) => c.subject)).toEqual(['Theirs']);
  });

  it('checks the remote tip without downloading', async () => {
    const { app, other } = world();
    const { ids, sync } = await setup([app]);
    const id = ids[0]!;
    expect(await sync.check(id)).toMatchObject({ status: 'same' });
    const theirs = commit(other, 'theirs.txt', 't\n', 'Theirs');
    git(other, 'push', '-q', 'origin', 'main');
    expect(await sync.check(id)).toEqual({ status: 'moved', oid: theirs });
  });
});

describe('pull', () => {
  it('fast-forwards, and refuses a diverged branch without changing it', async () => {
    const { app, other } = world();
    const { ids, sync } = await setup([app]);
    const id = ids[0]!;
    const theirs = commit(other, 'theirs.txt', 't\n', 'Theirs');
    git(other, 'push', '-q', 'origin', 'main');
    expect(
      await sync.pull({ id, jobId: job(), strategy: 'ff-only' }),
    ).toMatchObject({
      status: 'pulled',
      mode: 'fast-forward',
    });
    expect(git(app, 'rev-parse', 'HEAD')).toBe(theirs);

    const mine = commit(app, 'mine.txt', 'm\n', 'Mine');
    commit(other, 'more.txt', 'x\n', 'More');
    git(other, 'push', '-q', 'origin', 'main');
    expect(
      await sync.pull({ id, jobId: job(), strategy: 'ff-only' }),
    ).toMatchObject({
      status: 'stopped',
      code: 'DIVERGED',
    });
    expect(git(app, 'rev-parse', 'HEAD')).toBe(mine);
  });

  it('merges, stops on conflicts, and finishes on the shared conflict screen', async () => {
    const { app, other } = world();
    const { ids, sync, pulls, journal } = await setup([app]);
    const id = ids[0]!;
    commit(app, 'shared.txt', 'mine\n', 'Mine');
    const theirs = commit(other, 'shared.txt', 'theirs\n', 'Theirs');
    git(other, 'push', '-q', 'origin', 'main');

    const result = await sync.pull({ id, jobId: job(), strategy: 'merge' });
    expect(result).toEqual({
      status: 'conflicts',
      files: ['shared.txt'],
      upstream: 'origin/main',
    });
    expect(journal.pending(id)).toMatchObject({
      kind: 'pull',
      state: 'conflict_resolution',
    });
    expect(await pulls.conflicts(id)).toMatchObject({
      operation: 'merge',
      pullId: null,
      upstream: { ours: 'main', theirs: 'origin/main' },
    });

    await pulls.resolveConflict({
      repoId: id,
      path: 'shared.txt',
      take: 'source',
    });
    const done = await pulls.continueMerge(id);
    expect(done).toMatchObject({ status: 'merged', push: 'skipped' });
    expect(git(app, 'merge-base', '--is-ancestor', theirs, 'HEAD')).toBe('');
    expect(journal.pending(id)).toBeNull();
  });

  it('undoes a rebase that stops on a conflict', async () => {
    const { app, other } = world();
    const { ids, sync } = await setup([app]);
    const id = ids[0]!;
    const mine = commit(app, 'shared.txt', 'mine\n', 'Mine');
    commit(other, 'shared.txt', 'theirs\n', 'Theirs');
    git(other, 'push', '-q', 'origin', 'main');
    expect(
      await sync.pull({ id, jobId: job(), strategy: 'rebase' }),
    ).toMatchObject({
      status: 'stopped',
      code: 'LOCAL_CONFLICT',
    });
    expect(git(app, 'rev-parse', 'HEAD')).toBe(mine);
    expect(existsSync(path.join(app, '.git', 'rebase-merge'))).toBe(false);
  });

  it('rebases a clean branch and refuses uncommitted changes', async () => {
    const { app, other } = world();
    const { ids, sync } = await setup([app]);
    const id = ids[0]!;
    commit(app, 'mine.txt', 'm\n', 'Mine');
    const theirs = commit(other, 'theirs.txt', 't\n', 'Theirs');
    git(other, 'push', '-q', 'origin', 'main');
    writeFileSync(path.join(app, 'mine.txt'), 'edited\n');
    expect(
      await sync.pull({ id, jobId: job(), strategy: 'rebase' }),
    ).toMatchObject({
      status: 'stopped',
      code: 'LOCAL_CHANGES',
      files: ['mine.txt'],
    });
    git(app, 'checkout', '--', 'mine.txt');
    expect(
      await sync.pull({ id, jobId: job(), strategy: 'rebase' }),
    ).toMatchObject({
      status: 'pulled',
      mode: 'rebase',
    });
    expect(git(app, 'rev-parse', 'HEAD~1')).toBe(theirs);
  });
});

describe('push and publish', () => {
  it('lets exactly one of two simultaneous pushes land, and keeps it', async () => {
    const { bare, app, other } = world();
    const { ids, ws } = await setup([app, other]);
    const a = commit(app, 'a.txt', 'a\n', 'From app');
    const b = commit(other, 'b.txt', 'b\n', 'From other');
    const results = await Promise.all([
      ws.push({ id: ids[0]!, jobId: job() }),
      ws.push({ id: ids[1]!, jobId: job() }),
    ]);
    const won = results.filter((r) => r.status === 'pushed');
    const lost = results.filter((r) => r.status === 'failed');
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(1);
    expect(['NON_FAST_FORWARD', 'REMOTE_REJECTED']).toContain(
      lost[0]!.status === 'failed' ? lost[0]!.code : null,
    );
    const tip = git(bare, 'rev-parse', 'main');
    const winner = results[0]!.status === 'pushed' ? a : b;
    const loser = winner === a ? b : a;
    expect(tip).toBe(winner);
    expect(() =>
      git(bare, 'merge-base', '--is-ancestor', loser, tip),
    ).toThrow();
  });

  it('publishes under a new name and tracks it; set upstream needs the ref', async () => {
    const { bare, app } = world();
    const { ids, sync, journal } = await setup([app]);
    const id = ids[0]!;
    git(app, 'switch', '-q', '-c', 'local-name');
    const oid = commit(app, 'f.txt', 'f\n', 'Feature');
    const result = await sync.publish({
      id,
      jobId: job(),
      remote: 'origin',
      branch: 'feature/cache',
    });
    expect(result).toMatchObject({ status: 'pushed' });
    expect(git(bare, 'rev-parse', 'feature/cache')).toBe(oid);
    expect(git(app, 'config', '--get', 'branch.local-name.merge')).toBe(
      'refs/heads/feature/cache',
    );
    expect(journal.marks(id, 'origin').pushedAt).not.toBeNull();

    git(app, 'switch', '-q', '-c', 'second');
    await expect(
      sync.setUpstream({ id, remote: 'origin', branch: 'missing' }),
    ).rejects.toThrow(/isn't here yet/);
    await sync.setUpstream({ id, remote: 'origin', branch: 'main' });
    expect(git(app, 'rev-parse', '--abbrev-ref', '@{u}')).toBe('origin/main');
  });

  it('settles an unknown push from what the remote holds', async () => {
    const { app } = world();
    const { ids, sync, journal } = await setup([app]);
    const id = ids[0]!;
    const before = git(app, 'rev-parse', 'HEAD');
    const mine = commit(app, 'mine.txt', 'm\n', 'Mine');
    const opId = journal.start({
      repoId: id,
      kind: 'push',
      state: 'unknown',
      remote: 'origin',
      branch: 'main',
      oldOid: before,
      newOid: mine,
    });
    expect(await sync.checkPush({ id, operationId: opId })).toEqual({
      status: 'not-pushed',
    });

    git(app, 'push', '-q', 'origin', 'main');
    const again = journal.start({
      repoId: id,
      kind: 'push',
      state: 'unknown',
      remote: 'origin',
      branch: 'main',
      oldOid: before,
      newOid: mine,
    });
    expect(await sync.checkPush({ id, operationId: again })).toEqual({
      status: 'completed',
    });
    expect(journal.get(again)).toMatchObject({ state: 'completed' });
  });

  it('marks a push a crash interrupted as unknown at start-up', async () => {
    const { app } = world();
    const { ids, sync, journal } = await setup([app]);
    const opId = journal.start({
      repoId: ids[0]!,
      kind: 'push',
      state: 'pushing',
      remote: 'origin',
      branch: 'main',
      newOid: git(app, 'rev-parse', 'HEAD'),
    });
    await sync.recover();
    expect(journal.get(opId)).toMatchObject({
      state: 'unknown',
      code: 'OPERATION_RESULT_UNKNOWN',
    });
    expect(journal.pending(ids[0]!)?.id).toBe(opId);
  });
});

describe('error codes', () => {
  it('reads the stable code from what Git printed', () => {
    const code = (text: string) => syncCodeFor(classifyPushError(text), text);
    expect(
      code(
        "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 404",
      ),
    ).toBe('REPOSITORY_NOT_FOUND');
    expect(
      code(
        "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 403",
      ),
    ).toBe('ACCESS_DENIED');
    expect(
      code(
        "fatal: unable to access 'https://x/r.git/': The requested URL returned error: 401",
      ),
    ).toBe('AUTH_EXPIRED');
    expect(code(' ! [rejected]        main -> main (fetch first)')).toBe(
      'NON_FAST_FORWARD',
    );
    expect(code(' ! [remote rejected] main -> main (cannot lock ref)')).toBe(
      'REMOTE_REJECTED',
    );
    expect(
      code("fatal: unable to access 'https://x/': Could not resolve host: x"),
    ).toBe('REMOTE_UNAVAILABLE');
  });
});
