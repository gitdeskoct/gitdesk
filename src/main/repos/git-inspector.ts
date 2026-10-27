import { execFile, spawn, type ChildProcess } from 'node:child_process';
import { existsSync, realpath } from 'node:fs';
import { stat } from 'node:fs/promises';
import { promisify } from 'node:util';
import path from 'node:path';
import { simpleGit, type SimpleGit, type SimpleGitOptions } from 'simple-git';
import type {
  ChangedFile,
  RepoStatus,
  RepositoryChanges,
  RepositoryHistory,
} from '../../shared/repos';
import { UserError } from '../errors';
import { resolveInside } from './paths';
import {
  MAX_CHANGES_FILES,
  parseLastCommit,
  parseNumstatAll,
  parseStatus,
} from './git-status';

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
  versionCheck = null;
}

// git restore needs 2.23 and config --show-scope 2.26; an older Git would fail mid-operation.
export const MIN_GIT_VERSION = '2.26.0';
export function versionAtLeast(version: string, minimum: string): boolean {
  const parts = (text: string) => {
    const match = /^(\d+)\.(\d+)(?:\.(\d+))?/.exec(text);
    return match ? [match[1], match[2], match[3] ?? '0'].map(Number) : null;
  };
  const have = parts(version);
  const need = parts(minimum);
  if (!have || !need) return false;
  for (let i = 0; i < 3; i++)
    if (have[i] !== need[i]) return have[i]! > need[i]!;
  return true;
}

// Checked once per Git binary. A missing Git is left to the command that needs it, whose error
// already says so; only a Git that answers with an old version is refused here.
let versionCheck: Promise<string | null> | null = null;
export async function assertGitVersion(): Promise<void> {
  versionCheck ??= gitBytes(process.cwd(), ['--version'], {
    maxBytes: 1000,
    timeoutMs: 5000,
  })
    .then(
      (r) => /^git version (\S+)/.exec(r.stdout.toString('utf8'))?.[1] ?? null,
    )
    .catch(() => null);
  const version = await versionCheck;
  if (version && !versionAtLeast(version, MIN_GIT_VERSION))
    throw new GitError(
      `Git ${version.slice(0, 40)} is too old. gitdesk needs Git ${MIN_GIT_VERSION} or newer.`,
    );
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

export type GitBytes = { code: number | null; stdout: Buffer; stderr: string };

// taskkill by its full path, so a taskkill.exe earlier on PATH can't stand in for it.
const TASKKILL = path.join(
  process.env.SystemRoot ?? 'C:\\Windows',
  'System32',
  'taskkill.exe',
);

// On Windows child.kill() ends git.exe but not the hooks and helpers it started, which would keep
// running unsupervised after a timeout. /T ends the whole tree.
export function stopTree(
  child: Pick<ChildProcess, 'pid' | 'kill'>,
  platform: NodeJS.Platform = process.platform,
  run: typeof execFile = execFile,
): void {
  if (platform !== 'win32' || !child.pid) {
    child.kill();
    return;
  }
  run(
    TASKKILL,
    ['/pid', String(child.pid), '/T', '/F'],
    { windowsHide: true, timeout: 5000 },
    (err) => {
      if (err) child.kill();
    },
  );
}

// For output simple-git would mangle (file bytes, NUL-separated lists, exact patches) and for writes
// whose exit code matters: simple-git reports a non-zero exit with empty stderr as success.
// Same binary, environment and safe config as gitAt; output past maxBytes stops the process.
export function gitBytes(
  dir: string,
  args: string[],
  options: {
    maxBytes: number;
    input?: string | Buffer;
    timeoutMs?: number;
    // Commands that would open an editor (continue, revert) accept the prepared message instead.
    noEditor?: boolean;
    // check-ignore refuses literal pathspecs; callers turning it off keep magic out themselves.
    literalPathspecs?: boolean;
  },
): Promise<GitBytes> {
  const env = gitEnv();
  if (options.literalPathspecs === false) delete env.GIT_LITERAL_PATHSPECS;
  if (options.noEditor) {
    env.GIT_EDITOR = 'true';
    env.GIT_SEQUENCE_EDITOR = 'true';
  }
  return new Promise((resolve, reject) => {
    const child = spawn(
      gitBinary ?? 'git',
      [...SAFE_CONFIG.flatMap((c) => ['-c', c]), ...args],
      {
        cwd: dir,
        env,
        shell: false,
        windowsHide: true,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    );
    const chunks: Buffer[] = [];
    let size = 0;
    let stderr = '';
    let settled = false;
    const finish = (err: Error | null, code: number | null = null) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (err) reject(err);
      else resolve({ code, stdout: Buffer.concat(chunks, size), stderr });
    };
    const timer = setTimeout(() => {
      stopTree(child);
      finish(new GitTimeout('Git took too long to answer.'));
    }, options.timeoutMs ?? TIMEOUT_MS);
    child.stdout.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > options.maxBytes) {
        stopTree(child);
        finish(new GitError('Git returned more than gitdesk reads at once.'));
        return;
      }
      chunks.push(chunk);
    });
    child.stderr.on('data', (chunk: Buffer) => {
      if (stderr.length < 16_000) stderr += chunk.toString('utf8');
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

// Store a bounded token through Git's configured credential helper so a terminal can use plain
// `git push`. No credential is written by gitdesk itself.
export async function approveGitCredential(
  dir: string,
  url: string,
  token: string,
): Promise<void> {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password)
    throw new GitError('The hosted Git URL is not safe for credential storage.');
  const helper = await gitAt(dir)
    .raw(['config', '--get-all', 'credential.helper'])
    .catch(() => '');
  if (!helper.trim())
    throw new GitError(
      'Git has no credential helper configured. Configure one before copying a terminal push command.',
    );
  const input = [
    'protocol=https',
    `host=${parsed.host}`,
    `path=${parsed.pathname.replace(/^\/+/, '')}`,
    'username=x',
    `password=${token}`,
    '',
    '',
  ].join('\n');
  const result = await gitBytes(dir, ['credential', 'approve'], {
    maxBytes: 1000,
    input,
  });
  if (result.code !== 0)
    throw new GitError(
      'Git could not save the hosted remote credential in its credential helper.',
    );
}

export class GitError extends UserError {}
export class GitTimeout extends GitError {}

// Status output grows with the tree; a huge untracked folder stops being read past this.
const STATUS_BYTES = 32 * 1024 * 1024;

// `git status` through gitBytes: bounded output and a real exit code.
export async function readStatus(
  root: string,
  args: string[],
): Promise<string> {
  const result = await gitBytes(root, args, { maxBytes: STATUS_BYTES });
  if (result.code !== 0) throw new GitError(describeGitError(result.stderr));
  return result.stdout.toString('utf8');
}

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
// How the Changes list asks Git (Settings › Git › Changes and staging). By default every untracked
// file is listed on its own, not just its new folder, so each can be staged alone.
export type ChangesOptions = {
  untracked: 'all' | 'normal';
  renames: boolean;
  submodules: 'none' | 'dirty' | 'all';
};
export const DEFAULT_CHANGES_OPTIONS: ChangesOptions = {
  untracked: 'all',
  renames: true,
  submodules: 'none',
};
export function workspaceStatusArgs(
  options: ChangesOptions = DEFAULT_CHANGES_OPTIONS,
): string[] {
  return [
    'status',
    '--porcelain=v2',
    '--branch',
    '-z',
    `--untracked-files=${options.untracked}`,
    options.renames ? '--find-renames' : '--no-renames',
    `--ignore-submodules=${options.submodules}`,
  ];
}
export const WORKSPACE_STATUS_ARGS = workspaceStatusArgs();
export const changesOptions = (settings: {
  changesUntracked: ChangesOptions['untracked'];
  changesRenames: boolean;
  changesSubmodules: ChangesOptions['submodules'];
}): ChangesOptions => ({
  untracked: settings.changesUntracked,
  renames: settings.changesRenames,
  submodules: settings.changesSubmodules,
});

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
    raw = await readStatus(root, STATUS_ARGS);
  } catch (err) {
    if (
      /not a git repository|must be run in a work tree|isn't a Git repository/i.test(
        String(err),
      )
    )
      return { availability: 'not-a-repo', status: null, error: null };
    if (err instanceof GitError) throw err;
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

  const {
    files: _files,
    truncated: _truncated,
    total: _total,
    ...counts
  } = parsed;
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
  for (let start = weekStart(now); weeks.length < count;) {
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

export async function listChanges(
  root: string,
  options: ChangesOptions = DEFAULT_CHANGES_OPTIONS,
): Promise<RepositoryChanges> {
  try {
    await assertGitVersion();
    const git = gitAt(root);
    const { files, truncated, total } = parseStatus(
      await readStatus(root, workspaceStatusArgs(options)),
      MAX_CHANGES_FILES,
    );
    // Each side's line counts come from that side's own comparison: Index → Working tree for
    // unstaged rows, HEAD → Index for staged ones. Counts are a nicety, so a failure leaves them out.
    const numstat = (cached: boolean) =>
      git
        .raw([
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          options.renames ? '-M' : '--no-renames',
          `--ignore-submodules=${options.submodules}`,
          ...(cached ? ['--cached'] : []),
          '--numstat',
          '-z',
        ])
        .then(parseNumstatAll)
        .catch(() => new Map<string, never>());
    const [unstaged, staged] = await Promise.all([
      files.some((f) => f.kind === 'modified') ? numstat(false) : new Map(),
      files.some((f) => f.kind === 'staged') ? numstat(true) : new Map(),
    ]);
    for (const file of files) {
      const counts = (file.kind === 'staged' ? staged : unstaged).get(
        file.path,
      );
      if (counts && file.kind !== 'conflict' && file.kind !== 'untracked')
        Object.assign(file, counts);
    }
    await binarySizes(root, files);
    return { files, truncated, total };
  } catch (err) {
    if (err instanceof GitError) throw err;
    throw new GitError(describeGitError(err));
  }
}

// At most this many binary rows get a size; each is one cat-file line or one stat.
const MAX_SIZED = 200;

// Binary files have no line counts, so the list shows their size instead: the index blob for a
// staged row (one cat-file for all of them), the file on disk otherwise. Unknown stays null.
async function binarySizes(root: string, files: ChangedFile[]): Promise<void> {
  const binary = files
    .filter((f) => f.binary && (f.kind === 'staged' || f.kind === 'modified'))
    .slice(0, MAX_SIZED);
  // cat-file reads one name per line, so a path with a line break gets no size.
  const staged = binary.filter(
    (f) => f.kind === 'staged' && !/[\r\n]/.test(f.path),
  );
  if (staged.length) {
    const result = await gitBytes(
      root,
      ['cat-file', '--batch-check=%(objectsize)'],
      {
        maxBytes: 64 * 1024,
        input: staged.map((f) => `:${f.path}\n`).join(''),
      },
    ).catch(() => null);
    const lines = result?.stdout.toString('utf8').split('\n') ?? [];
    staged.forEach((file, i) => {
      file.size = /^\d+$/.test(lines[i] ?? '') ? Number(lines[i]) : null;
    });
  }
  await Promise.all(
    binary
      .filter((f) => f.kind === 'modified')
      .map(async (file) => {
        const inside = await resolveInside(root, file.path);
        file.size = inside
          ? await stat(inside.abs)
              .then((info) => (info.isFile() ? info.size : null))
              .catch(() => null)
          : null;
      }),
  );
}
