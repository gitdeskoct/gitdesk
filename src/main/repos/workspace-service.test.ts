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
import { createRepositoryService } from './repository-service';
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

async function setup(root: string) {
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
  });
  cleanups.push(() => service.dispose());
  return { id, service, repos, store, desktop };
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
    await expect(service.stage({ id, paths: ['README.md'] })).rejects.toThrow(
      /moved on/,
    );
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
