import { existsSync, realpath } from 'node:fs';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { simpleGit, type SimpleGit } from 'simple-git';
import type { RepoStatus, RepositoryChanges } from '../../shared/repos';
import { UserError } from '../errors';
import { parseLastCommit, parseStatus } from './git-status';

const TIMEOUT_MS = 20_000;

// What Git needs to find itself, the user's config and their identity. Anything else, such as an
// inherited GIT_DIR, GIT_WORK_TREE, GIT_CONFIG_* or EDITOR, is dropped so it can't redirect or
// hijack these commands.
const PASSED_ENV = [
  'PATH',
  'Path',
  'PATHEXT',
  'SystemRoot',
  'SYSTEMROOT',
  'windir',
  'ComSpec',
  'HOME',
  'USERPROFILE',
  'HOMEDRIVE',
  'HOMEPATH',
  'APPDATA',
  'LOCALAPPDATA',
  'ProgramData',
  'ProgramFiles',
  'TEMP',
  'TMP',
  'TMPDIR',
  'LANG',
  'XDG_CONFIG_HOME',
  'SSH_AUTH_SOCK',
  'GNUPGHOME',
  'GIT_AUTHOR_NAME',
  'GIT_AUTHOR_EMAIL',
  'GIT_COMMITTER_NAME',
  'GIT_COMMITTER_EMAIL',
];

function gitEnv(): Record<string, string> {
  const env: Record<string, string> = {};
  for (const key of PASSED_ENV) {
    const value = process.env[key];
    if (value !== undefined) env[key] = value;
  }
  return {
    ...env,
    GIT_OPTIONAL_LOCKS: '0',
    GIT_TERMINAL_PROMPT: '0',
    GCM_INTERACTIVE: 'never',
    LC_ALL: 'C',
  };
}

// Read-only and non-interactive: optional locks off so a background status never blocks your
// editor's commit on index.lock, no credential prompts, a hard timeout, no shell. Arguments are
// fixed here; nothing from the renderer reaches a Git command line.
export function gitAt(dir: string): SimpleGit {
  return simpleGit({
    baseDir: dir,
    maxConcurrentProcesses: 2,
    timeout: { block: TIMEOUT_MS },
    trimmed: false,
    // simple-git blocks GIT_* variables unless named; these are the only ones gitdesk sets.
    allowEnvironment: [
      'GIT_OPTIONAL_LOCKS',
      'GIT_TERMINAL_PROMPT',
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
    ],
  }).env(gitEnv());
}

export class GitError extends UserError {}

// Git's own messages can carry paths and config detail, so the renderer gets one of these instead.
export function describeGitError(err: unknown): string {
  const text = err instanceof Error ? err.message : String(err);
  if (/ENOENT|spawn git|not recognized/i.test(text))
    return "Git isn't installed or isn't on the PATH.";
  if (/dubious ownership|safe\.directory/i.test(text))
    return "Git doesn't trust this folder's owner. Add it to safe.directory to use it.";
  if (/timed? ?out|block timeout/i.test(text))
    return 'Git took too long to answer.';
  if (/not a git repository/i.test(text))
    return "This folder isn't a Git repository.";
  return "Git couldn't read this repository.";
}

// The OS's own resolution (true case on Windows, symlinks followed), so duplicates are caught.
const realpathNative = promisify(realpath.native);
export async function canonicalPath(dir: string): Promise<string> {
  return path.normalize(await realpathNative(dir));
}

// Case-folded where the filesystem usually is, so C:\Repo and c:\repo count as one registration.
export const pathKey = (canonical: string): string =>
  process.platform === 'win32' || process.platform === 'darwin'
    ? canonical.toLowerCase()
    : canonical;

export type RootResult =
  | { kind: 'repository'; root: string }
  | { kind: 'not-a-repository' }
  | { kind: 'bare' };

// The selected folder may be a subfolder: Git reports the real working-tree root.
export async function resolveRoot(dir: string): Promise<RootResult> {
  const git = gitAt(dir);
  try {
    const bare = (await git.raw(['rev-parse', '--is-bare-repository'])).trim();
    if (bare === 'true') return { kind: 'bare' };
    const top = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
    if (!top) return { kind: 'not-a-repository' };
    return { kind: 'repository', root: await canonicalPath(top) };
  } catch (err) {
    if (/not a git repository/i.test(String(err)))
      return { kind: 'not-a-repository' };
    throw new GitError(describeGitError(err));
  }
}

export type Inspection =
  | { availability: 'missing' | 'not-a-repo'; status: null; error: string | null }
  | { availability: 'available'; status: RepoStatus; error: null };

const OPERATION_FILES = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
] as const;

const STATUS_ARGS = [
  'status',
  '--porcelain=v2',
  '--branch',
  '-z',
  '--untracked-files=normal',
];

export async function inspect(root: string): Promise<Inspection> {
  try {
    if (!(await stat(root)).isDirectory()) throw new Error('not a directory');
  } catch {
    return { availability: 'missing', status: null, error: null };
  }
  const git = gitAt(root);
  let raw: string;
  try {
    raw = await git.raw(STATUS_ARGS);
  } catch (err) {
    if (/not a git repository/i.test(String(err)))
      return { availability: 'not-a-repo', status: null, error: null };
    throw new GitError(describeGitError(err));
  }
  const parsed = parseStatus(raw);
  const [log, remotes, gitPaths] = await Promise.all([
    parsed.headOid
      ? git.raw(['log', '-1', '--format=%H%x00%ct%x00%s']).catch(() => '')
      : Promise.resolve(''),
    git.raw(['remote']).catch(() => ''),
    git
      .raw([
        'rev-parse',
        ...OPERATION_FILES.flatMap(([file]) => ['--git-path', file]),
      ])
      .catch(() => ''),
  ]);
  const found = gitPaths
    .split('\n')
    .map((line) => line.trim())
    .map((line, index) =>
      line && existsSync(path.resolve(root, line))
        ? OPERATION_FILES[index]?.[1]
        : undefined,
    )
    .find(Boolean);

  const { files: _files, truncated: _truncated, ...counts } = parsed;
  return {
    availability: 'available',
    error: null,
    status: {
      ...counts,
      operation: found ?? null,
      hasRemotes: remotes.trim().length > 0,
      lastCommit: parseLastCommit(log),
    },
  };
}

export async function listChanges(root: string): Promise<RepositoryChanges> {
  try {
    const { files, truncated } = parseStatus(
      await gitAt(root).raw(STATUS_ARGS),
    );
    return { files, truncated };
  } catch (err) {
    throw new GitError(describeGitError(err));
  }
}
