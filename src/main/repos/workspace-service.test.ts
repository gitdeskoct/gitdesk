import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
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
import { UserError } from '../errors';
import { gitAuthEnv } from './git-inspector';
import { createRepositoryService, type Hosting } from './repository-service';
import { createRepositoryStore } from './repository-store';
import {
  classifyFetchError,
  createWorkspaceService,
  parseBlockedFiles,
  redactRemoteUrl,
  sanitizeOutput,
} from './workspace-service';

// Real Git, real folders: the same commands the app runs, against temporary repositories.
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
const trashItem = vi.fn(async (target: string) =>
  rmSync(target, { force: true }),
);

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gitdesk-ws-'));
  settings = { ...DEFAULT_SETTINGS, watchRepositories: false };
  trashItem.mockClear();
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  rmSync(dir, { recursive: true, force: true });
});

function makeRepo(name = 'app'): string {
  const root = path.join(dir, name);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  writeFileSync(path.join(root, 'README.md'), '# hi\n');
  writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 1;\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'Initial');
  return root;
}

async function setup(
  root: string,
  extra: {
    hosting?: Hosting;
    gitAuth?: Parameters<typeof createWorkspaceService>[0]['gitAuth'];
    db?: string;
  } = {},
) {
  const db = openDatabase(path.join(dir, extra.db ?? 'test.db'));
  cleanups.push(() => db.close());
  const store = createRepositoryStore(db);
  const copyText = vi.fn();
  const repos = createRepositoryService({
    store,
    remote: { create: vi.fn(), update: vi.fn() },
    settings: () => settings,
    emit: vi.fn(),
    hosting: extra.hosting,
    desktop: {
      pickDirectory: async () => root,
      openPath: async () => '',
      copyText,
      trashItem: vi.fn(),
      protectedPaths: () => [],
    },
  });
  cleanups.push(() => repos.dispose());
  const added = await repos.add();
  if (added.status !== 'added') throw new Error('not added');
  const id = added.repository.id;
  const desktop = {
    trashItem,
    showItemInFolder: vi.fn(),
    openPath: vi.fn(async () => ''),
    copyText: vi.fn(),
    isOnline: () => true,
  };
  const service = createWorkspaceService({
    store,
    gitAuth: extra.gitAuth,
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
    desktop,
    discardDir: path.join(dir, 'discarded'),
  });
  cleanups.push(() => service.dispose());
  return { id, service, repos, store, desktop, copyText };
}

const changes = async (
  repos: Awaited<ReturnType<typeof setup>>['repos'],
  id: string,
) =>
  (await repos.changes(id)).files
    .map((f) => `${f.kind}:${f.code}:${f.path}`)
    .sort();

describe('workspace changes and diffs', () => {
  it('shows unstaged, staged and untracked diffs with line numbers', async () => {
    const root = makeRepo();
    writeFileSync(
      path.join(root, 'src', 'a.ts'),
      'export const a = 2;\nexport const b = 3;\n',
    );
    writeFileSync(path.join(root, 'new file.txt'), 'one\ntwo\n');
    const { id, service } = await setup(root);

    const unstaged = await service.diff({
      id,
      path: 'src/a.ts',
      side: 'unstaged',
      context: 3,
      ignoreWhitespace: false,
      full: false,
    });
    expect(unstaged.status).toBe('text');
    if (unstaged.status !== 'text') return;
    expect(unstaged.added).toBe(2);
    expect(unstaged.removed).toBe(1);
    expect(
      unstaged.hunks[0]!.lines.map((l) => `${l.kind}:${l.old}:${l.new}`),
    ).toEqual(['del:1:null', 'add:null:1', 'add:null:2']);

    const untracked = await service.diff({
      id,
      path: 'new file.txt',
      side: 'untracked',
      context: 3,
      ignoreWhitespace: false,
      full: false,
    });
    expect(untracked.status === 'text' && untracked.added).toBe(2);
  });

  it('stages and unstages only the named files, including names with spaces and a leading dash', async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, '-dash.txt'), 'x\n');
    writeFileSync(path.join(root, 'with space.txt'), 'y\n');
    // A file literally named [ab].txt; as a glob it would also match a.txt.
    writeFileSync(path.join(root, '[ab].txt'), 'glob\n');
    writeFileSync(path.join(root, 'a.txt'), 'a\n');
    const { id, service, repos } = await setup(root);

    await service.stage({ id, paths: ['-dash.txt', '[ab].txt'] });
    expect(await changes(repos, id)).toEqual([
      'staged:A:-dash.txt',
      'staged:A:[ab].txt',
      'untracked:?:a.txt',
      'untracked:?:with space.txt',
    ]);
    await service.unstage({ id, paths: ['[ab].txt'] });
    expect(await changes(repos, id)).toContain('untracked:?:[ab].txt');
    expect(await changes(repos, id)).toContain('staged:A:-dash.txt');
  });

  it('refuses paths that Git does not report, or that leave the repository', async () => {
    const root = makeRepo();
    writeFileSync(path.join(dir, 'outside.txt'), 'secret\n');
    const { id, service, repos } = await setup(root);
    // A stale list is an answer the page shows as a band, not an error.
    expect(await service.stage({ id, paths: ['README.md'] })).toEqual({
      status: 'stale',
    });
    // A stale request also refreshes the list; let it finish before the folder is removed.
    await repos.refresh(id);
    await expect(
      service.diff({
        id,
        path: '../outside.txt',
        side: 'untracked',
        context: 3,
        ignoreWhitespace: false,
        full: false,
      }),
    ).rejects.toThrow();
  });

  it('never stages an ignored file with Stage all', async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, '.gitignore'), 'secret.env\n');
    writeFileSync(path.join(root, 'secret.env'), 'KEY=1\n');
    writeFileSync(path.join(root, 'kept.txt'), 'k\n');
    const { id, service, repos } = await setup(root);
    await service.stageAll(id);
    const list = await changes(repos, id);
    expect(list).toContain('staged:A:kept.txt');
    expect(list.join()).not.toContain('secret.env');
  });

  it('reports binary files and guards large diffs until asked', async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'blob.bin'), Buffer.from([0, 1, 2, 0, 3]));
    writeFileSync(
      path.join(root, 'big.txt'),
      Array.from({ length: 6000 }, (_, i) => `line ${i}`).join('\n'),
    );
    const { id, service } = await setup(root);
    await service.stage({ id, paths: ['blob.bin', 'big.txt'] });
    const base = {
      id,
      side: 'staged' as const,
      context: 3,
      ignoreWhitespace: false,
    };
    expect(
      (await service.diff({ ...base, path: 'blob.bin', full: false })).status,
    ).toBe('binary');
    expect(
      (await service.diff({ ...base, path: 'big.txt', full: false })).status,
    ).toBe('too-large');
    expect(
      (await service.diff({ ...base, path: 'big.txt', full: true })).status,
    ).toBe('text');
  });

  it('shows a staged rename with its old path and unstages both sides', async () => {
    const root = makeRepo();
    git(root, 'mv', 'src/a.ts', 'src/b.ts');
    const { id, service, repos } = await setup(root);
    const result = await service.diff({
      id,
      path: 'src/b.ts',
      side: 'staged',
      context: 3,
      ignoreWhitespace: false,
      full: false,
    });
    expect(result.status === 'empty' || result.status === 'text').toBe(true);
    await service.unstage({ id, paths: ['src/b.ts'] });
    const list = await changes(repos, id);
    expect(list).toContain('modified:D:src/a.ts');
    expect(list).toContain('untracked:?:src/b.ts');
  });

  it('discards unstaged edits and moves untracked files to the trash', async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'README.md'), 'changed\n');
    writeFileSync(path.join(root, 'scratch.txt'), 'tmp\n');
    const { id, service } = await setup(root);
    await service.discard({ id, paths: ['README.md', 'scratch.txt'] });
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('# hi\n');
    expect(trashItem).toHaveBeenCalledWith(path.join(root, 'scratch.txt'));
    expect(existsSync(path.join(root, 'scratch.txt'))).toBe(false);
  });
});

describe('staging parts of a file', () => {
  const lines = (n: number, change: (i: number) => string = String) =>
    Array.from({ length: n }, (_, i) => change(i)).join('\n') + '\n';
  const read = (
    service: Awaited<ReturnType<typeof setup>>['service'],
    id: string,
    file: string,
    side: 'unstaged' | 'staged' | 'untracked',
  ) =>
    service.diff({
      id,
      path: file,
      side,
      context: 3,
      ignoreWhitespace: false,
      full: false,
    });

  it('stages, unstages and discards chosen lines through git apply', async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'list.txt'), lines(12));
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'list');
    // Two separate hunks: lines 1 and 10 change.
    writeFileSync(
      path.join(root, 'list.txt'),
      lines(12, (i) => (i === 1 ? 'one!' : i === 10 ? 'ten!' : String(i))),
    );
    const { id, service } = await setup(root);
    const diff = await read(service, id, 'list.txt', 'unstaged');
    if (diff.status !== 'text') throw new Error(diff.status);
    expect(diff.hunks).toHaveLength(2);
    expect(diff.token).toMatch(/^[0-9a-f]{40}$/);

    // Only the second hunk's added line: its removal stays as context.
    const added = diff.hunks[1]!.lines.findIndex((l) => l.kind === 'add');
    expect(
      await service.applySelection({
        id,
        path: 'list.txt',
        side: 'unstaged',
        action: 'stage',
        token: diff.token!,
        context: 3,
        hunks: [{ index: 1, lines: [added] }],
      }),
    ).toEqual({ status: 'applied', saved: false });
    expect(git(root, 'show', ':list.txt')).toBe(
      lines(12, (i) => (i === 10 ? '10\nten!' : String(i))),
    );

    const staged = await read(service, id, 'list.txt', 'staged');
    if (staged.status !== 'text') throw new Error(staged.status);
    expect(
      await service.applySelection({
        id,
        path: 'list.txt',
        side: 'staged',
        action: 'unstage',
        token: staged.token!,
        context: 3,
        hunks: [{ index: 0 }],
      }),
    ).toMatchObject({ status: 'applied' });
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('');

    // Discard the first hunk from the working tree; a copy is kept first.
    const again = await read(service, id, 'list.txt', 'unstaged');
    if (again.status !== 'text') throw new Error(again.status);
    expect(
      await service.applySelection({
        id,
        path: 'list.txt',
        side: 'unstaged',
        action: 'discard',
        token: again.token!,
        context: 3,
        hunks: [{ index: 0 }],
      }),
    ).toEqual({ status: 'applied', saved: true });
    expect(readFileSync(path.join(root, 'list.txt'), 'utf8')).toBe(
      lines(12, (i) => (i === 10 ? 'ten!' : String(i))),
    );
    const kept = path.join(dir, 'discarded', 'app');
    expect(
      readFileSync(path.join(kept, readdirSync(kept)[0]!), 'utf8'),
    ).toContain('+one!');
  });

  it('refuses a stale selection and a held index lock, changing nothing', async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'README.md'), '# hi\nmore\n');
    const { id, service } = await setup(root);
    const diff = await read(service, id, 'README.md', 'unstaged');
    if (diff.status !== 'text') throw new Error(diff.status);
    const input = {
      id,
      path: 'README.md',
      side: 'unstaged' as const,
      action: 'stage' as const,
      token: diff.token!,
      context: 3,
      hunks: [{ index: 0 }],
    };
    writeFileSync(path.join(root, 'README.md'), '# hi\nmore\nand more\n');
    expect(await service.applySelection(input)).toEqual({ status: 'stale' });

    writeFileSync(path.join(root, '.git', 'index.lock'), '');
    expect(await service.applySelection(input)).toMatchObject({
      status: 'rejected',
      reason: 'busy',
    });
    expect(await service.stage({ id, paths: ['README.md'] })).toMatchObject({
      status: 'rejected',
      reason: 'busy',
      message: expect.stringMatching(/Another Git process/),
    });
    expect(existsSync(path.join(root, '.git', 'index.lock'))).toBe(true);
    rmSync(path.join(root, '.git', 'index.lock'));
    expect(git(root, 'diff', '--cached', '--name-only').trim()).toBe('');
  });

  it('stages part of an untracked file with spaces and accents in its name', async () => {
    const root = makeRepo();
    const name = 'notes café.txt';
    writeFileSync(path.join(root, name), 'keep\nskip\n');
    const { id, service } = await setup(root);
    const diff = await read(service, id, name, 'untracked');
    if (diff.status !== 'text') throw new Error(diff.status);
    expect(
      await service.applySelection({
        id,
        path: name,
        side: 'untracked',
        action: 'stage',
        token: diff.token!,
        context: 3,
        hunks: [{ index: 0, lines: [0] }],
      }),
    ).toMatchObject({ status: 'applied' });
    expect(git(root, 'show', `:${name}`)).toBe('keep\n');
  });

  it('lists binary files with their size on each side instead of line counts', async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'logo.bin'), Buffer.from([0, 1, 2, 3]));
    git(root, 'add', 'logo.bin');
    git(root, 'commit', '-q', '-m', 'logo');
    writeFileSync(path.join(root, 'logo.bin'), Buffer.alloc(10, 0));
    git(root, 'add', 'logo.bin');
    writeFileSync(path.join(root, 'logo.bin'), Buffer.alloc(24, 0));
    const { id, repos } = await setup(root);
    const { files, total } = await repos.changes(id);
    expect(total).toBe(1);
    expect(files).toEqual([
      expect.objectContaining({ kind: 'staged', binary: true, size: 10 }),
      expect.objectContaining({ kind: 'modified', binary: true, size: 24 }),
    ]);
  });

  it('stages part of an untracked CRLF file the way git add would store it', async () => {
    const root = makeRepo();
    git(root, 'config', 'core.autocrlf', 'true');
    writeFileSync(path.join(root, 'crlf.txt'), 'keep\r\nskip\r\n');
    const { id, service } = await setup(root);
    const diff = await read(service, id, 'crlf.txt', 'untracked');
    if (diff.status !== 'text') throw new Error(diff.status);
    expect(
      await service.applySelection({
        id,
        path: 'crlf.txt',
        side: 'untracked',
        action: 'stage',
        token: diff.token!,
        context: 3,
        hunks: [{ index: 0, lines: [0] }],
      }),
    ).toMatchObject({ status: 'applied' });
    // autocrlf=true stores LF, as `git add` would; the raw bytes would have kept the CR.
    expect(git(root, 'cat-file', 'blob', ':crlf.txt')).toBe('keep\n');
  });

  it('refuses to stage part of a file a clean filter rewrites', async () => {
    const root = makeRepo();
    git(root, 'config', 'filter.upper.clean', 'tr a-z A-Z');
    writeFileSync(path.join(root, '.gitattributes'), '*.up filter=upper\n');
    writeFileSync(path.join(root, 'x.up'), 'one\ntwo\n');
    const { id, service } = await setup(root);
    const diff = await read(service, id, 'x.up', 'untracked');
    if (diff.status !== 'text') throw new Error(diff.status);
    expect(
      await service.applySelection({
        id,
        path: 'x.up',
        side: 'untracked',
        action: 'stage',
        token: diff.token!,
        context: 3,
        hunks: [{ index: 0, lines: [0] }],
      }),
    ).toMatchObject({ status: 'rejected', reason: 'unsupported' });
    expect(git(root, 'ls-files', '--stage', 'x.up')).toBe('');
  });

  it('reads context lines from the index for staged and the disk for unstaged', async () => {
    const root = makeRepo();
    const lines = Array.from({ length: 40 }, (_, i) => `line ${i + 1}`);
    writeFileSync(path.join(root, 'long.txt'), lines.join('\n') + '\n');
    git(root, 'add', 'long.txt');
    git(root, 'commit', '-q', '-m', 'long');
    writeFileSync(
      path.join(root, 'long.txt'),
      lines.map((l, i) => (i === 0 ? 'staged first' : l)).join('\n') + '\n',
    );
    git(root, 'add', 'long.txt');
    writeFileSync(
      path.join(root, 'long.txt'),
      lines.map((l, i) => (i === 0 ? 'disk first' : l)).join('\r\n') + '\r\n',
    );
    const { id, service } = await setup(root);
    const staged = await service.contextLines({
      id,
      path: 'long.txt',
      side: 'staged',
      start: 1,
      count: 2,
    });
    expect(staged).toEqual({
      start: 1,
      total: 40,
      lines: ['staged first', 'line 2'],
    });
    const disk = await service.contextLines({
      id,
      path: 'long.txt',
      side: 'unstaged',
      start: 39,
      count: 20,
    });
    expect(disk).toEqual({
      start: 39,
      total: 40,
      lines: ['line 39', 'line 40'],
    });
    await expect(
      service.contextLines({
        id,
        path: 'README.md',
        side: 'unstaged',
        start: 1,
        count: 1,
      }),
    ).rejects.toThrow(/moved on/);
  });

  it('copies an untracked file as a new-file patch Git can apply', async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'new café.txt'), 'hello\n');
    const { id, service, desktop } = await setup(root);
    await service.copyPatch({ id, path: 'new café.txt', side: 'untracked' });
    const patch = desktop.copyText.mock.calls[0]![0] as string;
    expect(patch).toContain('new file mode 100644');
    expect(patch).toContain('+hello');
    rmSync(path.join(root, 'new café.txt'));
    execFileSync('git', ['apply', '-'], { cwd: root, input: patch });
    expect(readFileSync(path.join(root, 'new café.txt'), 'utf8')).toBe(
      'hello\n',
    );
  });

  it('discards staged and working changes back to HEAD, keeping a copy', async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'README.md'), 'staged\n');
    git(root, 'add', 'README.md');
    writeFileSync(path.join(root, 'README.md'), 'staged and more\n');
    const { id, service } = await setup(root);
    expect(await service.discardAll({ id, paths: ['README.md'] })).toEqual({
      status: 'applied',
      saved: true,
    });
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toBe('# hi\n');
    expect(git(root, 'status', '--porcelain').trim()).toBe('');
  });

  it('reports binary sizes on both sides', async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'b.bin'), Buffer.from([0, 1, 2, 3]));
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'bin');
    writeFileSync(path.join(root, 'b.bin'), Buffer.from([0, 1, 2, 3, 4, 5]));
    const { id, service } = await setup(root);
    expect(await read(service, id, 'b.bin', 'unstaged')).toMatchObject({
      status: 'binary',
      oldSize: 4,
      newSize: 6,
    });
  });
});

describe('committing', () => {
  it('commits staged work locally and refuses when nothing is staged', async () => {
    const root = makeRepo();
    const { id, service } = await setup(root);
    expect(
      await service.commit({ id, summary: 'Nothing', description: '' }),
    ).toEqual({
      status: 'rejected',
      reason: 'nothing-staged',
      output: null,
    });
    writeFileSync(path.join(root, 'README.md'), 'v2\n');
    await service.stage({ id, paths: ['README.md'] });
    const result = await service.commit({
      id,
      summary: 'Update readme',
      description: 'Body',
    });
    expect(result.status).toBe('committed');
    expect(git(root, 'log', '-1', '--format=%B').trim()).toBe(
      'Update readme\n\nBody',
    );
  });

  it('makes the first commit on an unborn branch, after unstaging and restaging', async () => {
    const root = path.join(dir, 'fresh');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(root, 'a.txt'), 'a\n');
    const { id, service } = await setup(root);
    await service.stage({ id, paths: ['a.txt'] });
    await service.unstage({ id, paths: ['a.txt'] });
    await service.stage({ id, paths: ['a.txt'] });
    expect(
      (await service.commit({ id, summary: 'First', description: '' })).status,
    ).toBe('committed');
  });

  it('reports a failing pre-commit hook with its output and commits nothing', async () => {
    const root = makeRepo();
    const hook = path.join(root, '.git', 'hooks', 'pre-commit');
    writeFileSync(
      hook,
      '#!/bin/sh\necho "lint failed: 2 problems" >&2\nexit 1\n',
      { mode: 0o755 },
    );
    writeFileSync(path.join(root, 'README.md'), 'v2\n');
    const { id, service } = await setup(root);
    await service.stage({ id, paths: ['README.md'] });
    const before = git(root, 'rev-parse', 'HEAD');
    const result = await service.commit({
      id,
      summary: 'Blocked',
      description: '',
    });
    expect(result).toMatchObject({ status: 'rejected', reason: 'hook' });
    expect(result.status === 'rejected' && result.output).toContain(
      'lint failed',
    );
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('treats a hook that fails without a word as a refused commit', async () => {
    const root = makeRepo();
    writeFileSync(
      path.join(root, '.git', 'hooks', 'pre-commit'),
      '#!/bin/sh\nexit 1\n',
      { mode: 0o755 },
    );
    writeFileSync(path.join(root, 'README.md'), 'v2\n');
    const { id, service } = await setup(root);
    await service.stage({ id, paths: ['README.md'] });
    const before = git(root, 'rev-parse', 'HEAD');
    expect(
      await service.commit({ id, summary: 'Quiet', description: '' }),
    ).toMatchObject({ status: 'rejected', reason: 'hook' });
    expect(git(root, 'rev-parse', 'HEAD')).toBe(before);
  });

  it('reads the identity Git will commit with and where it was set', async () => {
    const root = makeRepo();
    git(root, 'config', 'user.name', 'Repo Person');
    git(root, 'config', 'user.email', 'repo@example.com');
    const { id, service } = await setup(root);
    const name = process.env.GIT_AUTHOR_NAME;
    const email = process.env.GIT_AUTHOR_EMAIL;
    delete process.env.GIT_AUTHOR_NAME;
    delete process.env.GIT_AUTHOR_EMAIL;
    try {
      expect(await service.commitIdentity(id)).toEqual({
        name: 'Repo Person',
        email: 'repo@example.com',
        scope: 'local',
      });
    } finally {
      process.env.GIT_AUTHOR_NAME = name;
      process.env.GIT_AUTHOR_EMAIL = email;
    }
  });
});

describe('branches', () => {
  it('lists, creates and switches branches, and never forces past local changes', async () => {
    const root = makeRepo();
    git(root, 'switch', '-q', '-c', 'feature');
    writeFileSync(path.join(root, 'README.md'), 'feature\n');
    git(root, 'commit', '-q', '-am', 'Feature');
    git(root, 'switch', '-q', 'main');
    writeFileSync(path.join(root, 'README.md'), 'my edit\n');
    const { id, service } = await setup(root);

    const list = await service.branches(id);
    expect(list.current).toBe('main');
    expect(list.local.map((b) => b.name).sort()).toEqual(['feature', 'main']);

    const blocked = await service.switchBranch({
      id,
      name: 'feature',
      kind: 'local',
    });
    expect(blocked).toEqual({
      status: 'blocked',
      reason: 'local-changes',
      files: ['README.md'],
    });
    expect(readFileSync(path.join(root, 'README.md'), 'utf8')).toBe(
      'my edit\n',
    );

    const created = await service.createBranch({ id, name: 'topic/one' });
    expect(created).toEqual({ status: 'switched', branch: 'topic/one' });
    expect((await service.createBranch({ id, name: 'topic/one' })).status).toBe(
      'blocked',
    );
  });

  it('refuses a branch checked out in another worktree', async () => {
    const root = makeRepo();
    git(root, 'branch', 'side');
    git(root, 'worktree', 'add', '-q', path.join(dir, 'side-wt'), 'side');
    const { id, service } = await setup(root);
    const list = await service.branches(id);
    expect(list.local.find((b) => b.name === 'side')?.otherWorktree).toBe(true);
    expect(
      await service.switchBranch({ id, name: 'side', kind: 'local' }),
    ).toEqual({
      status: 'blocked',
      reason: 'other-worktree',
    });
  });
});

describe('remotes and fetch', () => {
  it('fetches from a configured remote and hides credentials in URLs', async () => {
    const origin = makeRepo('origin');
    const root = path.join(dir, 'clone');
    git(dir, 'clone', '-q', origin, root);
    git(
      root,
      'remote',
      'add',
      'secret',
      'https://user:token@example.com/r.git?x=1',
    );
    writeFileSync(path.join(origin, 'README.md'), 'upstream\n');
    git(origin, 'commit', '-q', '-am', 'Upstream change');
    const { id, service } = await setup(root);

    const remotes = await service.remotes(id);
    const secret = remotes.find((r) => r.name === 'secret')!;
    expect(secret.fetchUrl).toBe('https://example.com/r.git');
    expect(secret.hadCredentials).toBe(true);
    expect(JSON.stringify(remotes)).not.toContain('token');

    const result = await service.fetch({
      id,
      remote: 'origin',
      jobId: crypto.randomUUID(),
    });
    expect(result.status).toBe('fetched');
    expect(git(root, 'rev-list', '--count', 'main..origin/main').trim()).toBe(
      '1',
    );
    // Fetch never merges: the working file is unchanged.
    // The clone may have CRLF line endings from the machine's core.autocrlf.
    expect(
      readFileSync(path.join(root, 'README.md'), 'utf8').replace(/\r/g, ''),
    ).toBe('# hi\n');
    await expect(
      service.fetch({ id, remote: 'missing', jobId: crypto.randomUUID() }),
    ).rejects.toThrow(/isn't configured/);
  });
});

describe('push', () => {
  const bareRemote = (name = 'remote.git') => {
    const bare = path.join(dir, name);
    git(dir, 'init', '-q', '--bare', '-b', 'main', bare);
    return bare;
  };
  const job = () => crypto.randomUUID();

  it('pushes the current branch, sets its upstream once, and is refused rather than forced', async () => {
    const bare = bareRemote();
    const root = makeRepo();
    git(root, 'remote', 'add', 'origin', bare);
    const { id, service, store } = await setup(root);

    const first = await service.push({ id, jobId: job() });
    expect(first).toMatchObject({
      status: 'pushed',
      remote: 'origin',
      branch: 'main',
    });
    expect(git(root, 'rev-parse', '--abbrev-ref', 'main@{u}').trim()).toBe(
      'origin/main',
    );
    expect(git(bare, 'rev-parse', 'main')).toBe(git(root, 'rev-parse', 'HEAD'));
    expect(
      store.activity(10).map((entry) => [entry.type, entry.detail]),
    ).toContainEqual(['pushed', 'origin/main']);

    // Someone else moves the remote branch; this push must not overwrite their commit.
    const other = path.join(dir, 'other');
    git(dir, 'clone', '-q', bare, other);
    writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n');
    git(other, 'add', '.');
    git(other, 'commit', '-q', '-m', 'Theirs');
    git(other, 'push', '-q', 'origin', 'main');
    const theirs = git(bare, 'rev-parse', 'main');
    writeFileSync(path.join(root, 'mine.txt'), 'mine\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'Mine');

    const refused = await service.push({ id, jobId: job() });
    expect(refused).toMatchObject({ status: 'failed', reason: 'rejected' });
    expect(git(bare, 'rev-parse', 'main')).toBe(theirs);
  });

  it('says why when there is no remote or no branch', async () => {
    const root = makeRepo();
    const { id, service } = await setup(root);
    expect(await service.push({ id, jobId: job() })).toMatchObject({
      status: 'failed',
      reason: 'no-remote',
    });
    git(root, 'checkout', '-q', '--detach');
    expect(await service.push({ id, jobId: job() })).toMatchObject({
      status: 'failed',
      reason: 'detached',
    });
  });

  it('asks for hosted credentials only for a linked repository, with the right scope', async () => {
    const bare = bareRemote();
    const root = makeRepo();
    git(root, 'remote', 'add', 'origin', bare);
    // A header scoped to an unrelated https URL: present in the env, never sent to a local path.
    const gitAuth = vi.fn(async () =>
      gitAuthEnv('https://example.com/r.git', 'test-token'),
    );
    const { id, service, store } = await setup(root, { gitAuth });

    await service.fetch({ id, remote: 'origin', jobId: job() });
    expect(gitAuth).not.toHaveBeenCalled();

    const remoteId = '44444444-4444-4444-8444-444444444444';
    store.setRemote(id, remoteId);
    expect((await service.push({ id, jobId: job() })).status).toBe('pushed');
    expect(gitAuth).toHaveBeenLastCalledWith(remoteId, bare, 'write');
    const fetched = await service.fetch({ id, remote: 'origin', jobId: job() });
    expect(fetched.status).toBe('fetched');
    expect(gitAuth).toHaveBeenLastCalledWith(remoteId, bare, 'read');
  });

  it('reports an account error as a failed fetch without running Git', async () => {
    const root = makeRepo();
    git(root, 'remote', 'add', 'origin', 'https://example.invalid/r.git');
    const gitAuth = vi.fn(async () => {
      throw new UserError("The Git host didn't answer. Try again in a moment.");
    });
    const { id, service, store } = await setup(root, { gitAuth });
    store.setRemote(id, '44444444-4444-4444-8444-444444444444');
    expect(await service.fetch({ id, remote: 'origin', jobId: job() })).toEqual(
      {
        status: 'failed',
        reason: 'auth',
        code: 'AUTH_EXPIRED',
        message: "The Git host didn't answer. Try again in a moment.",
      },
    );
  });
});

describe('hosted Git remote', () => {
  const HOSTED = 'https://acct.artifacts.cloudflare.net/git/gitdesk/abc.git';
  const REMOTE_ID = '55555555-5555-4555-8555-555555555555';
  const hosting = (overrides: Partial<Hosting> = {}): Hosting => ({
    hostedUrl: vi.fn(async () => HOSTED),
    provision: vi.fn(),
    envFor: vi.fn(async () => null),
    terminalToken: vi.fn(async () => ({
      token: 'art_v1_0123456789abcdef?expires=1790000000',
      expiresAt: 1_790_000_000_000,
    })),
    revoke: vi.fn(async () => 2),
    ...overrides,
  });

  it('adds the Git URL as origin, once, with no secret in .git/config', async () => {
    const root = makeRepo();
    const { id, repos, store } = await setup(root, { hosting: hosting() });
    await expect(repos.addHostedRemote(id)).rejects.toThrow(
      /Link this repository/,
    );
    store.setRemote(id, REMOTE_ID);

    expect(await repos.addHostedRemote(id)).toEqual({
      name: 'origin',
      added: true,
    });
    expect(git(root, 'remote', 'get-url', 'origin').trim()).toBe(HOSTED);
    expect(await repos.addHostedRemote(id)).toEqual({
      name: 'origin',
      added: false,
    });
    expect(
      readFileSync(path.join(root, '.git', 'config'), 'utf8'),
    ).not.toContain('art_v1');
  });

  it('uses gitdesk when origin points elsewhere, and never replaces it', async () => {
    const root = makeRepo();
    git(root, 'remote', 'add', 'origin', 'https://example.com/other.git');
    const { id, repos, store } = await setup(root, { hosting: hosting() });
    store.setRemote(id, REMOTE_ID);
    expect(await repos.addHostedRemote(id)).toEqual({
      name: 'gitdesk',
      added: true,
    });
    expect(git(root, 'remote', 'get-url', 'origin').trim()).toBe(
      'https://example.com/other.git',
    );
  });

  it('says so when the server has no Git hosting', async () => {
    const root = makeRepo();
    const off = hosting({
      hostedUrl: vi.fn(async () => null),
      provision: vi.fn(async () => ({ gitUrl: null }) as never),
    });
    const { id, repos, store } = await setup(root, { hosting: off });
    store.setRemote(id, REMOTE_ID);
    await expect(repos.addHostedRemote(id)).rejects.toThrow(
      /Git hosting turned on/,
    );
  });

  it('copies a push command that names HEAD, never a branch, and refuses unsafe tokens', async () => {
    const root = makeRepo();
    git(root, 'remote', 'add', 'origin', HOSTED);
    const safe = await setup(root, { hosting: hosting() });
    safe.store.setRemote(safe.id, REMOTE_ID);
    expect(await safe.repos.copyGitCommand(safe.id)).toEqual({
      expiresAt: 1_790_000_000_000,
    });
    expect(safe.copyText).toHaveBeenCalledWith(
      `git -c "http.${HOSTED}.extraHeader=Authorization: Bearer art_v1_0123456789abcdef?expires=1790000000" push origin HEAD`,
    );

    const unsafe = hosting({
      terminalToken: vi.fn(async () => ({
        token: 'x"; rm -rf ~; "',
        expiresAt: 1,
      })),
    });
    const bad = await setup(root, { hosting: unsafe, db: 'other.db' });
    bad.store.setRemote(bad.id, REMOTE_ID);
    await expect(bad.repos.copyGitCommand(bad.id)).rejects.toThrow(
      /isn't safe/,
    );
    expect(bad.copyText).not.toHaveBeenCalled();
  });
});

describe('history, analytics and repository settings', () => {
  it('pages history from a fixed snapshot and reads commit detail', async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'README.md'), 'v2\n');
    git(root, 'commit', '-q', '-am', 'Second');
    const { id, service } = await setup(root);
    const page = await service.log({ id, oid: null, skip: 0 });
    expect(page.commits.map((c) => c.subject)).toEqual(['Second', 'Initial']);
    expect(page.nextSkip).toBeNull();
    const detail = await service.commitDetail({
      id,
      oid: page.commits[0]!.oid,
    });
    expect(detail.files).toEqual([
      { path: 'README.md', oldPath: null, added: 1, removed: 1 },
    ]);
  });

  it('aggregates commits and lines for the range', async () => {
    const root = makeRepo();
    writeFileSync(path.join(root, 'README.md'), 'a\nb\nc\n');
    git(root, 'commit', '-q', '-am', 'More');
    const { id, service } = await setup(root);
    const stats = await service.analytics({ id, range: '4w' });
    expect(stats.commits).toBe(2);
    expect(stats.totalCommits).toBe(2);
    expect(stats.buckets).toHaveLength(4);
    expect(stats.added).toBeGreaterThanOrEqual(4);
    expect(stats.topFiles[0]!.path).toBe('README.md');
    expect(stats.authors).toEqual([
      { name: 'Test', email: 'test@example.com', commits: 2 },
    ]);
  });

  it('writes repository identity to .git/config and removes it again', async () => {
    const root = makeRepo();
    const { id, service } = await setup(root);
    await service.setGitConfig({
      id,
      identity: { name: 'Work Me', email: 'work@example.com' },
    });
    expect(git(root, 'config', '--local', 'user.email').trim()).toBe(
      'work@example.com',
    );
    const cleared = await service.setGitConfig({
      id,
      identity: null,
      prune: true,
    });
    expect(cleared.identity).toEqual({ name: null, email: null });
    expect(cleared.prune).toBe(true);
  });

  it('lists config that runs programs by name only', async () => {
    const root = makeRepo();
    git(root, 'config', 'core.sshCommand', 'ssh -i secret-key');
    const { id, service } = await setup(root);
    const config = await service.gitConfig(id);
    expect(config.programs).toContain('core.sshcommand');
    expect(JSON.stringify(config)).not.toContain('secret-key');
  });
});

describe('security regressions', () => {
  it('never runs a repository-configured diff.external, textconv driver or fsmonitor', async () => {
    const root = makeRepo();
    const marker = path.join(dir, 'ran');
    const script = path.join(dir, 'evil.sh');
    writeFileSync(
      script,
      `#!/bin/sh\necho ran > "${marker.replace(/\\/g, '/')}"\n`,
      {
        mode: 0o755,
      },
    );
    const evil = script.replace(/\\/g, '/');
    git(root, 'config', 'diff.external', evil);
    git(root, 'config', 'diff.evil.textconv', evil);
    git(root, 'config', 'core.fsmonitor', evil);
    writeFileSync(path.join(root, '.gitattributes'), '*.ts diff=evil\n');
    writeFileSync(path.join(root, 'src', 'a.ts'), 'export const a = 9;\n');
    const { id, service } = await setup(root);
    await service.diff({
      id,
      path: 'src/a.ts',
      side: 'unstaged',
      context: 3,
      ignoreWhitespace: false,
      full: false,
    });
    await service.analytics({ id, range: '4w' });
    expect(existsSync(marker)).toBe(false);
  });
});

describe('helpers', () => {
  it('redacts URLs, classifies fetch errors and sanitizes output', () => {
    expect(redactRemoteUrl('git@github.com:me/r.git')).toMatchObject({
      protocol: 'ssh',
    });
    expect(redactRemoteUrl('ssh://git@host/r.git').hadCredentials).toBe(false);
    expect(
      classifyFetchError('fatal: Authentication failed for https://x'),
    ).toBe('auth');
    expect(classifyFetchError('Could not resolve host: example.com')).toBe(
      'network',
    );
    expect(sanitizeOutput('\x1b[31merror\x1b[0m in /repo/x', '/repo')).toBe(
      'error in ./x',
    );
    expect(
      parseBlockedFiles(
        'error: Your local changes to the following files would be overwritten by checkout:\n\tREADME.md\n\tsrc/a.ts\nPlease commit your changes or stash them before you switch branches.\nAborting',
      ),
    ).toEqual(['README.md', 'src/a.ts']);
  });
});
