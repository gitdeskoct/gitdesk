import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ApprovedCommitChanged, runApprovedCommit } from './approved-commit';
import { gitBytes } from './git-inspector';

const limits = { maxBytes: 64 * 1024 };
const args = ['commit', '--quiet', '-m', 'Test message', '--signoff'];
const hooks = "hooks with a ' and spaces";
let dir: string;
let root: string;

async function git(...argv: string[]) {
  const r = await gitBytes(root, argv, limits);
  expect(r.code, r.stderr).toBe(0);
  return r.stdout.toString().trimEnd();
}
async function hook(name: string, body: string) {
  await writeFile(path.join(root, hooks, name), `#!/bin/sh\n${body}\n`, {
    mode: 0o700,
  });
}
async function stage(contents: string) {
  await writeFile(path.join(root, 'file.txt'), contents);
  await git('add', '--', 'file.txt');
}

beforeEach(async () => {
  dir = await mkdtemp(path.join(tmpdir(), "gitdesk guard ' "));
  root = path.join(dir, 'repo');
  await mkdir(root);
  for (const key of [
    'HOME',
    'USERPROFILE',
    'XDG_CONFIG_HOME',
    'TMPDIR',
    'TMP',
    'TEMP',
  ])
    vi.stubEnv(key, dir);
  for (const role of ['AUTHOR', 'COMMITTER']) {
    vi.stubEnv(`GIT_${role}_NAME`, 'Fixture');
    vi.stubEnv(`GIT_${role}_EMAIL`, 'fixture@example.invalid');
  }
  await git('init', '-q', '--template=', '-b', 'main');
  await git('config', 'core.hooksPath', hooks);
  await mkdir(path.join(root, hooks));
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await rm(dir, { recursive: true, force: true });
});

it('runs the original hooks with native arguments, environment, input and signoff', async () => {
  await stage('seed');
  await git(...args);
  const seed = await git('rev-parse', 'HEAD');
  // Unlike a shell hook, a native executable does not synthesize PWD or SHLVL.
  await writeFile(
    path.join(root, hooks, 'pre-commit'),
    `#!/usr/bin/env node
const fs = require('node:fs');
fs.appendFileSync('.git/invocations', JSON.stringify(process.argv.slice(1)) + '\\n');
fs.writeFileSync('.git/pre-commit.env', Object.entries(process.env).map(([k, v]) => k + '=' + v).sort().join('\\n'));
`,
    { mode: 0o700 },
  );
  for (const name of ['prepare-commit-msg', 'commit-msg', 'post-commit']) {
    await hook(
      name,
      `printf '<%s>\\n' "$0" "$@" >> .git/invocations\nenv | sort > .git/${name}.env`,
    );
  }
  await hook(
    'reference-transaction',
    '{ printf "phase:%s\\n" "$@"; cat; } >> .git/transactions\nenv | sort > .git/reference-transaction.env',
  );
  const transactions = async (old: string, next: string) =>
    (await readFile(path.join(root, '.git/transactions'), 'utf8'))
      .replaceAll(old, '<old>')
      .replaceAll(next, '<new>');
  await stage('first');
  await git(...args);
  const invocations = () =>
    readFile(path.join(root, '.git/invocations'), 'utf8');
  const env = async (name: string) =>
    (await readFile(path.join(root, `.git/${name}.env`), 'utf8'))
      .split('\n')
      .filter((line) => !line.startsWith('GIT_AUTHOR_DATE='));
  const calls = await invocations();
  const names = [
    'pre-commit',
    'prepare-commit-msg',
    'commit-msg',
    'post-commit',
    'reference-transaction',
  ];
  const ordinaryEnv = await Promise.all(names.map(env));
  await rm(path.join(root, '.git/invocations'));
  await stage('second');
  const head = await git('rev-parse', 'HEAD');
  const ordinaryTransactions = await transactions(seed, head);
  await rm(path.join(root, '.git/transactions'));
  const tree = await git('write-tree');
  const allowed = vi.fn();
  const result = await runApprovedCommit(
    root,
    args,
    { head, tree, branch: 'main' },
    limits,
    allowed,
  );
  expect(result.code, result.stderr).toBe(0);
  expect(allowed).toHaveBeenCalledOnce();
  expect(await invocations()).toBe(calls);
  expect(await Promise.all(names.map(env))).toEqual(ordinaryEnv);
  const next = await git('rev-parse', 'HEAD');
  expect(ordinaryTransactions).toContain('phase:prepared\n');
  expect(ordinaryTransactions).toContain('<old> <new> refs/heads/main\n');
  expect(await transactions(head, next)).toBe(ordinaryTransactions);
  expect(await git('rev-parse', 'HEAD^{tree}')).toBe(tree);
  expect(await git('log', '-1', '--format=%an <%ae>%n%B')).toContain(
    'Fixture <fixture@example.invalid>\nTest message\n\nSigned-off-by: Fixture <fixture@example.invalid>',
  );
});

it.each(['pre-commit', 'commit-msg', 'reference-transaction'])(
  'preserves a veto from %s',
  async (name) => {
    await hook(
      name,
      `${name === 'reference-transaction' ? 'test "$1" = prepared || exit 0\n' : ''}printf 'fixture veto\\n' >&2\nexit 1`,
    );
    await stage('approved');
    const result = await runApprovedCommit(
      root,
      args,
      { head: null, tree: await git('write-tree'), branch: 'main' },
      limits,
      vi.fn(),
    );
    expect(result.code).not.toBe(0);
    expect(result.stderr).toContain('fixture veto');
    expect(await git('for-each-ref', '--format=%(refname)')).toBe('');
  },
);

it.each(['branch', 'unborn', 'detached'])(
  'refuses restaged formatting before publication on %s HEAD and permits a new approval',
  async (mode) => {
    let head: string | null = null;
    if (mode !== 'unborn') {
      await stage('base');
      await git(...args);
      head = await git('rev-parse', 'HEAD');
    }
    if (mode === 'detached') await git('switch', '-q', '--detach');
    const branch = mode === 'detached' ? null : 'main';
    const refs = await git('for-each-ref', '--format=%(refname):%(objectname)');
    const history = await git('reflog', 'show', '--all', '--format=%H');
    await stage('text  ');
    const tree = await git('write-tree');
    await hook(
      'pre-commit',
      'printf "text\\n" > file.txt && git add -- file.txt',
    );
    await hook('post-commit', ': > .git/published');
    await expect(
      runApprovedCommit(root, args, { branch, head, tree }, limits, vi.fn()),
    ).rejects.toBeInstanceOf(ApprovedCommitChanged);
    expect(await git('for-each-ref', '--format=%(refname):%(objectname)')).toBe(
      refs,
    );
    expect(await git('reflog', 'show', '--all', '--format=%H')).toBe(history);
    const current = await gitBytes(
      root,
      ['rev-parse', '--verify', '--quiet', 'HEAD'],
      limits,
    );
    expect(current.code).toBe(head ? 0 : 1);
    expect(current.stdout.toString().trim() || null).toBe(head);
    expect(existsSync(path.join(root, '.git/published'))).toBe(false);
    expect(await readFile(path.join(root, 'file.txt'), 'utf8')).toBe('text\n');
    const formatted = await git('write-tree');
    expect(formatted).not.toBe(tree);
    const retried = await runApprovedCommit(
      root,
      args,
      { branch, head, tree: formatted },
      limits,
      vi.fn(),
    );
    expect(retried.code, retried.stderr).toBe(0);
    expect(await git('rev-parse', 'HEAD^{tree}')).toBe(formatted);
    if (mode === 'detached')
      expect(await git('rev-parse', 'refs/heads/main')).toBe(head);
  },
);

it('leaves another branch at the approved tip untouched', async () => {
  await stage('base');
  await git(...args);
  const head = await git('rev-parse', 'HEAD');
  await stage('approved');
  const tree = await git('write-tree');
  await git('switch', '-qc', 'other');
  await expect(
    runApprovedCommit(
      root,
      args,
      { head, tree, branch: 'main' },
      limits,
      vi.fn(),
    ),
  ).rejects.toBeInstanceOf(ApprovedCommitChanged);
  expect(await git('rev-parse', 'main', 'other')).toBe(`${head}\n${head}`);
});

it('does not clean up an existing AUTO_MERGE ref', async () => {
  await stage('approved');
  const tree = await git('write-tree');
  await git('update-ref', 'AUTO_MERGE', tree);
  await expect(
    runApprovedCommit(
      root,
      args,
      { head: null, tree, branch: 'main' },
      limits,
      vi.fn(),
    ),
  ).rejects.toBeInstanceOf(ApprovedCommitChanged);
  expect(await git('rev-parse', 'AUTO_MERGE')).toBe(tree);
  expect(await git('for-each-ref')).toBe('');
});

it('fails before committing when the hook configuration is unsupported', async () => {
  await stage('approved');
  await git('config', 'hook.example.command', 'true');
  await git('config', 'hook.example.event', 'pre-commit');
  const allowed = vi.fn();
  await expect(
    runApprovedCommit(
      root,
      args,
      { head: null, tree: await git('write-tree'), branch: 'main' },
      limits,
      allowed,
    ),
  ).rejects.toThrow(/file-based Git hooks/);
  expect(allowed).not.toHaveBeenCalled();
  expect(await git('for-each-ref')).toBe('');
});
