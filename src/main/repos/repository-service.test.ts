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
import { NameTakenError } from '../remote/remote-service';
import { bucketWeeks, weekStart } from './git-inspector';
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
const remoteUpdate = vi.fn();
const trashItem = vi.fn(async (target: string) =>
  rmSync(target, { recursive: true, force: true }),
);
let protectedPaths: string[] = [];
const cleanups: (() => void)[] = [];

function setup(
  extra: Partial<Parameters<typeof createRepositoryService>[0]> = {},
) {
  const db = openDatabase(path.join(dir, 'test.db'));
  cleanups.push(() => db.close());
  const store = createRepositoryStore(db);
  const emit = vi.fn();
  const service = createRepositoryService({
    store,
    remote: { create: remoteCreate, update: remoteUpdate },
    settings: () => ({ ...DEFAULT_SETTINGS, watchRepositories: false }),
    emit,
    desktop: {
      pickDirectory: async () => picked,
      openPath: async () => '',
      copyText: vi.fn(),
      trashItem,
      protectedPaths: () => protectedPaths,
    },
    ...extra,
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
  remoteUpdate.mockReset();
  trashItem.mockClear();
  protectedPaths = [];
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
        expect.objectContaining({ path: 'new.txt', kind: 'staged', code: 'A' }),
        expect.objectContaining({
          path: 'README.md',
          kind: 'modified',
          code: 'M',
        }),
        expect.objectContaining({
          path: 'untracked.txt',
          kind: 'untracked',
          code: '?',
        }),
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
  }, 20_000);

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

describe('progress and notices', () => {
  it('reports each create step in order and measures the whole create', async () => {
    picked = dir;
    const events: { stage: string; percent: number }[] = [];
    const { service } = setup({ emitProgress: (e) => events.push(e) });
    const location = await service.chooseLocation();
    if (!location) throw new Error('no location');
    const result = await service.create({
      name: 'stepped',
      locationToken: location.token,
      readme: true,
      remote: false,
      jobId: '7c1b1f2e-1a2b-4c3d-8e4f-5a6b7c8d9e0f',
    });
    expect(events.map((e) => e.stage)).toEqual([
      'folder',
      'init',
      'readme',
      'register',
      'done',
    ]);
    expect(events.at(-1)?.percent).toBe(100);
    expect(result.timing.remoteMs).toBeNull();
    expect(result.timing.totalMs).toBeGreaterThanOrEqual(0);
  });

  it('reports a new conflict once, not on every check', async () => {
    const root = makeRepo('merging');
    git(root, 'checkout', '-q', '-b', 'side');
    writeFileSync(path.join(root, 'README.md'), '# side\n');
    git(root, 'commit', '-q', '-am', 'side');
    git(root, 'checkout', '-q', 'main');
    writeFileSync(path.join(root, 'README.md'), '# main\n');
    git(root, 'commit', '-q', '-am', 'main');
    picked = root;
    const onProblem = vi.fn();
    const { service } = setup({ onProblem });
    const added = await service.add();
    if (added.status !== 'added') throw new Error('not added');

    try {
      git(root, 'merge', 'side');
    } catch {
      // The merge stops on the conflict, which is the point.
    }
    await service.refresh(added.repository.id);
    await service.refresh(added.repository.id);

    expect(onProblem).toHaveBeenCalledTimes(1);
    expect(onProblem.mock.calls[0]![1]).toBe('conflict');
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

async function registered(root: string) {
  picked = root;
  const harness = setup();
  const added = await harness.service.add();
  if (added.status !== 'added') throw new Error('not added');
  return { ...harness, id: added.repository.id };
}

describe('history', () => {
  it('counts commits, branches and weeks from the current branch', async () => {
    const root = makeRepo('app');
    const twoWeeksAgo = new Date(Date.now() - 14 * 86_400_000).toISOString();
    execFileSync('git', ['commit', '-q', '--allow-empty', '-m', 'Older'], {
      cwd: root,
      env: { ...process.env, GIT_COMMITTER_DATE: twoWeeksAgo },
    });
    git(root, 'commit', '-q', '--allow-empty', '-m', 'Latest');
    git(root, 'branch', 'feature');
    git(root, 'update-ref', 'refs/remotes/origin/main', 'HEAD');
    git(
      root,
      'symbolic-ref',
      'refs/remotes/origin/HEAD',
      'refs/remotes/origin/main',
    );
    const { service, id } = await registered(root);

    const result = await service.history(id);

    expect(result).toMatchObject({
      branch: 'main',
      commitCount: 3,
      localBranches: 2,
      remoteBranches: 1,
      weeksTruncated: false,
    });
    expect(result.weeks).toHaveLength(12);
    expect(result.weeks.reduce((sum, week) => sum + week.commits, 0)).toBe(3);
    expect(result.recent.map((c) => c.subject)).toEqual([
      'Latest',
      'Older',
      'First <commit> & "quotes"',
    ]);
    expect(result.recent[0]).toMatchObject({ author: 'Test' });
  });

  it('reports an empty repository without inventing history', async () => {
    const root = path.join(dir, 'empty');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'trunk');
    const { service, id } = await registered(root);

    const result = await service.history(id);

    expect(result).toMatchObject({
      branch: 'trunk',
      commitCount: 0,
      recent: [],
    });
    expect(result.weeks.every((week) => week.commits === 0)).toBe(true);
  });

  it('buckets by local Monday and counts future-dated commits in the current week', () => {
    const now = new Date(2026, 9, 21, 15).getTime();
    const monday = weekStart(now);
    expect(new Date(monday).getDay()).toBe(1);
    expect(new Date(monday).getHours()).toBe(0);
    const weeks = bucketWeeks(
      [now + 86_400_000, monday, monday - 1, monday - 20 * 7 * 86_400_000],
      now,
    );
    expect(weeks.at(-1)).toEqual({ start: monday, commits: 2 });
    expect(weeks.at(-2)?.commits).toBe(1);
    expect(weeks.reduce((sum, week) => sum + week.commits, 0)).toBe(3);
  });
});

describe('disconnect, rename and trash', () => {
  it('disconnects a remote without touching Git config, and refuses when there is none', async () => {
    const root = makeRepo('app');
    const { service, store, id } = await registered(root);
    store.setRemote(id, crypto.randomUUID());

    expect(service.unlink(id).remoteId).toBeNull();
    expect(service.activity().map((a) => a.type)).toContain('unlinked');
    expect(() => service.unlink(id)).toThrow('no remote');
  });

  it('renames a linked repository on the remote first, and keeps both as they were on a bad name', async () => {
    const root = makeRepo('app');
    const { service, store, id } = await registered(root);
    const remoteId = crypto.randomUUID();
    store.setRemote(id, remoteId);

    await expect(service.update({ id, name: 'two words' })).rejects.toThrow();
    expect(remoteUpdate).not.toHaveBeenCalled();
    expect(service.list()[0]?.name).toBe('app');

    remoteUpdate.mockResolvedValueOnce({});
    const renamed = await service.update({
      id,
      name: 'desk-app',
      description: 'Notes',
    });
    expect(remoteUpdate).toHaveBeenCalledWith({
      id: remoteId,
      name: 'desk-app',
      description: 'Notes',
    });
    expect(renamed).toMatchObject({ name: 'desk-app', description: 'Notes' });

    remoteUpdate.mockRejectedValueOnce(new UserError('Server said no'));
    await expect(service.update({ id, name: 'other' })).rejects.toThrow(
      'Server said no',
    );
    expect(service.list()[0]?.name).toBe('desk-app');
  });

  it('allows a folder-style display name on a local-only repository', async () => {
    const { service, id } = await registered(makeRepo('app'));
    expect((await service.update({ id, name: 'My App' })).name).toBe('My App');
    expect(remoteUpdate).not.toHaveBeenCalled();
  });

  it('moves the registered folder to the trash only after the name is retyped', async () => {
    const root = makeRepo('app');
    const { service, id } = await registered(root);

    await expect(service.trash({ id, confirmName: 'App' })).rejects.toThrow(
      'exactly',
    );
    expect(trashItem).not.toHaveBeenCalled();

    await service.trash({ id, confirmName: 'app' });
    expect(trashItem).toHaveBeenCalledWith(path.resolve(root));
    expect(existsSync(root)).toBe(false);
    expect(service.list()).toHaveLength(0);
  });

  it('refuses to trash a folder that is protected, changed or holds another repository', async () => {
    const outer = makeRepo('outer');
    const { service, id, store } = await registered(outer);

    protectedPaths = [path.join(outer, 'src')];
    await expect(service.trash({ id, confirmName: 'outer' })).rejects.toThrow(
      "won't",
    );
    protectedPaths = [];

    const inner = makeRepo(path.join('outer', 'inner'));
    picked = inner;
    await service.add();
    await expect(service.trash({ id, confirmName: 'outer' })).rejects.toThrow(
      'inner is inside this folder',
    );

    rmSync(path.join(outer, '.git'), { recursive: true, force: true });
    store.remove(service.list().find((r) => r.name === 'inner')!.id);
    await expect(service.trash({ id, confirmName: 'outer' })).rejects.toThrow(
      'no longer holds this repository',
    );
    expect(trashItem).not.toHaveBeenCalled();
    expect(existsSync(outer)).toBe(true);
  });

  it('keeps the registration when the system trash refuses', async () => {
    const root = makeRepo('app');
    const { service, id } = await registered(root);
    trashItem.mockRejectedValueOnce(new Error('in use'));
    await expect(service.trash({ id, confirmName: 'app' })).rejects.toThrow(
      'Nothing was deleted',
    );
    expect(service.list()).toHaveLength(1);
  });
});

describe('automatic private remote', () => {
  const made = (id: string, name: string) => ({
    id,
    name,
    description: null,
    visibility: 'private' as const,
    defaultBranch: 'main',
    status: 'ready' as const,
    gitUrl: null,
    createdAt: 1,
    updatedAt: 1,
  });

  it('links a project added while signed in, once', async () => {
    picked = makeRepo('app');
    remoteCreate.mockResolvedValue(made('remote-1', 'app'));
    const { service, store } = setup({ signedIn: () => true });
    const result = await service.add();
    if (result.status !== 'added') throw new Error('not added');
    await vi.waitFor(() =>
      expect(store.get(result.repository.id)?.remoteId).toBe('remote-1'),
    );
    expect(remoteCreate).toHaveBeenCalledTimes(1);
    expect(remoteCreate).toHaveBeenCalledWith(
      { name: 'app', description: null },
      result.repository.id,
    );
    expect(service.list()[0]?.autoLink).toBeNull();
  });

  it('waits for sign-in, then links the projects added meanwhile', async () => {
    picked = makeRepo('app');
    let signedIn = false;
    remoteCreate.mockResolvedValue(made('remote-1', 'app'));
    const { service, store } = setup({ signedIn: () => signedIn });
    const result = await service.add();
    if (result.status !== 'added') throw new Error('not added');
    expect(remoteCreate).not.toHaveBeenCalled();
    expect(service.list()[0]?.autoLink).toEqual({ state: 'waiting' });

    signedIn = true;
    service.handleAuth({ status: 'authenticated' });
    await vi.waitFor(() =>
      expect(store.get(result.repository.id)?.remoteId).toBe('remote-1'),
    );
    expect(store.get(result.repository.id)?.autoLinkPending).toBe(false);
    expect(remoteCreate).toHaveBeenCalledTimes(1);
  });

  it('tries numbered names when the folder name is taken, then asks', async () => {
    picked = makeRepo('app');
    remoteCreate.mockRejectedValue(new NameTakenError('taken'));
    const { service, store } = setup({ signedIn: () => true });
    const result = await service.add();
    if (result.status !== 'added') throw new Error('not added');
    await vi.waitFor(() =>
      expect(service.list()[0]?.autoLink).toEqual({
        state: 'name-taken',
        name: 'app',
      }),
    );
    expect(remoteCreate.mock.calls.map(([input]) => input.name)).toEqual([
      'app',
      ...[2, 3, 4, 5, 6, 7, 8, 9].map((n) => `app-${n}`),
    ]);

    remoteCreate.mockResolvedValue(made('remote-2', 'mine'));
    await service.linkNamed({ id: result.repository.id, name: 'mine' });
    expect(store.get(result.repository.id)?.remoteId).toBe('remote-2');
    expect(service.list()[0]?.autoLink).toBeNull();
  });

  it('reports a failure on the row and does nothing when local-only', async () => {
    picked = makeRepo('app');
    remoteCreate.mockRejectedValue(
      new UserError("Can't reach the gitdesk server."),
    );
    const { service } = setup({ signedIn: () => true });
    await service.add();
    await vi.waitFor(() =>
      expect(service.list()[0]?.autoLink).toEqual({
        state: 'failed',
        message: "Can't reach the gitdesk server.",
      }),
    );

    remoteCreate.mockClear();
    picked = makeRepo('other');
    const local = setup({
      signedIn: () => true,
      settings: () => ({
        ...DEFAULT_SETTINGS,
        watchRepositories: false,
        localOnly: true,
      }),
    });
    await local.service.add();
    expect(remoteCreate).not.toHaveBeenCalled();
    expect(local.service.list().every((repo) => repo.autoLink === null)).toBe(
      true,
    );
  });
});

describe('locate', () => {
  it('moves to the same repository at once and asks about a different one', async () => {
    const root = makeRepo('app');
    picked = root;
    const { service, store } = setup();
    const added = await service.add();
    if (added.status !== 'added') throw new Error('not added');
    const id = added.repository.id;
    await vi.waitFor(() => expect(store.get(id)?.rootCommit).toBeTruthy());

    const moved = path.join(dir, 'moved-app');
    renameSync(root, moved);
    picked = moved;
    const same = await service.locate(id);
    expect(same).toMatchObject({ status: 'located' });
    expect(store.get(id)?.rootPath.toLowerCase()).toContain('moved-app');

    picked = makeRepo('stranger');
    const other = await service.locate(id);
    expect(other).toMatchObject({ status: 'different' });
    expect(store.get(id)?.rootPath.toLowerCase()).toContain('moved-app');
    if (other.status !== 'different') return;
    await service.locateConfirm({ id, token: other.token });
    expect(store.get(id)?.rootPath.toLowerCase()).toContain('stranger');
  });
});
