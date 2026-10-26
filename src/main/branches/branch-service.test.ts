import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import { createWorkspaceService } from '../repos/workspace-service';
import { createJournal } from '../sync/journal';
import { createBranchService } from './branch-service';

// Real Git against a bare remote and its clones, the same commands the app runs.
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });
const oid = (cwd: string, rev: string) => git(cwd, 'rev-parse', rev).trim();

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
  process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
});

let dir: string;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gitdesk-br-'));
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  rmSync(dir, { recursive: true, force: true });
});

function commit(root: string, file: string, text: string, message: string) {
  writeFileSync(path.join(root, file), text);
  git(root, 'add', '--', file);
  git(root, 'commit', '-q', '-m', message);
}

// A bare remote with main and a pushed feature branch, and two clones: "app" and "other".
function world() {
  const bare = path.join(dir, 'remote.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
  const clone = (name: string) => {
    const root = path.join(dir, name);
    git(dir, 'clone', '-q', '-c', 'core.autocrlf=false', bare, root);
    return root;
  };
  const seed = clone('seed');
  commit(seed, 'shared.txt', 'one\n', 'Initial');
  git(seed, 'push', '-q', 'origin', 'main');
  git(seed, 'switch', '-q', '-c', 'feature');
  commit(seed, 'feature.txt', 'feature\n', 'Add feature');
  git(seed, 'push', '-q', 'origin', 'feature');
  return { bare, app: clone('app'), other: clone('other') };
}

async function setup(root: string) {
  const db = openDatabase(path.join(dir, 'test.db'));
  cleanups.push(() => db.close());
  const store = createRepositoryStore(db);
  const settings = { ...DEFAULT_SETTINGS, watchRepositories: false };
  const repos = createRepositoryService({
    store,
    remote: { create: vi.fn(), update: vi.fn() },
    settings: () => ({ ...settings, autoHostedRemote: false }),
    emit: vi.fn(),
    desktop: {
      pickDirectory: async () => root,
      openPath: async () => '',
      copyText: vi.fn(),
      trashItem: vi.fn(),
      protectedPaths: () => [],
    },
  });
  cleanups.push(() => repos.dispose());
  const added = await repos.add();
  if (added.status !== 'added') throw new Error('not added');
  const id = added.repository.id;
  const journal = createJournal(db);
  const addActivity = vi.fn(
    (
      repoId: string,
      type: Parameters<typeof store.addActivity>[1],
      detail: string | null,
    ) => store.addActivity(repoId, type, detail, Date.now()),
  );
  const ws = createWorkspaceService({
    store,
    journal,
    refresh: (repoId) => repos.refresh(repoId),
    addActivity,
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
  const pulls = createPullService({
    db,
    store,
    workspace: ws,
    recordsFor: () => {
      throw new Error('branch merges keep no records');
    },
    author: async () => ({ accountId: null, name: 'Test', avatarUrl: null }),
    viewed: { list: () => [], set: vi.fn() },
    addActivity,
    refresh: (repoId) => repos.refresh(repoId),
    log: { warn: vi.fn() },
  });
  const branches = createBranchService({
    store,
    workspace: ws,
    pulls,
    addActivity,
    refresh: (repoId) => repos.refresh(repoId),
  });
  return { id, ws, pulls, branches, journal, db, addActivity };
}

const job = () => crypto.randomUUID();
const local = (name: string) => ({ kind: 'local' as const, name });
const remote = (name: string) => ({ kind: 'remote' as const, name });

describe('overview', () => {
  it("compares against origin's default branch and names merged and protected branches", async () => {
    const { app } = world();
    git(app, 'branch', 'old', 'main');
    git(app, 'branch', '--track', 'feature', 'origin/feature');
    const { id, branches, ws } = await setup(app);
    ws.setPreferences({ id, protectedBranches: ['main', 'release/*'] });
    git(app, 'branch', 'release/1.0');
    const view = await branches.overview(id);
    expect(view.target).toMatchObject({ name: 'main', source: 'remote-head' });
    expect(view.merged.sort()).toEqual(['main', 'old', 'release/1.0']);
    expect(view.protected.sort()).toEqual(['main', 'release/1.0']);
  });

  it('follows the repository setting when it names a branch that exists', async () => {
    const { app } = world();
    const { id, branches, ws } = await setup(app);
    ws.setPreferences({ id, compareAgainst: 'origin/feature' });
    expect((await branches.overview(id)).target).toMatchObject({
      name: 'origin/feature',
      source: 'setting',
    });
  });
});

describe('create', () => {
  it('creates from each start point, tracking only a branch start, and never replaces one', async () => {
    const { app } = world();
    const { id, branches } = await setup(app);
    const fromRemote = await branches.create({
      id,
      name: 'mine',
      start: remote('origin/feature'),
      switchTo: false,
      track: 'always',
    });
    expect(fromRemote).toMatchObject({ status: 'done', switched: false });
    expect(git(app, 'config', '--get', 'branch.mine.merge').trim()).toBe(
      'refs/heads/feature',
    );
    expect(git(app, 'branch', '--show-current').trim()).toBe('main');

    const first = oid(app, 'main');
    const fromCommit = await branches.create({
      id,
      name: 'pinned',
      start: { kind: 'commit', oid: first.slice(0, 10) },
      switchTo: true,
      track: 'always',
    });
    expect(fromCommit).toMatchObject({ status: 'done', switched: true });
    expect(git(app, 'branch', '--show-current').trim()).toBe('pinned');
    expect(oid(app, 'pinned')).toBe(first);
    expect(() => git(app, 'config', '--get', 'branch.pinned.merge')).toThrow();

    const again = await branches.create({
      id,
      name: 'mine',
      start: { kind: 'head' },
      switchTo: false,
      track: 'git',
    });
    expect(again).toMatchObject({ status: 'blocked', reason: 'exists' });
    expect(oid(app, 'mine')).toBe(oid(app, 'origin/feature'));

    const missing = await branches.create({
      id,
      name: 'nowhere',
      start: { kind: 'commit', oid: 'deadbeefdeadbeef' },
      switchTo: false,
      track: 'git',
    });
    expect(missing).toMatchObject({ status: 'blocked', reason: 'not-found' });
  });

  it("refuses a switch that would overwrite edits and doesn't create the branch", async () => {
    const { app } = world();
    const { id, branches } = await setup(app);
    git(app, 'switch', '-q', '-c', 'side');
    commit(app, 'shared.txt', 'side\n', 'Side edit');
    git(app, 'switch', '-q', 'main');
    writeFileSync(path.join(app, 'shared.txt'), 'uncommitted\n');
    const result = await branches.create({
      id,
      name: 'from-side',
      start: local('side'),
      switchTo: true,
      track: 'never',
    });
    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'local-changes',
    });
    expect(() => oid(app, 'refs/heads/from-side')).toThrow();
  });
});

describe('rename and delete', () => {
  it('renames, reports the upstream it still tracks, and keeps Compare against pointing at it', async () => {
    const { app } = world();
    git(app, 'branch', '--track', 'feature', 'origin/feature');
    const { id, branches, ws } = await setup(app);
    ws.setPreferences({ id, compareAgainst: 'feature' });
    const result = await branches.rename({
      id,
      from: 'feature',
      to: 'feature-next',
    });
    expect(result).toMatchObject({
      status: 'done',
      branch: 'feature-next',
      upstream: 'origin/feature',
    });
    expect(ws.preferences(id).compareAgainst).toBe('feature-next');
    expect(git(app, 'branch', '--list', 'feature').trim()).toBe('');
  });

  it('refuses to rename or delete a protected branch', async () => {
    const { app } = world();
    git(app, 'branch', 'release/2.0');
    const { id, branches, ws } = await setup(app);
    ws.setPreferences({ id, protectedBranches: ['release/*'] });
    expect(
      await branches.rename({ id, from: 'release/2.0', to: 'x' }),
    ).toMatchObject({
      status: 'blocked',
      reason: 'protected',
    });
    expect(
      await branches.remove({ id, name: 'release/2.0', force: false }),
    ).toMatchObject({
      status: 'blocked',
      reason: 'protected',
    });
    expect(
      await branches.deleteRemote({
        id,
        remote: 'origin',
        branch: 'release/2.0',
        expectedOid: oid(app, 'main'),
        typedName: 'release/2.0',
        jobId: job(),
      }),
    ).toMatchObject({ status: 'failed', reason: 'protected' });
    expect(git(app, 'branch', '--list', 'release/2.0').trim()).toBe(
      'release/2.0',
    );
  });

  it('keeps a branch with unmerged work, lists its commits, and deletes it only with the name typed', async () => {
    const { app } = world();
    const { id, branches } = await setup(app);
    git(app, 'switch', '-q', '-c', 'wip');
    commit(app, 'wip.txt', 'one\n', 'First wip');
    commit(app, 'wip.txt', 'two\n', 'Second wip');
    git(app, 'switch', '-q', 'main');
    const kept = await branches.remove({ id, name: 'wip', force: false });
    expect(kept).toMatchObject({
      status: 'not-merged',
      total: 2,
      upstream: null,
    });
    if (kept.status !== 'not-merged') throw new Error('expected not-merged');
    expect(kept.commits.map((c) => c.subject)).toEqual([
      'Second wip',
      'First wip',
    ]);
    expect(
      await branches.remove({ id, name: 'wip', force: true, typedName: 'wi' }),
    ).toMatchObject({ status: 'blocked', reason: 'confirm-name' });
    expect(git(app, 'branch', '--list', 'wip').trim()).toBe('wip');
    expect(
      await branches.remove({ id, name: 'wip', force: true, typedName: 'wip' }),
    ).toMatchObject({ status: 'done' });
    expect(git(app, 'branch', '--list', 'wip').trim()).toBe('');
  });

  it("won't delete the current branch", async () => {
    const { app } = world();
    const { id, branches } = await setup(app);
    expect(
      await branches.remove({ id, name: 'main', force: false }),
    ).toMatchObject({
      status: 'blocked',
      reason: 'current',
    });
  });
});

describe('upstream, push and the remote', () => {
  it('sets and stops tracking an upstream on a branch that is not checked out', async () => {
    const { app } = world();
    git(app, 'branch', 'loose', 'main');
    const { id, branches } = await setup(app);
    expect(
      await branches.setUpstream({
        id,
        name: 'loose',
        upstream: 'origin/feature',
      }),
    ).toMatchObject({ status: 'done', upstream: 'origin/feature' });
    expect(git(app, 'config', '--get', 'branch.loose.merge').trim()).toBe(
      'refs/heads/feature',
    );
    expect(
      await branches.setUpstream({ id, name: 'loose', upstream: null }),
    ).toMatchObject({
      status: 'done',
      upstream: null,
    });
    expect(() => git(app, 'config', '--get', 'branch.loose.merge')).toThrow();
    expect(
      await branches.setUpstream({
        id,
        name: 'loose',
        upstream: 'origin/nope',
      }),
    ).toMatchObject({ status: 'blocked', reason: 'not-found' });
  });

  it('pushes a branch that is not checked out and publishes it with an upstream', async () => {
    const { app, bare } = world();
    git(app, 'switch', '-q', '-c', 'side');
    commit(app, 'side.txt', 'side\n', 'Side');
    git(app, 'switch', '-q', 'main');
    const { id, branches } = await setup(app);
    const result = await branches.push({ id, name: 'side', jobId: job() });
    expect(result).toMatchObject({ status: 'pushed', branch: 'side' });
    expect(oid(bare, 'refs/heads/side')).toBe(oid(app, 'side'));
    expect(git(app, 'config', '--get', 'branch.side.remote').trim()).toBe(
      'origin',
    );
    expect(git(app, 'branch', '--show-current').trim()).toBe('main');
  });

  it('deletes a remote branch only while it still points where you saw it', async () => {
    const { app, other, bare } = world();
    const { id, branches, journal } = await setup(app);
    const seen = oid(app, 'origin/feature');
    // Someone else pushes to feature after this computer fetched.
    git(other, 'switch', '-q', 'feature');
    commit(other, 'feature.txt', 'newer\n', 'Newer work');
    git(other, 'push', '-q', 'origin', 'feature');
    const moved = await branches.deleteRemote({
      id,
      remote: 'origin',
      branch: 'feature',
      expectedOid: seen,
      typedName: 'feature',
      jobId: job(),
    });
    expect(moved).toMatchObject({ status: 'failed', reason: 'moved' });
    expect(oid(bare, 'refs/heads/feature')).toBe(oid(other, 'feature'));

    git(app, 'fetch', '-q', 'origin');
    const deleted = await branches.deleteRemote({
      id,
      remote: 'origin',
      branch: 'feature',
      expectedOid: oid(app, 'origin/feature'),
      typedName: 'feature',
      jobId: job(),
    });
    expect(deleted).toMatchObject({
      status: 'deleted',
      remote: 'origin',
      branch: 'feature',
    });
    expect(() => oid(bare, 'refs/heads/feature')).toThrow();
    expect(() => oid(app, 'refs/remotes/origin/feature')).toThrow();
    if (deleted.status !== 'deleted') throw new Error('expected deleted');
    expect(journal.get(deleted.operationId!)).toMatchObject({
      kind: 'remote-delete',
      state: 'completed',
    });
  });

  it('asks the remote which branches moved, went or are new without fetching', async () => {
    const { app, other } = world();
    const { id, branches } = await setup(app);
    git(other, 'switch', '-q', 'feature');
    commit(other, 'feature.txt', 'newer\n', 'Newer');
    git(other, 'push', '-q', 'origin', 'feature');
    git(other, 'push', '-q', 'origin', 'feature:brand-new');
    git(other, 'push', '-q', 'origin', '--delete', 'feature');
    const before = oid(app, 'origin/feature');
    const check = await branches.checkRemote({ id, remote: 'origin' });
    expect(check).toMatchObject({
      status: 'checked',
      gone: ['origin/feature'],
      added: ['origin/brand-new'],
      moved: [],
    });
    expect(oid(app, 'origin/feature')).toBe(before);
  });
});

describe('compare and merge', () => {
  it('compares a local branch with a remote-tracking one on pinned commits', async () => {
    const { app } = world();
    const { id, branches } = await setup(app);
    const result = await branches.compare({
      id,
      base: local('main'),
      source: remote('origin/feature'),
    });
    expect(result).toMatchObject({ status: 'ok', behind: 0 });
    if (result.status !== 'ok') throw new Error('expected a comparison');
    expect(result.source.oid).toBe(oid(app, 'origin/feature'));
    expect(result.comparison.commits.map((c) => c.subject)).toEqual([
      'Add feature',
    ]);
    expect(result.comparison.files.map((f) => f.path)).toEqual(['feature.txt']);
    const diff = await branches.fileDiff({
      id,
      baseOid: result.base.oid,
      sourceOid: result.source.oid,
      path: 'feature.txt',
      oldPath: null,
      context: 3,
      ignoreWhitespace: false,
      full: false,
    });
    expect(diff).toMatchObject({ status: 'text', added: 1 });
    expect(
      await branches.compare({
        id,
        base: local('main'),
        source: remote('origin/main'),
      }),
    ).toMatchObject({ status: 'problem', problem: 'same-commit' });
  });

  it('checks mergeability in memory and remembers the answer for the same commits', async () => {
    const { app } = world();
    const { id, branches } = await setup(app);
    git(app, 'switch', '-q', '-c', 'clash');
    commit(app, 'shared.txt', 'clash\n', 'Clash');
    git(app, 'switch', '-q', 'main');
    commit(app, 'shared.txt', 'main side\n', 'Main side');
    const target = oid(app, 'main');
    const clash = await branches.mergeability({
      id,
      targetOid: target,
      sourceOid: oid(app, 'clash'),
    });
    expect(clash).toMatchObject({
      mergeability: 'conflicts',
      conflicts: ['shared.txt'],
    });
    const list = await branches.listMergeability({
      id,
      targetOid: target,
      sourceOids: [oid(app, 'clash'), oid(app, 'origin/feature'), target],
    });
    expect(list.map((c) => c.mergeability)).toEqual(['conflicts', 'mergeable']);
    expect(list[0]!.checkedAt).toBe(clash.checkedAt);
    expect(git(app, 'status', '--porcelain').trim()).toBe('');
  });

  it('fast-forwards by default, refuses fast-forward only on diverged history, and asks for protected targets', async () => {
    const { app } = world();
    git(app, 'branch', '--track', 'feature', 'origin/feature');
    const { id, branches, ws } = await setup(app);
    ws.setPreferences({ id, protectedBranches: ['main'] });
    const input = {
      id,
      target: 'main',
      source: local('feature'),
      targetOid: oid(app, 'main'),
      sourceOid: oid(app, 'feature'),
      method: 'default' as const,
      push: false,
      confirmProtected: false,
      jobId: job(),
    };
    expect(await branches.merge(input)).toMatchObject({
      status: 'blocked',
      reason: 'protected',
    });
    const merged = await branches.merge({ ...input, confirmProtected: true });
    expect(merged).toMatchObject({
      status: 'merged',
      fastForward: true,
      push: 'skipped',
    });
    expect(oid(app, 'main')).toBe(oid(app, 'feature'));

    commit(app, 'main.txt', 'main\n', 'On main');
    git(app, 'switch', '-q', 'feature');
    commit(app, 'feature2.txt', 'f\n', 'On feature');
    const ffOnly = await branches.merge({
      ...input,
      confirmProtected: true,
      method: 'ff-only',
      targetOid: oid(app, 'main'),
      sourceOid: oid(app, 'feature'),
    });
    expect(ffOnly).toMatchObject({
      status: 'blocked',
      reason: 'not-fast-forward',
    });
    expect(git(app, 'branch', '--show-current').trim()).toBe('feature');
  });

  it('refuses commits that moved since the comparison', async () => {
    const { app } = world();
    git(app, 'branch', '--track', 'feature', 'origin/feature');
    const { id, branches } = await setup(app);
    const result = await branches.merge({
      id,
      target: 'main',
      source: local('feature'),
      targetOid: oid(app, 'main'),
      sourceOid: oid(app, 'main'),
      method: 'no-ff',
      push: false,
      confirmProtected: false,
      jobId: job(),
    });
    expect(result).toMatchObject({ status: 'blocked', reason: 'changed' });
  });

  it('stops on conflicts with both branches named, then continues or aborts through Git', async () => {
    const { app } = world();
    const { id, branches, pulls } = await setup(app);
    git(app, 'switch', '-q', '-c', 'clash');
    commit(app, 'shared.txt', 'clash\n', 'Clash');
    git(app, 'switch', '-q', 'main');
    commit(app, 'shared.txt', 'main side\n', 'Main side');
    const input = {
      id,
      target: 'main',
      source: local('clash'),
      targetOid: oid(app, 'main'),
      sourceOid: oid(app, 'clash'),
      method: 'no-ff' as const,
      push: false,
      confirmProtected: false,
      jobId: job(),
    };
    expect(await branches.merge(input)).toMatchObject({ status: 'conflicts' });
    expect(await pulls.conflicts(id)).toMatchObject({
      operation: 'merge',
      pullId: null,
      branchMerge: { target: 'main', source: 'clash' },
      external: null,
    });
    await pulls.abortMerge(id);
    expect(oid(app, 'main')).toBe(input.targetOid);
    expect(git(app, 'status', '--porcelain').trim()).toBe('');

    expect(await branches.merge({ ...input, jobId: job() })).toMatchObject({
      status: 'conflicts',
    });
    writeFileSync(path.join(app, 'shared.txt'), 'both\n');
    git(app, 'add', 'shared.txt');
    const done = await pulls.continueMerge(id);
    expect(done).toMatchObject({ status: 'merged' });
    expect(
      git(app, 'log', '-1', '--format=%P', 'main').trim().split(' '),
    ).toEqual([input.targetOid, input.sourceOid]);
  });
});
