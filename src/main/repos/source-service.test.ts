import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
import type { SourceListInput, SourceSnapshot } from '../../shared/source';
import { createSourceService } from './source-service';

// Real Git, real folders, the same commands the Files tab runs.
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
  process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
});

let dir: string;
let root: string;
const ID = '00000000-0000-4000-8000-000000000001';
const reveal = vi.fn();

const write = (rel: string, content: string | Buffer) => {
  const target = path.join(root, rel);
  mkdirSync(path.dirname(target), { recursive: true });
  writeFileSync(target, content);
};

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gitdesk-src-'));
  root = path.join(dir, 'repo');
  mkdirSync(root);
  git(root, 'init', '-q', '-b', 'main');
  git(root, 'config', 'core.autocrlf', 'false');
  write('.gitignore', 'dist/\n*.log\n');
  write('README.md', '# app\n');
  write('src/main.ts', 'export const a = 1;\n');
  write('src/util/strings.ts', 'export {};\n');
  write('.env.example', 'KEY=\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'first');
  reveal.mockClear();
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const service = () =>
  createSourceService({ rootOf: () => root, showItemInFolder: reveal });

const list = (
  snapshot: SourceSnapshot,
  pathIn = '',
  extra: Partial<SourceListInput> = {},
) =>
  service().list({
    id: ID,
    snapshot,
    path: pathIn,
    offset: 0,
    showIgnored: false,
    showHidden: true,
    foldersFirst: true,
    ...extra,
  });

const names = (entries: { name: string }[]) => entries.map((e) => e.name);

describe('listing the working tree', () => {
  it('lists one folder, folders first, without .git, with Git state on each row', async () => {
    write('src/main.ts', 'export const a = 2;\n');
    write('src/new.ts', 'new\n');
    write('src/util/strings.ts', 'staged\n');
    git(root, 'add', 'src/util/strings.ts');
    write('src/util/strings.ts', 'staged then edited\n');

    const top = await list({ kind: 'worktree' });
    expect(names(top.entries)).toEqual([
      'src',
      '.env.example',
      '.gitignore',
      'README.md',
    ]);
    expect(top.entries.find((e) => e.name === 'src')?.changes).toBe(true);
    expect(top.entries.find((e) => e.name === 'README.md')).toMatchObject({
      type: 'file',
      size: 6,
      status: null,
    });

    const src = await list({ kind: 'worktree' }, 'src');
    expect(names(src.entries)).toEqual(['util', 'main.ts', 'new.ts']);
    expect(src.entries.find((e) => e.name === 'main.ts')?.status).toMatchObject(
      {
        code: 'M',
        kind: 'modified',
        staged: false,
        unstaged: true,
      },
    );
    expect(src.entries.find((e) => e.name === 'new.ts')?.status?.code).toBe(
      '?',
    );

    const util = await list({ kind: 'worktree' }, 'src/util');
    // Staged and edited again: both halves stay visible, never flattened into one state.
    expect(util.entries[0]?.status).toMatchObject({
      staged: true,
      unstaged: true,
    });
  });

  it('hides ignored files unless asked, and keeps tracked files that match an ignore rule', async () => {
    write('dist/bundle.js', 'x');
    write('debug.log', 'x');
    write('kept.log', 'tracked');
    git(root, 'add', '-f', 'kept.log');
    const hidden = await list({ kind: 'worktree' });
    expect(names(hidden.entries)).not.toContain('dist');
    expect(names(hidden.entries)).not.toContain('debug.log');
    expect(names(hidden.entries)).toContain('kept.log');

    const shown = await list({ kind: 'worktree' }, '', { showIgnored: true });
    expect(shown.entries.find((e) => e.name === 'dist')?.ignored).toBe(true);
    expect(shown.entries.find((e) => e.name === 'debug.log')?.ignored).toBe(
      true,
    );
    expect(shown.entries.find((e) => e.name === 'kept.log')?.ignored).toBe(
      false,
    );
    const inside = await list({ kind: 'worktree' }, 'dist', {
      showIgnored: true,
    });
    expect(inside.entries[0]).toMatchObject({
      name: 'bundle.js',
      ignored: true,
    });
  });

  it('marks everything inside an untracked folder as untracked', async () => {
    write('notes/a.md', 'a');
    write('notes/deep/b.md', 'b');
    const notes = await list({ kind: 'worktree' }, 'notes');
    expect(notes.entries.map((e) => [e.name, e.status?.code])).toEqual([
      ['deep', '?'],
      ['a.md', '?'],
    ]);
  });

  it('can hide dotfiles and sort folders in with files', async () => {
    const plain = await list({ kind: 'worktree' }, '', {
      showHidden: false,
      foldersFirst: false,
    });
    expect(names(plain.entries)).toEqual(['README.md', 'src']);
  });

  it('treats a folder with its own .git as a separate repository', async () => {
    mkdirSync(path.join(root, 'vendor', 'lib'), { recursive: true });
    git(path.join(root, 'vendor', 'lib'), 'init', '-q');
    const vendor = await list({ kind: 'worktree' }, 'vendor');
    expect(vendor.entries[0]).toMatchObject({ name: 'lib', type: 'submodule' });
  });

  it('pages a large folder in a stable order', async () => {
    for (let i = 0; i < 2005; i++) write(`many/f${i}.txt`, '');
    const first = await list({ kind: 'worktree' }, 'many');
    expect(first.entries).toHaveLength(2000);
    expect(first.total).toBe(2005);
    expect(first.nextOffset).toBe(2000);
    expect(first.entries.slice(0, 3).map((e) => e.name)).toEqual([
      'f0.txt',
      'f1.txt',
      'f2.txt',
    ]);
    const rest = await list({ kind: 'worktree' }, 'many', { offset: 2000 });
    expect(rest.entries).toHaveLength(5);
    expect(rest.nextOffset).toBeNull();
  });

  it('refuses paths outside the repository and inside .git', async () => {
    await expect(list({ kind: 'worktree' }, '../')).rejects.toThrow('outside');
    await expect(list({ kind: 'worktree' }, '.git')).rejects.toThrow('outside');
  });
});

describe('listing the index and a commit', () => {
  it('shows what is staged, not what is on disk', async () => {
    write('src/unstaged.ts', 'x');
    write('src/staged.ts', 'x');
    git(root, 'add', 'src/staged.ts');
    const src = await list({ kind: 'index' }, 'src');
    expect(names(src.entries)).toEqual(['util', 'main.ts', 'staged.ts']);
    expect(src.entries.find((e) => e.name === 'staged.ts')?.status?.code).toBe(
      'A',
    );
  });

  it('lists a commit by id, with sizes, and says when a folder is not in it', async () => {
    const oid = (await service().resolve({ id: ID, ref: 'main' })).oid;
    write('later/x.ts', 'x');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'second');
    const top = await list({ kind: 'commit', oid });
    expect(names(top.entries)).toEqual([
      'src',
      '.env.example',
      '.gitignore',
      'README.md',
    ]);
    expect(top.entries.find((e) => e.name === 'README.md')?.size).toBe(6);
    await expect(list({ kind: 'commit', oid }, 'later')).rejects.toThrow(
      "isn't in this commit",
    );
    await expect(service().resolve({ id: ID, ref: 'nope' })).rejects.toThrow(
      "isn't in this repository",
    );
  });
});

describe('reading a file', () => {
  const read = (
    path: string,
    snapshot: SourceSnapshot = { kind: 'worktree' },
    force = false,
  ) => service().read({ id: ID, snapshot, path, limitMiB: 1, force });

  it('reads the working tree, the staged version and a commit separately', async () => {
    const oid = (await service().resolve({ id: ID, ref: 'HEAD' })).oid;
    write('src/main.ts', 'staged\n');
    git(root, 'add', 'src/main.ts');
    write('src/main.ts', 'on disk\n');
    expect(await read('src/main.ts')).toMatchObject({
      kind: 'text',
      text: 'on disk\n',
    });
    expect(await read('src/main.ts', { kind: 'index' })).toMatchObject({
      text: 'staged\n',
    });
    expect(await read('src/main.ts', { kind: 'commit', oid })).toMatchObject({
      text: 'export const a = 1;\n',
    });
    expect(await read('src/gone.ts')).toEqual({ kind: 'missing' });
  });

  it('asks before a large file, and refuses past the hard cap', async () => {
    write('big.txt', 'x'.repeat(1024 * 1024 + 10));
    const asked = await read('big.txt');
    expect(asked).toMatchObject({ kind: 'too-large', canForce: true });
    expect(await read('big.txt', { kind: 'worktree' }, true)).toMatchObject({
      kind: 'text',
    });
    write('huge.txt', 'x'.repeat(5 * 1024 * 1024 + 1));
    expect(await read('huge.txt', { kind: 'worktree' }, true)).toMatchObject({
      kind: 'too-large',
      canForce: false,
    });
  });

  it('shows binary files as binary and images as pictures', async () => {
    write('app.bin', Buffer.from([0, 1, 2]));
    write('logo.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 0, 0]));
    expect(await read('app.bin')).toMatchObject({ kind: 'binary' });
    expect(await read('logo.png')).toMatchObject({
      kind: 'image',
      mime: 'image/png',
    });
  });

  it('refuses .git and paths that climb out', async () => {
    await expect(read('.git/config')).rejects.toThrow('outside');
    await expect(read('../outside.txt')).rejects.toThrow('outside');
  });
});

describe('search, history, stats and reveal', () => {
  it('finds tracked and untracked paths but not ignored ones, file names first', async () => {
    write('src/stringify.ts', '');
    write('dist/strings.js', '');
    const found = await service().paths({ id: ID, query: 'string' });
    expect(found.matches).toEqual(['src/stringify.ts', 'src/util/strings.ts']);
    expect(found.total).toBe(2);
  });

  it('names the last commit that changed a file', async () => {
    const change = await service().lastChange({
      id: ID,
      snapshot: { kind: 'worktree' },
      path: 'README.md',
    });
    expect(change).toMatchObject({ author: 'Test', subject: 'first' });
  });

  it('counts tracked files, their folders and their kinds', async () => {
    write('src/extra.ts', 'x');
    const stats = await service().stats(ID);
    expect(stats).toMatchObject({ files: 5, dirs: 2, changed: 1 });
    expect(stats.groups[0]).toEqual({
      label: 'TypeScript',
      count: 2,
      icon: 'code',
    });
  });

  it('gives a kind the icon most of its files have, even when a test is listed first', async () => {
    write('src/__a.test.ts', 'x');
    git(root, 'add', 'src/__a.test.ts');
    const stats = await service().stats(ID);
    expect(stats.groups[0]).toEqual({
      label: 'TypeScript',
      count: 3,
      icon: 'code',
    });
  });

  it('reveals a file inside the repository and nothing else', async () => {
    await service().reveal({ id: ID, path: 'src/main.ts' });
    expect(reveal).toHaveBeenCalledWith(path.resolve(root, 'src', 'main.ts'));
    await expect(service().reveal({ id: ID, path: '.git' })).rejects.toThrow(
      'outside',
    );
  });
});
