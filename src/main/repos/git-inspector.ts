import { spawn } from 'node:child_process';
import { existsSync, realpath } from 'node:fs';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';
import type {
  RepoStatus,
  RepositoryChanges,
  RepositoryHistory,
} from '../../shared/repos';
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
    // A file named `*.ts` or `:(top)x` is that file, never a glob or pathspec magic.
    GIT_LITERAL_PATHSPECS: '1',
    GCM_INTERACTIVE: 'never',
    LC_ALL: 'C',
  };
}

// A repository's own .git/config can name programs Git runs during ordinary reads: core.fsmonitor
// runs on `git status` and gpg.program on `git log` when log.showSignature is set. Command-line -c
// beats repository config, so these are turned off for every command gitdesk runs. Color is off so
// a repository's color.ui=always can't put escape codes into parsed output.
export const SAFE_CONFIG = [
  'core.fsmonitor=false',
  'log.showSignature=false',
  'color.ui=false',
  'core.quotePath=false',
];

// The Git gitdesk runs: the one on PATH, or one picked in Settings › Git and checked to answer as Git.
let gitBinary: string | null = null;
export function useGitBinary(binary: string | null): void {
  gitBinary = binary;
}
export const customGitBinary = (): string | null => gitBinary;

// Read-only and non-interactive: optional locks off so a background status never blocks your
// editor's commit on index.lock, no credential prompts, a hard timeout, no shell. Arguments are
// fixed here; nothing from the renderer reaches a Git command line.
export function gitAt(
  dir: string,
  options: Pick<SimpleGitOptions, 'abort' | 'progress'> & {
    config?: string[];
    allowProtocolOverride?: boolean;
    // Inactivity limit; commits get longer because hooks such as linters can run for a while.
    timeoutMs?: number;
    // GIT_CONFIG_* from gitAuthEnv only: credentials for one URL, kept off the command line.
    auth?: Record<string, string>;
  } = {},
): SimpleGit {
  return simpleGit({
    baseDir: dir,
    binary: gitBinary ?? 'git',
    maxConcurrentProcesses: 2,
    timeout: { block: options.timeoutMs ?? TIMEOUT_MS },
    trimmed: false,
    config: [...SAFE_CONFIG, ...(options.config ?? [])],
    abort: options.abort,
    progress: options.progress,
    // simple-git refuses any core.fsmonitor or protocol.* override; these opt-ins only admit the
    // fixed values gitdesk sets itself, which switch those features off or narrow them. A custom
    // binary is a path main picked through a dialog and verified, never a renderer value.
    unsafe: {
      allowUnsafeFsMonitor: true,
      allowUnsafeProtocolOverride: options.allowProtocolOverride ?? false,
      allowUnsafeCustomBinary: gitBinary !== null,
      allowUnsafeConfigEnvCount: options.auth !== undefined,
    },
    // simple-git blocks GIT_* variables unless named; these are the only ones gitdesk sets.
    allowEnvironment: [
      'GIT_OPTIONAL_LOCKS',
      'GIT_TERMINAL_PROMPT',
      'GIT_LITERAL_PATHSPECS',
      'GIT_AUTHOR_NAME',
      'GIT_AUTHOR_EMAIL',
      'GIT_COMMITTER_NAME',
      'GIT_COMMITTER_EMAIL',
      ...(options.auth ? Object.keys(options.auth) : []),
    ],
  }).env({ ...gitEnv(), ...options.auth });
}

export type GitBytes = { code: number | null; stdout: Buffer };

// For output simple-git would mangle: file bytes from cat-file, or NUL-separated lists fed through
// stdin. Same binary, environment and safe config as gitAt; output past maxBytes stops the process.
export function gitBytes(
  dir: string,
  args: string[],
  options: {
    maxBytes: number;
    input?: string;
    timeoutMs?: number;
    // check-ignore refuses literal pathspecs; callers turning it off keep magic out themselves.
    literalPathspecs?: boolean;
  },
): Promise<GitBytes> {
  const env = gitEnv();
  if (options.literalPathspecs === false) delete env.GIT_LITERAL_PATHSPECS;
  return new Promise((resolve, reject) => {
    const child = spawn(
      gitBinary ?? 'git',
      [...SAFE_CONFIG.flatMap((c) => ['-c', c]), ...args],
      {
        cwd: dir,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'ignore'],
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let settled = false;
    const finish = (err: Error | null, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ code, stdout: Buffer.concat(chunks, size) });
    };
    const timer = setTimeout(() => {
      child.kill();
      finish(new GitError('Git took too long to answer.'));
    }, options.timeoutMs ?? TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBytes) {
        child.kill();
        finish(new GitError('Git returned more than gitdesk reads at once.'));
        return;
      }
      chunks.push(chunk);
    });
    child.on('error', (err) => finish(err));
    child.on('close', (code) => finish(null, code));
    child.stdin.on('error', () => undefined);
    child.stdin.end(options.input ?? '');
  });
}

// A bearer token for exactly one https URL, passed as GIT_CONFIG_* so it never appears in the
// process list or .git/config. Redirects are off for that URL so the header can't follow one.
export function gitAuthEnv(url: string, token: string): Record<string, string> {
  return {
    GIT_CONFIG_COUNT: '2',
    GIT_CONFIG_KEY_0: `http.${url}.extraHeader`,
    GIT_CONFIG_VALUE_0: `Authorization: Bearer ${token}`,
    GIT_CONFIG_KEY_1: `http.${url}.followRedirects`,
    GIT_CONFIG_VALUE_1: 'false',
  };
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
  if (/not a git repository|must be run in a work tree/i.test(text))
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
  try {
    // Inside the try: simple-git throws on construction when the folder vanished after picking.
    const git = gitAt(dir);
    const bare = (await git.raw(['rev-parse', '--is-bare-repository'])).trim();
    if (bare === 'true') return { kind: 'bare' };
    const top = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
    if (!top) return { kind: 'not-a-repository' };
    return { kind: 'repository', root: await canonicalPath(top) };
  } catch (err) {
    // Picking the .git folder itself reports "must be run in a work tree".
    if (/not a git repository|must be run in a work tree/i.test(String(err)))
      return { kind: 'not-a-repository' };
    throw new GitError(describeGitError(err));
  }
}

export type Inspection =
  | {
      availability: 'missing' | 'not-a-repo';
      status: null;
      error: string | null;
    }
  | { availability: 'available'; status: RepoStatus; error: null };

const OPERATION_FILES = [
  ['MERGE_HEAD', 'merge'],
  ['rebase-merge', 'rebase'],
  ['rebase-apply', 'rebase'],
  ['CHERRY_PICK_HEAD', 'cherry-pick'],
  ['REVERT_HEAD', 'revert'],
] as const;

export const STATUS_ARGS = [
  'status',
  '--porcelain=v2',
  '--branch',
  '-z',
  '--untracked-files=normal',
];
// The workspace lists every untracked file, not just its new folder, so each can be staged alone.
export const WORKSPACE_STATUS_ARGS = [
  'status',
  '--porcelain=v2',
  '--branch',
  '-z',
  '--untracked-files=all',
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
    // If this folder's own .git is gone but it sits inside another repository, Git would happily
    // report the parent's status. The top level must still be the registered root.
    const top = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
    if (!top || pathKey(await canonicalPath(top)) !== pathKey(root))
      return { availability: 'not-a-repo', status: null, error: null };
    raw = await git.raw(STATUS_ARGS);
  } catch (err) {
    if (/not a git repository|must be run in a work tree/i.test(String(err)))
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
        '--git-path',
        'FETCH_HEAD',
      ])
      .catch(() => ''),
  ]);
  const lines = gitPaths.split('\n').map((line) => line.trim());
  const found = lines
    .slice(0, OPERATION_FILES.length)
    .map((line, index) =>
      line && existsSync(path.resolve(root, line))
        ? OPERATION_FILES[index]?.[1]
        : undefined,
    )
    .find(Boolean);
  const fetchHead = lines[OPERATION_FILES.length];
  const fetchedAt = fetchHead
    ? await stat(path.resolve(root, fetchHead))
        .then((info) => info.mtimeMs)
        .catch(() => null)
    : null;

  const { files: _files, truncated: _truncated, ...counts } = parsed;
  return {
    availability: 'available',
    error: null,
    status: {
      ...counts,
      operation: found ?? null,
      hasRemotes: remotes.trim().length > 0,
      lastCommit: parseLastCommit(log),
      fetchedAt,
    },
  };
}

export const HISTORY_WEEKS = 12;
// Enough for a busy repository's 12 weeks; past it the chart says its counts are a lower bound.
const MAX_LOG_COMMITS = 5000;
const OID = /^[0-9a-f]{40,64}$/;

// Monday 00:00 in local time for the week holding `at`. setDate keeps local midnight across DST.
export function weekStart(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day.getTime();
}

export function bucketWeeks(
  times: number[],
  now: number,
  count = HISTORY_WEEKS,
): RepositoryHistory['weeks'] {
  const weeks: RepositoryHistory['weeks'] = [];
  for (let start = weekStart(now); weeks.length < count; ) {
    weeks.unshift({ start, commits: 0 });
    const previous = new Date(start);
    previous.setDate(previous.getDate() - 7);
    start = previous.getTime();
  }
  for (const at of times) {
    // A commit dated in the future (a skewed clock) counts in the current week.
    for (let i = weeks.length - 1; i >= 0; i--) {
      if (at >= weeks[i]!.start) {
        weeks[i]!.commits++;
        break;
      }
    }
  }
  return weeks;
}

// Read-only history for the details page: what is reachable from HEAD, plus branch counts.
export async function history(
  root: string,
  now = Date.now(),
): Promise<RepositoryHistory> {
  const git = gitAt(root);
  try {
    const top = (await git.raw(['rev-parse', '--show-toplevel'])).trim();
    if (!top || pathKey(await canonicalPath(top)) !== pathKey(root))
      throw new GitError("This folder isn't a Git repository.");
    const [branch, head, refs] = await Promise.all([
      git.raw(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => ''),
      git.raw(['rev-parse', '--verify', '--quiet', 'HEAD']).catch(() => ''),
      git.raw([
        'for-each-ref',
        '--format=%(refname)',
        'refs/heads',
        'refs/remotes',
      ]),
    ]);
    const names = refs.split('\n').filter(Boolean);
    const base = {
      branch: branch.trim() || null,
      localBranches: names.filter((ref) => ref.startsWith('refs/heads/'))
        .length,
      // refs/remotes/<remote>/HEAD only points at another remote branch.
      remoteBranches: names.filter(
        (ref) => ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD'),
      ).length,
    };
    const weeks = bucketWeeks([], now);
    if (!head.trim())
      return {
        ...base,
        commitCount: 0,
        weeks,
        weeksTruncated: false,
        recent: [],
      };

    const since = `${Math.floor(weeks[0]!.start / 1000)} +0000`;
    const [count, times, recent] = await Promise.all([
      git.raw(['rev-list', '--count', 'HEAD']),
      git.raw([
        'log',
        `--since=${since}`,
        `--max-count=${MAX_LOG_COMMITS + 1}`,
        '--format=%ct',
        'HEAD',
      ]),
      git.raw([
        'log',
        '-n',
        '10',
        '--format=%H%x00%ct%x00%an%x00%ae%x00%s',
        'HEAD',
      ]),
    ]);
    const stamps = times
      .split('\n')
      .filter(Boolean)
      .map((line) => Number(line) * 1000);
    return {
      ...base,
      commitCount: Number(count.trim()) || 0,
      weeks: bucketWeeks(stamps.slice(0, MAX_LOG_COMMITS), now),
      weeksTruncated: stamps.length > MAX_LOG_COMMITS,
      recent: recent
        .split('\n')
        .map((line) => line.split('\0'))
        .filter(([oid, at]) => OID.test(oid ?? '') && Number(at) > 0)
        .map(([oid, at, author, email, subject]) => ({
          oid: oid!,
          at: Number(at) * 1000,
          author: (author ?? '').slice(0, 100),
          email: (email ?? '').slice(0, 254),
          subject: (subject ?? '').slice(0, 200),
        })),
    };
  } catch (err) {
    if (err instanceof GitError) throw err;
    throw new GitError(describeGitError(err));
  }
}

export async function listChanges(root: string): Promise<RepositoryChanges> {
  try {
    const { files, truncated } = parseStatus(
      await gitAt(root).raw(WORKSPACE_STATUS_ARGS),
    );
    return { files, truncated };
  } catch (err) {
    throw new GitError(describeGitError(err));
  }
}
