import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
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
import { DEFAULT_SETTINGS } from '../../shared/settings';
import { openDatabase } from '../db/database';
import { UserError } from '../errors';
import { createRepositoryService, displayPath } from './repository-service';
import { createRepositoryStore } from './repository-store';

// Real Git, real folders: these tests exercise the same commands the app runs.
const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

beforeAll(() => {
  // Commits in temp repositories must not depend on the developer's global identity.
  process.env.GIT_AUTHOR_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
  process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
});

let dir: string;
let picked: string | null;
const remoteCreate = vi.fn();
const cleanups: (() => void)[] = [];

function setup() {
  const db = openDatabase(path.join(dir, 'test.db'));
  cleanups.push(() => db.close());
  const store = createRepositoryStore(db);
  const emit = vi.fn();
  const service = createRepositoryService({
    store,
    remote: { create: remoteCreate },
    settings: () => ({ ...DEFAULT_SETTINGS, watchRepositories: false }),
    emit,
    desktop: {
      pickDirectory: async () => picked,
      openPath: async () => '',
      copyText: vi.fn(),
    },
  });
  cleanups.push(() => service.dispose());
  return { service, store, db, emit };
}

function makeRepo(name: string): string {
  const root = path.join(dir, name);
  mkdirSync(path.join(root, 'src'), { recursive: true });
  git(root, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(root, 'README.md'), '# hi\n');
  git(root, 'add', '.');
  git(root, 'commit', '-q', '-m', 'First <commit> & "quotes"');
  return root;
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gitdesk-repos-'));
  picked = null;
  remoteCreate.mockReset();
});
// Windows can't delete the folder while SQLite or a watcher still holds a file in it.
afterEach(() => {
  cleanups.splice(0).forEach((fn) => fn());
  rmSync(dir, { recursive: true, force: true });
});

describe('repository service', () => {
  it('registers the repository root when a subfolder is picked, and inspects it', async () => {
    const root = makeRepo('app');
    picked = path.join(root, 'src');
    const { service } = setup();

    const result = await service.add();

    expect(result.status).toBe('added');
    if (result.status !== 'added') return;
    expect(result.repository.name).toBe('app');
    expect(result.repository.availability).toBe('available');
    expect(result.repository.status).toMatchObject({
      branch: 'main',
      staged: 0,
      unstaged: 0,
      untracked: 0,
      upstream: null,
      ahead: null,
      hasRemotes: false,
    });
    expect(result.repository.status?.lastCommit?.subject).toBe(
      'First <commit> & "quotes"',
    );
  });

  it('does not register the same folder twice', async () => {
    picked = makeRepo('app');
    const { service } = setup();
    const first = await service.add();
    const second = await service.add();
    expect(second.status).toBe('exists');
    if (first.status === 'canceled' || second.status === 'canceled') return;
    if ('repository' in first && 'repository' in second)
      expect(second.repository.id).toBe(first.repository.id);
    expect(service.list()).toHaveLength(1);
  });

  it('sees working-tree changes after a refresh', async () => {
    const root = makeRepo('app');
    picked = root;
    const { service } = setup();
    const added = await service.add();
    if (added.status !== 'added') throw new Error('not added');

    writeFileSync(path.join(root, 'README.md'), '# changed\n');
    writeFileSync(path.join(root, 'new.txt'), 'new\n');
    git(root, 'add', 'new.txt');
    writeFileSync(path.join(root, 'untracked.txt'), 'u\n');
    await service.refresh(added.repository.id);

    const [repo] = service.list();
    expect(repo?.status).toMatchObject({
      staged: 1,
      unstaged: 1,
      untracked: 1,
    });
    const changes = await service.changes(added.repository.id);
    expect(changes.files).toEqual(
      expect.arrayContaining([
        { path: 'new.txt', kind: 'staged', code: 'A' },
        { path: 'README.md', kind: 'modified', code: 'M' },
        { path: 'untracked.txt', kind: 'untracked', code: '?' },
      ]),
    );
  });

  it('marks a moved folder as missing but keeps the registration and last snapshot', async () => {
    const root = makeRepo('app');
    picked = root;
    const { service } = setup();
    const added = await service.add();
    if (added.status !== 'added') throw new Error('not added');

    const statusAt = service.list()[0]?.statusAt;
    expect(statusAt).toBeTypeOf('number');
    rmSync(root, { recursive: true, force: true });
    await service.refresh(added.repository.id);

    const [repo] = service.list();
    expect(repo?.availability).toBe('missing');
    expect(repo?.status?.branch).toBe('main');
    // The failed check is recorded, but the snapshot keeps its own, older time.
    expect(repo?.statusAt).toBe(statusAt);
    expect(repo!.inspectedAt!).toBeGreaterThanOrEqual(statusAt!);
  });

  // A downloaded repository's .git/config is untrusted: reading its status must not run its programs.
  it("does not run a repository's core.fsmonitor command", async () => {
    const root = makeRepo('hostile');
    const marker = path.join(dir, 'fsmonitor-ran');
    git(
      root,
      'config',
      'core.fsmonitor',
      `echo ran > "${marker.replace(/\\/g, '/')}" #`,
    );
    // Sanity check: plain Git does run it, so the test would catch a regression.
    git(root, 'status', '--porcelain=v2');
    expect(existsSync(marker)).toBe(true);
    rmSync(marker);

    picked = root;
    const { service } = setup();
    const added = await service.add();
    if (added.status !== 'added') throw new Error('not added');
    await service.refresh(added.repository.id);
    await service.changes(added.repository.id);

    expect(service.list()[0]?.status?.branch).toBe('main');
    expect(existsSync(marker)).toBe(false);
  });

  it('stops trusting a folder whose .git is gone, even inside another repository', async () => {
    const outer = makeRepo('outer');
    const inner = path.join(outer, 'inner');
    mkdirSync(inner);
    git(inner, 'init', '-q', '-b', 'main');
    picked = inner;
    const { service } = setup();
    const added = await service.add();
    if (added.status !== 'added') throw new Error('not added');

    rmSync(path.join(inner, '.git'), { recursive: true, force: true });
    await service.refresh(added.repository.id);

    expect(service.list()[0]?.availability).toBe('not-a-repo');
  });

  it('ends on the located folder even when an older check is still running', async () => {
    const root = makeRepo('app');
    picked = root;
    const { service } = setup();
    const added = await service.add();
    if (added.status !== 'added') throw new Error('not added');

    const moved = path.join(dir, 'moved');
    renameSync(root, moved);
    const stale = service.refresh(added.repository.id);
    picked = moved;
    await service.locate(added.repository.id);
    await stale;

    const [repo] = service.list();
    expect(repo?.availability).toBe('available');
    expect(repo?.displayPath).toContain('moved');
  });

  it('reports clone as unavailable without spending the folder choice', async () => {
    picked = dir;
    const { service } = setup();
    const location = await service.chooseLocation();
    if (!location) throw new Error('no location');

    const result = await service.clone({
      jobId: '6f1c1b52-6d0c-4b8e-9d0e-3d1f1b2a4c5d',
      remoteId: '0b6f2d43-1c3a-4f6e-8a9b-7c2d1e0f3a4b',
      name: 'from-remote',
      locationToken: location.token,
    });
    expect(result).toEqual({ status: 'unavailable' });
    // The same token still works for something else.
    await expect(
      service.create({
        name: 'still-mine',
        locationToken: location.token,
        readme: false,
        remote: false,
      }),
    ).resolves.toBeTruthy();
  });

  it('offers to initialize a plain folder through a one-time token', async () => {
    const plain = path.join(dir, 'plain');
    mkdirSync(plain);
    picked = plain;
    const { service } = setup();

    const result = await service.add();
    expect(result.status).toBe('not-a-repository');
    if (result.status !== 'not-a-repository') return;

    const repo = await service.initialize(result.token);
    expect(repo.status?.branch).toBeTruthy();
    expect(existsSync(path.join(plain, '.git'))).toBe(true);
    await expect(service.initialize(result.token)).rejects.toBeInstanceOf(
      UserError,
    );
  });

  it('creates a local repository with a committed README and no remote', async () => {
    picked = dir;
    const { service } = setup();
    const location = await service.chooseLocation();
    if (!location) throw new Error('no location');

    const result = await service.create({
      name: 'reading-list',
      description: 'Books to read',
      locationToken: location.token,
      readme: true,
      remote: false,
    });

    expect(result.remote).toEqual({ status: 'skipped' });
    expect(result.readmeCommitted).toBe(true);
    expect(result.repository.status?.lastCommit?.subject).toBe(
      'Initial commit',
    );
    expect(git(path.join(dir, 'reading-list'), 'log', '--oneline')).toContain(
      'Initial commit',
    );
    expect(remoteCreate).not.toHaveBeenCalled();
  });

  it('keeps the local repository and reports the remote step when the remote fails', async () => {
    picked = dir;
    remoteCreate.mockRejectedValue(
      new UserError("Can't reach the gitdesk server."),
    );
    const { service } = setup();
    const location = await service.chooseLocation();
    if (!location) throw new Error('no location');

    const result = await service.create({
      name: 'offline-made',
      locationToken: location.token,
      readme: false,
      remote: true,
    });

    expect(result.remote).toEqual({
      status: 'failed',
      message: "Can't reach the gitdesk server.",
    });
    expect(existsSync(path.join(dir, 'offline-made', '.git'))).toBe(true);
    expect(service.list()[0]?.remoteId).toBeNull();

    remoteCreate.mockResolvedValue({ id: 'remote-1' });
    await service.linkRemote(result.repository.id);
    expect(service.list()[0]?.remoteId).toBe('remote-1');
  });

  it('refuses to create into an existing folder', async () => {
    picked = dir;
    mkdirSync(path.join(dir, 'taken'));
    const { service } = setup();
    const location = await service.chooseLocation();
    if (!location) throw new Error('no location');
    await expect(
      service.create({
        name: 'taken',
        locationToken: location.token,
        readme: false,
        remote: false,
      }),
    ).rejects.toThrow('already exists');
  });

  it('removes only the registration, never the folder', async () => {
    const root = makeRepo('app');
    picked = root;
    const { service } = setup();
    const added = await service.add();
    if (added.status !== 'added') throw new Error('not added');

    service.remove(added.repository.id);

    expect(service.list()).toHaveLength(0);
    expect(existsSync(path.join(root, '.git'))).toBe(true);
  });

  it('records a new commit as local activity', async () => {
    const root = makeRepo('app');
    picked = root;
    const { service } = setup();
    const added = await service.add();
    if (added.status !== 'added') throw new Error('not added');

    git(root, 'commit', '-q', '--allow-empty', '-m', 'Second');
    await service.refresh(added.repository.id);

    // A commit is dated by Git (whole seconds), so it can sort level with or before "added".
    const activity = service.activity().map((a) => [a.type, a.detail]);
    expect(activity).toHaveLength(2);
    expect(activity).toEqual(
      expect.arrayContaining([
        ['commit', 'Second'],
        ['added', null],
      ]),
    );
  });
});

describe('displayPath', () => {
  it('shortens paths under the home folder only', () => {
    const home = path.join(path.sep, 'home', 'me');
    expect(displayPath(path.join(home, 'Projects', 'app'), home)).toBe(
      `~${path.sep}${path.join('Projects', 'app')}`,
    );
    expect(displayPath(path.join(path.sep, 'srv', 'app'), home)).toBe(
      path.join(path.sep, 'srv', 'app'),
    );
  });
});
