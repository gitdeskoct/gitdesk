import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
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
import { createRepositoryService } from '../repos/repository-service';
import { createRepositoryStore } from '../repos/repository-store';
import { createWorkspaceService } from '../repos/workspace-service';
import { createMoveService } from './move-service';

// Two bare repositories stand in for another provider and the gitdesk remote.
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' }).trim();
const config = (cwd: string, key: string) => {
  try {
    return git(cwd, 'config', '--get', key);
  } catch {
    return null;
  }
};

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
  process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
});

let dir: string;
const cleanups: (() => void)[] = [];

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gitdesk-move-'));
});

afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
  rmSync(dir, { recursive: true, force: true });
});

function commit(root: string, file: string, text: string, message: string) {
  writeFileSync(path.join(root, file), text);
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', message);
}

// "other" has main, a branch nobody checked out here and a tag; "app" is a clone of it.
function world() {
  const other = path.join(dir, 'other.git');
  const hosted = path.join(dir, 'hosted.git');
  git(dir, 'init', '-q', '--bare', '-b', 'main', other);
  git(dir, 'init', '-q', '--bare', '-b', 'main', hosted);
  const seed = path.join(dir, 'seed');
  git(dir, 'clone', '-q', '-c', 'core.autocrlf=false', other, seed);
  commit(seed, 'README.md', '# app\n', 'Initial');
  git(seed, 'tag', 'v1');
  git(seed, 'push', '-q', 'origin', 'main', 'v1');
  git(seed, 'switch', '-q', '-c', 'feature');
  commit(seed, 'feature.txt', 'f\n', 'Feature');
  git(seed, 'push', '-q', 'origin', 'feature');
  const root = path.join(dir, 'app');
  git(dir, 'clone', '-q', '-c', 'core.autocrlf=false', other, root);
  return { other, hosted, hostedUrl: pathToFileURL(hosted).href, root };
}

async function setup(root: string, hostedUrl: string) {
  const db = openDatabase(path.join(dir, 'test.db'));
  cleanups.push(() => db.close());
  const store = createRepositoryStore(db);
  const settings = { ...DEFAULT_SETTINGS, watchRepositories: false };
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
  const id = added.repository.id;
  store.setRemote(id, 'remote-1');
  const ws = createWorkspaceService({
    store,
    refresh: (repoId) => repos.refresh(repoId),
    addActivity: vi.fn(),
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
  const addActivity = vi.fn();
  const move = createMoveService({
    db,
    store,
    workspace: ws,
    hostedUrl: async () => hostedUrl,
    gitAuth: async () => ({}),
    addActivity,
    refresh: (repoId) => repos.refresh(repoId),
  });
  return { id, move, addActivity };
}

const job = () => crypto.randomUUID();

describe('move to gitdesk', () => {
  it('copies every branch and tag, checks them, then switches origin', async () => {
    const { hosted, hostedUrl, root, other } = world();
    const { id, move, addActivity } = await setup(root, hostedUrl);

    expect(await move.preview(id)).toMatchObject({
      status: 'ready',
      remotes: [{ name: 'origin' }],
      branches: 2,
      tags: 1,
    });
    const result = await move.move({ id, jobId: job() });
    expect(result).toEqual({
      status: 'moved',
      branches: 2,
      tags: 1,
      removed: ['origin'],
    });

    expect(git(hosted, 'rev-parse', 'main')).toBe(
      git(other, 'rev-parse', 'main'),
    );
    expect(git(hosted, 'rev-parse', 'feature')).toBe(
      git(other, 'rev-parse', 'feature'),
    );
    expect(git(hosted, 'rev-parse', 'v1')).toBe(git(other, 'rev-parse', 'v1'));
    expect(git(root, 'remote')).toBe('origin');
    expect(git(root, 'remote', 'get-url', 'origin')).toBe(hostedUrl);
    expect(config(root, 'branch.main.remote')).toBe('origin');
    // `git remote remove` drops .merge too; main must still track origin/main.
    expect(config(root, 'branch.main.merge')).toBe('refs/heads/main');
    expect(git(root, 'rev-parse', '--abbrev-ref', 'main@{upstream}')).toBe(
      'origin/main',
    );
    expect(git(root, 'rev-parse', 'origin/main')).toBe(
      git(root, 'rev-parse', 'main'),
    );
    expect(addActivity).toHaveBeenCalledWith(id, 'moved', '2 branches, 1 tags');
    expect(await move.undoState(id)).toMatchObject({ remotes: ['origin'] });
    expect(await move.preview(id)).toMatchObject({
      status: 'refused',
      reason: 'nothing',
    });
  });

  it('undo puts the old remotes and upstreams back', async () => {
    const { hostedUrl, root, other } = world();
    git(root, 'remote', 'add', 'gitdesk', hostedUrl);
    git(root, 'config', 'remote.origin.prune', 'true');
    const { id, move } = await setup(root, hostedUrl);
    expect(await move.move({ id, jobId: job() })).toMatchObject({
      status: 'moved',
    });
    expect(git(root, 'remote')).toBe('origin');

    await move.undo(id);
    expect(git(root, 'remote').split('\n').sort()).toEqual([
      'gitdesk',
      'origin',
    ]);
    expect(git(root, 'remote', 'get-url', 'origin')).toBe(other);
    expect(git(root, 'remote', 'get-url', 'gitdesk')).toBe(hostedUrl);
    expect(config(root, 'remote.origin.prune')).toBe('true');
    expect(config(root, 'branch.main.remote')).toBe('origin');
    expect(config(root, 'branch.main.merge')).toBe('refs/heads/main');
    expect(await move.undoState(id)).toBeNull();
    await expect(move.undo(id)).rejects.toThrow(/no move to undo/);
  });

  it('stops before any config change when gitdesk has a different branch', async () => {
    const { hosted, hostedUrl, root, other } = world();
    const elsewhere = path.join(dir, 'elsewhere');
    git(dir, 'clone', '-q', hosted, elsewhere);
    commit(elsewhere, 'other.txt', 'x\n', 'Unrelated');
    git(elsewhere, 'push', '-q', 'origin', 'HEAD:main');
    const theirs = git(hosted, 'rev-parse', 'main');
    const { id, move } = await setup(root, hostedUrl);

    expect(await move.move({ id, jobId: job() })).toMatchObject({
      status: 'refused',
      reason: 'diverged',
    });
    expect(git(hosted, 'rev-parse', 'main')).toBe(theirs);
    expect(git(root, 'remote', 'get-url', 'origin')).toBe(other);
    expect(await move.undoState(id)).toBeNull();
  });

  it('refuses a repository that uses Git LFS', async () => {
    const { hostedUrl, root, other } = world();
    commit(
      root,
      '.gitattributes',
      '*.psd filter=lfs diff=lfs merge=lfs -text\n',
      'LFS',
    );
    const { id, move } = await setup(root, hostedUrl);
    expect(await move.preview(id)).toMatchObject({
      status: 'refused',
      reason: 'lfs',
    });
    expect(await move.move({ id, jobId: job() })).toMatchObject({
      status: 'refused',
      reason: 'lfs',
    });
    expect(git(root, 'remote', 'get-url', 'origin')).toBe(other);
  });

  it('needs a linked repository with a Git URL', async () => {
    const { root } = world();
    const { id, move } = await setup(root, '');
    expect(await move.preview(id)).toMatchObject({
      status: 'refused',
      reason: 'not-linked',
    });
  });
});
