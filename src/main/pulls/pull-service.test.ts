import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import { openDatabase } from '../db/database';
import { createRepositoryService } from '../repos/repository-service';
import { createRepositoryStore } from '../repos/repository-store';
import { createWorkspaceService } from '../repos/workspace-service';
import { createLocalRecords, createViewedStore } from './local-records';
import { parseMergeTree, parseNameStatus, parseNumstatFiles } from './pull-git';
import { createPullService } from './pull-service';
import type { PullRecords } from './records';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
  process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
});

let dir: string;
const cleanups: (() => void)[] = [];
let settings: Settings;

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gitdesk-pr-'));
  settings = { ...DEFAULT_SETTINGS, watchRepositories: false };
});
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  rmSync(dir, { recursive: true, force: true });
});

const write = (root: string, file: string, text: string) => {
  mkdirSync(path.dirname(path.join(root, file)), { recursive: true });
  writeFileSync(path.join(root, file), text);
};
const commit = (root: string, message: string) => {
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', message);
  return git(root, 'rev-parse', 'HEAD').trim();
};

// main has README and search.ts; feature changes search.ts and adds a file.
function makeRepo(): string {
  const root = path.join(dir, 'app');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  write(root, 'README.md', '# app\n');
  write(
    root,
    'src/search.ts',
    'export function search(q) {\n  const a = 1;\n  return q.trim();\n}\n',
  );
  commit(root, 'Initial');
  git(root, 'switch', '-q', '-c', 'feature');
  write(
    root,
    'src/search.ts',
    'export function search(q) {\n  const a = 1;\n  return normalize(q);\n}\n',
  );
  write(root, 'src/filters.ts', 'export const filters = [];\n');
  commit(root, 'Improve search');
  git(root, 'switch', '-q', 'main');
  return root;
}

async function setup(
  root: string,
  wrapRecords?: (records: PullRecords) => PullRecords,
) {
  const db = openDatabase(path.join(dir, 'test.db'));
  cleanups.push(() => db.close());
  const store = createRepositoryStore(db);
  const repos = createRepositoryService({
    store,
    remote: { create: vi.fn(), update: vi.fn() },
    settings: () => settings,
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
  const repoId = added.repository.id;
  const workspace = createWorkspaceService({
    store,
    refresh: (id) => repos.refresh(id),
    addActivity: (id, type, detail) =>
      store.addActivity(id, type, detail, Date.now()),
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
  cleanups.push(() => workspace.dispose());
  const records = createLocalRecords(db, repoId);
  const pulls = createPullService({
    db,
    store,
    workspace,
    recordsFor: () => (wrapRecords ? wrapRecords(records) : records),
    author: async () => ({ accountId: null, name: 'Test', avatarUrl: null }),
    viewed: createViewedStore(db),
    addActivity: (id, type, detail) =>
      store.addActivity(id, type, detail, Date.now()),
    refresh: (id) => repos.refresh(id),
    log: { warn: vi.fn() },
  });
  const open = (
    title = 'Improve search',
    source = 'feature',
    target = 'main',
  ) =>
    pulls.create({
      repoId,
      title,
      description: '',
      source,
      target,
      draft: false,
      key: crypto.randomUUID(),
    });
  return { repoId, pulls, open, store };
}

const job = () => crypto.randomUUID();

describe('comparing branches', () => {
  it('refuses pairs that make no pull request', async () => {
    const root = makeRepo();
    git(root, 'switch', '-q', '--orphan', 'unrelated');
    write(root, 'other.txt', 'x\n');
    commit(root, 'Unrelated');
    git(root, 'switch', '-q', 'main');
    git(root, 'branch', 'behind', 'main');
    const { repoId, pulls } = await setup(root);
    const problem = async (source: string, target: string) => {
      const result = await pulls.compare({ repoId, source, target });
      return result.status === 'problem' ? result.problem : 'ok';
    };
    expect(await problem('main', 'main')).toBe('same-branch');
    expect(await problem('missing', 'main')).toBe('source-missing');
    expect(await problem('feature', 'missing')).toBe('target-missing');
    expect(await problem('unrelated', 'main')).toBe('unrelated');
    expect(await problem('behind', 'main')).toBe('nothing-to-merge');
    expect(await problem('feature', 'main')).toBe('ok');
  });

  it('shows what the source adds since the merge base, not what the target gained meanwhile', async () => {
    const root = makeRepo();
    write(root, 'README.md', '# app\n\nMain moved on.\n');
    commit(root, 'Main moves on');
    const { repoId, pulls, open } = await setup(root);
    const pull = await open();
    expect(pull.number).toBe(1);
    expect(pull.latest?.version).toBe(1);
    const detail = await pulls.get({ repoId, id: pull.id });
    expect(detail.comparison!.commits.map((c) => c.subject)).toEqual([
      'Improve search',
    ]);
    expect(
      detail.comparison!.files.map((f) => [f.path, f.status]).sort(),
    ).toEqual([
      ['src/filters.ts', 'added'],
      ['src/search.ts', 'modified'],
    ]);
    const diff = await pulls.fileDiff({
      repoId,
      id: pull.id,
      path: 'src/search.ts',
      oldPath: null,
      base: detail.comparison!.mergeBaseOid,
      source: detail.comparison!.sourceOid,
      context: 3,
      ignoreWhitespace: false,
      full: false,
    });
    expect(diff.status).toBe('text');
    await expect(
      pulls.fileDiff({
        repoId,
        id: pull.id,
        path: 'README.md',
        oldPath: null,
        base: detail.comparison!.targetOid,
        source: detail.comparison!.sourceOid,
        context: 3,
        ignoreWhitespace: false,
        full: false,
      }),
    ).rejects.toThrow(/moved on/);
  });
});

describe('reviews and comments', () => {
  it('starts a new snapshot when the source moves, marks the approval stale and refuses a stale review', async () => {
    const root = makeRepo();
    const { repoId, pulls, open } = await setup(root);
    const pull = await open();
    await pulls.submitReview({
      repoId,
      id: pull.id,
      decision: 'approved',
      body: '',
      version: 1,
    });
    git(root, 'switch', '-q', 'feature');
    write(root, 'src/filters.ts', 'export const filters = ["a"];\n');
    commit(root, 'More filters');
    git(root, 'switch', '-q', 'main');

    const detail = await pulls.get({ repoId, id: pull.id });
    expect(detail.pull.latest!.version).toBe(2);
    expect(detail.pull.review).toEqual({
      decision: 'approved',
      version: 1,
      stale: true,
    });
    expect(detail.changedSinceReview).toBe(true);
    await expect(
      pulls.submitReview({
        repoId,
        id: pull.id,
        decision: 'approved',
        body: '',
        version: 1,
      }),
    ).rejects.toThrow(/moved/);
    const reviews = await pulls.reviews({ repoId, id: pull.id });
    expect(reviews[0]!.stale).toBe(true);
  });

  it('keeps the last snapshot when the target already has every source commit', async () => {
    const root = makeRepo();
    const { repoId, pulls, open } = await setup(root);
    const pull = await open();
    // Merged outside gitdesk, or by a merge here the record hasn't caught up with.
    git(root, 'merge', '-q', '--no-ff', '--no-edit', 'feature');

    const detail = await pulls.get({ repoId, id: pull.id });
    expect(detail.problem).toBe('nothing-to-merge');
    expect(detail.pull.latest!.version).toBe(1);
    expect(detail.comparison!.commits.length).toBeGreaterThan(0);
  });

  it('moves a line comment with its line and marks it outdated when the line changes', async () => {
    const root = makeRepo();
    const { repoId, pulls, open } = await setup(root);
    const pull = await open();
    const comment = await pulls.addComment({
      repoId,
      id: pull.id,
      body: 'Is normalize safe?',
      parentId: null,
      line: { path: 'src/search.ts', side: 'new', line: 3 },
    });
    expect(comment.position).toEqual({
      path: 'src/search.ts',
      side: 'new',
      line: 3,
    });
    await expect(
      pulls.addComment({
        repoId,
        id: pull.id,
        body: 'x',
        parentId: null,
        line: { path: 'src/search.ts', side: 'new', line: 99 },
      }),
    ).rejects.toThrow(/isn't in the latest/);

    // A line inserted above moves the commented line from 3 to 4.
    git(root, 'switch', '-q', 'feature');
    write(
      root,
      'src/search.ts',
      'export function search(q) {\n  // tidy\n  const a = 1;\n  return normalize(q);\n}\n',
    );
    commit(root, 'Comment');
    git(root, 'switch', '-q', 'main');
    await pulls.get({ repoId, id: pull.id });
    let [moved] = await pulls.comments({ repoId, id: pull.id });
    expect(moved).toMatchObject({ outdated: false, position: { line: 4 } });

    git(root, 'switch', '-q', 'feature');
    write(
      root,
      'src/search.ts',
      'export function search(q) {\n  // tidy\n  const a = 1;\n  return clean(q);\n}\n',
    );
    commit(root, 'Rename');
    git(root, 'switch', '-q', 'main');
    await pulls.get({ repoId, id: pull.id });
    [moved] = await pulls.comments({ repoId, id: pull.id });
    expect(moved).toMatchObject({
      outdated: true,
      position: null,
      body: 'Is normalize safe?',
    });
  });
});

describe('mergeability and merging', () => {
  it('checks without touching the work tree, then fast-forwards and records the merge', async () => {
    const root = makeRepo();
    const { repoId, pulls, open, store } = await setup(root);
    const pull = await open();
    const head = git(root, 'rev-parse', 'HEAD');
    const checked = await pulls.checkMergeability({ repoId, id: pull.id });
    expect(checked.latest).toMatchObject({
      mergeability: 'mergeable',
      conflicts: [],
    });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(head);
    expect(git(root, 'status', '--porcelain')).toBe('');

    const { latest } = checked;
    const result = await pulls.merge({
      repoId,
      id: pull.id,
      strategy: 'default',
      push: false,
      sourceOid: latest!.sourceOid,
      targetOid: latest!.targetOid,
      jobId: job(),
    });
    expect(result).toMatchObject({
      status: 'merged',
      push: 'skipped',
      recorded: true,
    });
    expect(git(root, 'rev-parse', 'main').trim()).toBe(latest!.sourceOid);
    const after = await pulls.get({ repoId, id: pull.id });
    expect(after.pull).toMatchObject({
      status: 'merged',
      mergeCommitOid: latest!.sourceOid,
    });
    expect(after.mergeOperation?.state).toBe('completed');
    expect(store.activity(10).map((a) => a.type)).toContain('pr-merged');
  });

  it('makes a merge commit when asked and refuses to merge anything newer than what was confirmed', async () => {
    const root = makeRepo();
    const { repoId, pulls, open } = await setup(root);
    const pull = await open();
    const latest = pull.latest!;
    write(root, 'README.md', '# app\nmoved\n');
    commit(root, 'Main moves');
    const changed = await pulls.merge({
      repoId,
      id: pull.id,
      strategy: 'no-ff',
      push: false,
      sourceOid: latest.sourceOid,
      targetOid: latest.targetOid,
      jobId: job(),
    });
    expect(changed).toMatchObject({ status: 'blocked', reason: 'changed' });
    const fresh = (await pulls.get({ repoId, id: pull.id })).pull.latest!;
    const merged = await pulls.merge({
      repoId,
      id: pull.id,
      strategy: 'no-ff',
      push: false,
      sourceOid: fresh.sourceOid,
      targetOid: fresh.targetOid,
      jobId: job(),
    });
    expect(merged.status).toBe('merged');
    expect(
      git(root, 'rev-list', '--parents', '-n', '1', 'main').trim().split(' '),
    ).toHaveLength(3);
    expect(git(root, 'log', '-1', '--format=%s', 'main').trim()).toBe(
      'Merge pull request #1: Improve search',
    );
  });

  it('never merges over uncommitted changes', async () => {
    const root = makeRepo();
    const { repoId, pulls, open } = await setup(root);
    const pull = await open();
    write(root, 'README.md', 'edited\n');
    const result = await pulls.merge({
      repoId,
      id: pull.id,
      strategy: 'default',
      push: false,
      sourceOid: pull.latest!.sourceOid,
      targetOid: pull.latest!.targetOid,
      jobId: job(),
    });
    expect(result).toMatchObject({
      status: 'blocked',
      reason: 'local-changes',
      files: ['README.md'],
    });
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('edited\n');
  });

  it('stops on conflicts, resolves them file by file, and continues to a merge', async () => {
    const root = makeRepo();
    write(
      root,
      'src/search.ts',
      'export function search(q) {\n  const a = 1;\n  return q.toLowerCase();\n}\n',
    );
    commit(root, 'Main edits the same line');
    const { repoId, pulls, open } = await setup(root);
    const pull = await open();
    const checked = await pulls.checkMergeability({ repoId, id: pull.id });
    expect(checked.latest).toMatchObject({
      mergeability: 'conflicts',
      conflicts: ['src/search.ts'],
    });

    const result = await pulls.merge({
      repoId,
      id: pull.id,
      strategy: 'default',
      push: false,
      sourceOid: checked.latest!.sourceOid,
      targetOid: checked.latest!.targetOid,
      jobId: job(),
    });
    expect(result).toMatchObject({
      status: 'conflicts',
      files: [{ path: 'src/search.ts', kind: 'both-modified' }],
    });
    const state = await pulls.conflicts(repoId);
    expect(state).toMatchObject({ operation: 'merge', pullId: pull.id });
    const sides = await pulls.conflictSides({ repoId, path: 'src/search.ts' });
    expect(sides.target).toContain('toLowerCase');
    expect(sides.source).toContain('normalize');
    expect(sides.markers).toBe(3);
    await expect(
      pulls.resolveConflict({ repoId, path: 'src/search.ts', take: 'working' }),
    ).rejects.toThrow(/markers/);
    await expect(pulls.continueMerge(repoId)).rejects.toThrow(
      /still in conflict/,
    );

    const resolved = await pulls.resolveConflict({
      repoId,
      path: 'src/search.ts',
      take: 'source',
    });
    expect(resolved).toMatchObject({ files: [], resolved: ['src/search.ts'] });
    const finished = await pulls.continueMerge(repoId);
    expect(finished.status).toBe('merged');
    expect(readFileSync(path.join(root, 'src/search.ts'), 'utf8')).toContain(
      'normalize',
    );
    expect((await pulls.get({ repoId, id: pull.id })).pull.status).toBe(
      'merged',
    );
  });

  it('aborts a conflicted merge back to the branch it started on', async () => {
    const root = makeRepo();
    write(root, 'src/search.ts', 'conflict\n');
    commit(root, 'Main rewrites search');
    git(root, 'switch', '-q', '-c', 'elsewhere');
    const { repoId, pulls, open } = await setup(root);
    const pull = await open();
    const before = git(root, 'rev-parse', 'main');
    const result = await pulls.merge({
      repoId,
      id: pull.id,
      strategy: 'default',
      push: false,
      sourceOid: pull.latest!.sourceOid,
      targetOid: pull.latest!.targetOid,
      jobId: job(),
    });
    expect(result.status).toBe('conflicts');
    expect(git(root, 'branch', '--show-current').trim()).toBe('main');
    const state = await pulls.abortMerge(repoId);
    expect(state).toMatchObject({ operation: null, files: [] });
    expect(git(root, 'rev-parse', 'main')).toBe(before);
    expect(git(root, 'branch', '--show-current').trim()).toBe('elsewhere');
    expect((await pulls.get({ repoId, id: pull.id })).pull.status).toBe('open');
  });

  it('resolves a delete/modify conflict by taking the side that deleted the file', async () => {
    const root = makeRepo();
    git(root, 'rm', '-q', 'src/search.ts');
    commit(root, 'Main deletes search');
    const { repoId, pulls, open } = await setup(root);
    const pull = await open();
    const result = await pulls.merge({
      repoId,
      id: pull.id,
      strategy: 'default',
      push: false,
      sourceOid: pull.latest!.sourceOid,
      targetOid: pull.latest!.targetOid,
      jobId: job(),
    });
    expect(result).toMatchObject({
      status: 'conflicts',
      files: [{ path: 'src/search.ts', kind: 'deleted-by-target' }],
    });
    await pulls.resolveConflict({
      repoId,
      path: 'src/search.ts',
      take: 'target',
    });
    expect((await pulls.continueMerge(repoId)).status).toBe('merged');
    expect(existsSync(path.join(root, 'src/search.ts'))).toBe(false);
  });

  it('keeps a merge done here and reports it to the account again later, with the same operation', async () => {
    const root = makeRepo();
    let offline = true;
    const recordMerge = vi.fn();
    const { repoId, pulls, open } = await setup(root, (records) => ({
      ...records,
      recordMerge: async (...args) => {
        recordMerge(args[1].operationId);
        if (offline) throw new Error('offline');
        return records.recordMerge(...args);
      },
    }));
    const pull = await open();
    const result = await pulls.merge({
      repoId,
      id: pull.id,
      strategy: 'default',
      push: false,
      sourceOid: pull.latest!.sourceOid,
      targetOid: pull.latest!.targetOid,
      jobId: job(),
    });
    expect(result).toMatchObject({
      status: 'merged',
      recorded: false,
      operation: { state: 'report_pending' },
    });
    expect(git(root, 'rev-parse', 'main').trim()).toBe(pull.latest!.sourceOid);
    expect((await pulls.get({ repoId, id: pull.id })).pull.status).toBe('open');

    offline = false;
    const detail = await pulls.get({ repoId, id: pull.id });
    expect(detail.pull.status).toBe('merged');
    expect(detail.mergeOperation?.state).toBe('completed');
    expect(new Set(recordMerge.mock.calls.map((call) => call[0])).size).toBe(1);
  });
});

describe('after merging', () => {
  it('reverts a merge commit onto a new branch and leaves the pull request merged', async () => {
    const root = makeRepo();
    const { repoId, pulls, open } = await setup(root);
    const pull = await open();
    await pulls.merge({
      repoId,
      id: pull.id,
      strategy: 'no-ff',
      push: false,
      sourceOid: pull.latest!.sourceOid,
      targetOid: pull.latest!.targetOid,
      jobId: job(),
    });
    const info = await pulls.revertInfo({ repoId, id: pull.id });
    expect(info.isMerge).toBe(true);
    expect(info.parents.map((p) => p.subject)).toEqual([
      'Initial',
      'Improve search',
    ]);
    expect(
      await pulls.revert({
        repoId,
        id: pull.id,
        mainline: null,
        branch: 'revert-pr-1',
      }),
    ).toMatchObject({
      status: 'blocked',
      reason: 'mainline',
    });
    const reverted = await pulls.revert({
      repoId,
      id: pull.id,
      mainline: 1,
      branch: 'revert-pr-1',
    });
    expect(reverted).toMatchObject({
      status: 'reverted',
      branch: 'revert-pr-1',
    });
    expect(
      git(root, 'diff', '--stat', pull.latest!.targetOid, 'revert-pr-1'),
    ).toBe('');
    expect((await pulls.get({ repoId, id: pull.id })).pull.status).toBe(
      'merged',
    );
  });

  it('reverts a fast-forward merge as one commit, and deletes the merged branch safely', async () => {
    const root = makeRepo();
    const { repoId, pulls, open } = await setup(root);
    const pull = await open();
    await pulls.merge({
      repoId,
      id: pull.id,
      strategy: 'default',
      push: false,
      sourceOid: pull.latest!.sourceOid,
      targetOid: pull.latest!.targetOid,
      jobId: job(),
    });
    const reverted = await pulls.revert({
      repoId,
      id: pull.id,
      mainline: null,
      branch: null,
    });
    expect(reverted.status).toBe('reverted');
    expect(git(root, 'log', '-1', '--format=%s').trim()).toBe(
      'Revert pull request #1: Improve search',
    );
    expect(git(root, 'diff', '--stat', pull.latest!.targetOid, 'HEAD')).toBe(
      '',
    );
    expect(await pulls.deleteBranch({ repoId, id: pull.id })).toEqual({
      deleted: true,
      message: null,
    });
    expect(git(root, 'branch', '--list', 'feature')).toBe('');
  });

  it('closes and reopens, but never reopens a merged one or one whose branch is gone', async () => {
    const root = makeRepo();
    const { repoId, pulls, open } = await setup(root);
    const pull = await open();
    expect(
      (await pulls.setStatus({ repoId, id: pull.id, status: 'closed' })).status,
    ).toBe('closed');
    git(root, 'branch', '-D', 'feature');
    await expect(
      pulls.setStatus({ repoId, id: pull.id, status: 'open' }),
    ).rejects.toThrow(/no longer exists/);
    const list = await pulls.list({
      repoId,
      status: 'closed',
      q: '',
      cursor: null,
    });
    expect(list.counts).toEqual({ open: 0, merged: 0, closed: 1 });
    expect(list.pulls.map((p) => p.number)).toEqual([1]);
  });
});

describe('parsers', () => {
  it('reads merge-tree output, counting a conflict only Git names in its messages', () => {
    const tree = 'a'.repeat(40);
    expect(parseMergeTree(`${tree}\0\0`)).toEqual({
      conflicts: [],
      conflicted: false,
    });
    expect(
      parseMergeTree(
        `${tree}\0src/a.ts\0\x001\0src/a.ts\0CONFLICT (contents)\0Merge conflict in src/a.ts\0`,
      ),
    ).toEqual({
      conflicts: ['src/a.ts'],
      conflicted: true,
    });
    expect(
      parseMergeTree(
        `${tree}\0\x002\0a\0b\0CONFLICT (directory rename suggested)\0msg\0`,
      ).conflicted,
    ).toBe(true);
    expect(
      parseMergeTree(`${tree}\0\x001\0a.ts\0Auto-merging\0Auto-merging a.ts\0`)
        .conflicted,
    ).toBe(false);
  });

  it('reads name-status and numstat records, renames included', () => {
    expect(
      parseNameStatus('M\0a.ts\0R087\0old.ts\0new.ts\0A\0b.png\0'),
    ).toEqual([
      { status: 'modified', oldPath: null, path: 'a.ts' },
      { status: 'renamed', oldPath: 'old.ts', path: 'new.ts' },
      { status: 'added', oldPath: null, path: 'b.png' },
    ]);
    const counts = parseNumstatFiles(
      '3\t1\ta.ts\x001\t1\t\0old.ts\0new.ts\0-\t-\tb.png\0',
    );
    expect(counts.get('a.ts')).toEqual({ added: 3, removed: 1, binary: false });
    expect(counts.get('new.ts')).toEqual({
      added: 1,
      removed: 1,
      binary: false,
    });
    expect(counts.get('b.png')).toEqual({
      added: null,
      removed: null,
      binary: true,
    });
  });
});
