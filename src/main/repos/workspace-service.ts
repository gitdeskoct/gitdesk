import { createHash, randomUUID } from 'node:crypto';
import {
  lstat,
  mkdir,
  readFile,
  readdir,
  readlink,
  stat,
  writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import type { ChangedFile, ProgressEvent } from '../../shared/repos';
import type { Settings } from '../../shared/settings';
import {
  HISTORY_PAGE,
  type ApplySelectionInput,
  type BranchList,
  type CommitIdentity,
  type DiscardResult,
  type SelectionResult,
  type CommitDetail,
  type CommitInput,
  type CommitResult,
  type CommitRow,
  type DetectedEditor,
  type DiffInput,
  type DiffResult,
  type FetchResult,
  type PushResult,
  type HistoryPage,
  type LocalBranch,
  type PathsInput,
  type RemoteBranch,
  type RemoteInfo,
  type RepoConfigInput,
  type RepoGitConfig,
  type RepoPreferences,
  type RepoPreferencesInput,
  type RepositoryAnalytics,
  type RepoSize,
  type AnalyticsRange,
  type SwitchResult,
} from '../../shared/workspace';
import type { DeleteRemoteResult } from '../../shared/branches';
import { UserError } from '../errors';
import {
  detectEditors,
  editorArgs,
  isRunnable,
  launchEditor,
  type FoundEditor,
} from '../editors/editors';
import { parseGitProgress } from './clone-runner';
import { parseDiff, parseNumstat, untrackedDiff } from './git-diff';
import { aggregate, parseLogNumstat, rangeStart } from './git-analytics';
import {
  canonicalPath,
  changesOptions,
  describeGitError,
  gitAt,
  gitBytes,
  pathKey,
  STATUS_ARGS,
  workspaceStatusArgs,
} from './git-inspector';
import { parseStatus } from './git-status';
import { buildPatch, newFilePatch, parsePatch } from './patch-builder';
import { resolveInside } from './paths';
import type { RepositoryStore } from './repository-store';
import { measureRepository } from './repo-size';
import type { TreeWatcher } from './tree-watcher';
import type { SyncCode, SyncOperation } from '../../shared/sync';
import type { Journal } from '../sync/journal';

const SIZE_TTL_MS = 30_000;

export class WorkspaceError extends UserError {}

// Desktop integration this service needs, injected so tests run without Electron.
export type WorkspaceDesktop = {
  trashItem(target: string): Promise<void>;
  showItemInFolder(target: string): void;
  openPath(target: string): Promise<string>;
  copyText(text: string): void;
  isOnline(): boolean;
  // The icon the OS shows for a program, as a PNG data URL.
  fileIcon?(target: string): Promise<string | null>;
};

// Editors that publish no logo file: their installed program's icon stands in.
const ICON_FROM_APP = new Set(['sublime', 'windsurf', 'notepadpp']);

// The size guard: past these a diff asks before it loads, so one generated file can't stall the UI.
const MAX_DIFF_CHANGES = 5000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LINES = 10_000;
const MAX_FULL_LINES = 50_000;
const BATCH = 100;
// Commits run hooks, so they get a long limit; output past the cap stops nothing but is cut.
const COMMIT_TIMEOUT_MS = 300_000;
const MAX_COMMIT_OUTPUT = 16 * 1024 * 1024;
const WRITE_TIMEOUT_MS = 60_000;
const MAX_WRITE_OUTPUT = 1024 * 1024;
const MAX_DIFF_BYTES = 64 * 1024 * 1024;
const BUSY =
  'Another Git process is using this repository, so nothing changed. gitdesk leaves its lock alone; try again when it finishes.';
const REFUSED = {
  empty: 'Pick at least one added or removed line.',
  'new-file': 'This file is new in the index. Unstage the whole file instead.',
  deleted:
    'The file is deleted in your working tree. Discard the whole file to bring it back.',
  renamed: 'A rename is staged, unstaged or discarded as a whole file.',
} as const;
const FETCH_TIMEOUT_MS = 60_000;
// Inactivity limit for a push; Git reports progress while it sends, so only a stall trips it.
const PUSH_TIMEOUT_MS = 120_000;
const MAX_OUTPUT = 4000;
const MAX_ANALYTICS_COMMITS = 5000;
const OID = /^[0-9a-f]{40,64}$/;
const CONFLICT_MARKER = /^(<{7}|>{7})(\s|$)/m;

// Keys in a repository's own config that make Git start a program. Only their names are reported.
const PROGRAM_KEY =
  /^(core\.(sshcommand|hookspath|pager|editor|askpass|fsmonitor|gitproxy)|credential\.(.+\.)?helper|diff\.external|diff\..+\.(textconv|command)|merge\..+\.driver|filter\..+\.(clean|smudge|process)|gpg\.(.+\.)?program|sequence\.editor|remote\..+\.(uploadpack|receivepack)|include\.path|includeif\..+\.path)$/;

// Hook and Git output goes inline under a form: escape codes and control characters are removed,
// the repository's own path is shortened, and the text is capped.
export function sanitizeOutput(text: string, root: string): string | null {
  // These patterns name escape and control characters on purpose: they are what gets removed.
  const clean = text
    // oxlint-disable-next-line no-control-regex
    .replace(/\x1b\[[0-9;?]*[ -/]*[@-~]/g, '')
    // oxlint-disable-next-line no-control-regex
    .replace(/[^\S\n\t ]|[\x00-\x08\x0b-\x1f\x7f]/g, '')
    .split(root)
    .join('.')
    .trim();
  return clean ? clean.slice(-MAX_OUTPUT) : null;
}

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// Display-only remote URLs: no user name or password for http(s), no query or fragment.
export function redactRemoteUrl(
  url: string,
): Omit<RemoteInfo, 'name' | 'pushUrl'> {
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url)) {
    try {
      const parsed = new URL(url);
      const scheme = parsed.protocol.replace(':', '');
      const web = scheme === 'https' || scheme === 'http';
      const hadCredentials = web
        ? !!(parsed.username || parsed.password)
        : !!parsed.password;
      if (web || parsed.password) {
        parsed.username = web ? '' : parsed.username;
        parsed.password = '';
      }
      parsed.search = '';
      parsed.hash = '';
      return {
        fetchUrl: parsed.toString(),
        hadCredentials,
        protocol:
          scheme === 'https' ||
          scheme === 'http' ||
          scheme === 'git' ||
          scheme === 'file'
            ? scheme
            : scheme === 'ssh'
              ? 'ssh'
              : 'other',
      };
    } catch {
      return {
        fetchUrl: '[unreadable URL]',
        hadCredentials: false,
        protocol: 'other',
      };
    }
  }
  // scp-like user@host:path is SSH; anything else is a local path.
  if (/^[^/\\@]+@[^/\\:]+:/.test(url))
    return { fetchUrl: url, hadCredentials: false, protocol: 'ssh' };
  return { fetchUrl: url, hadCredentials: false, protocol: 'file' };
}

// Order matters: an HTTPS 404 also says "unable to access", which must not read as a network fault.
export function classifyFetchError(
  text: string,
): Exclude<Extract<FetchResult, { status: 'failed' }>['reason'], 'cancelled'> {
  if (
    /returned error: 404|Repository not found|repository '.*' not found|does not appear to be a git repository|No such file or directory/i.test(
      text,
    )
  )
    return 'not-found';
  if (
    /Authentication failed|could not read (Username|Password)|terminal prompts disabled|Permission denied \(publickey|returned error: 40[13]|Permission to .* denied|Host key verification failed/i.test(
      text,
    )
  )
    return 'auth';
  if (
    /Could not resolve host|unable to access|Connection (timed out|refused|reset)|Network is unreachable|Could not connect|Operation timed out|timed? ?out|block timeout|returned error: 5\d\d|early EOF|unexpected disconnect/i.test(
      text,
    )
  )
    return 'network';
  if (/protocol .* is not allowed|transport '.*' not allowed/i.test(text))
    return 'refused';
  return 'failed';
}

// The stable code for a failed transfer, from Git's own words.
export function syncCodeFor(reason: PushFailure, text: string): SyncCode {
  switch (reason) {
    case 'auth':
      return /returned error: 403|Permission to .* denied/i.test(text)
        ? 'ACCESS_DENIED'
        : 'AUTH_EXPIRED';
    case 'not-found':
      return 'REPOSITORY_NOT_FOUND';
    case 'network':
      return 'REMOTE_UNAVAILABLE';
    case 'cancelled':
      return 'CANCELLED';
    case 'rejected':
      return /\[remote rejected\]|hook declined|cannot lock ref/i.test(text)
        ? 'REMOTE_REJECTED'
        : 'NON_FAST_FORWARD';
    case 'no-remote':
      return 'NO_REMOTE';
    case 'detached':
      return 'DETACHED';
    case 'unknown':
      return 'OPERATION_RESULT_UNKNOWN';
    default:
      return 'FAILED';
  }
}

const FETCH_MESSAGES: Record<
  Extract<FetchResult, { status: 'failed' }>['reason'],
  string
> = {
  auth: 'Git needs a sign-in for this remote. Fetch once from a terminal so your credential helper or SSH agent has it, then try again here.',
  network: "Couldn't reach the remote. Check your connection and try again.",
  'not-found':
    "The remote didn't answer as a Git repository. Check its URL on the Remotes tab.",
  refused:
    'gitdesk only fetches over HTTPS, SSH and local paths, and this remote uses another transport.',
  cancelled: 'Fetch cancelled. Nothing was changed.',
  failed: "Git couldn't fetch from this remote.",
};

type PushFailure = Extract<PushResult, { status: 'failed' }>['reason'];

export function classifyPushError(
  text: string,
): Exclude<PushFailure, 'cancelled' | 'no-remote' | 'detached' | 'unknown'> {
  if (
    /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|Updates were rejected|hook declined|cannot lock ref/i.test(
      text,
    )
  )
    return 'rejected';
  return classifyFetchError(text);
}

const PUSH_MESSAGES: Record<PushFailure, string> = {
  ...FETCH_MESSAGES,
  failed: "Git couldn't push to this remote.",
  cancelled:
    'Push cancelled before anything was sent. Nothing changed on the remote.',
  rejected:
    "The remote refused the push. Usually it has commits this branch doesn't: fetch, merge them in, then push again. gitdesk never force-pushes.",
  'no-remote':
    'This repository has no remote to push to. Add one on the Remotes tab.',
  detached:
    'HEAD is not on a branch, so there is nothing to push. Switch to a branch first.',
  unknown:
    "The connection ended after the commits were sent, so gitdesk can't tell yet whether the remote took them. Check status asks the remote; nothing is pushed again until then.",
};

// `log --format=%H%x00%P%x00%an%x00%ae%x00%ct%x00%s%x00%D%x1e`, one record per commit.
export function parseCommitRows(output: string): CommitRow[] {
  return output
    .split('\x1e')
    .map((record) => record.replace(/^\n/, '').split('\0'))
    .filter(([oid, , , , at]) => OID.test(oid ?? '') && Number(at) > 0)
    .map(([oid, parents, author, email, at, subject, refs]) => ({
      oid: oid!,
      parents: (parents ?? '').split(' ').filter((p) => OID.test(p)),
      author: (author ?? '').slice(0, 100),
      email: (email ?? '').slice(0, 254),
      at: Number(at) * 1000,
      subject: (subject ?? '').slice(0, 300),
      refs: (refs ?? '')
        .split(', ')
        .map((ref) => ref.replace(/^HEAD -> /, '').trim())
        .filter((ref) => ref && ref !== 'HEAD')
        .slice(0, 10)
        .map((ref) => ref.slice(0, 100)),
    }));
}

// Git's refusal to switch names the files in the way, one per tab-indented line.
export function parseBlockedFiles(text: string): string[] {
  const files: string[] = [];
  let inList = false;
  for (const line of text.split('\n')) {
    if (
      /would be overwritten by (checkout|switch)|untracked working tree files would be/i.test(
        line,
      )
    ) {
      inList = true;
      continue;
    }
    if (inList && line.startsWith('\t')) files.push(line.trim());
    else if (inList && line.trim()) inList = false;
    if (files.length >= 20) break;
  }
  return files;
}

export function createWorkspaceService(deps: {
  store: RepositoryStore;
  refresh: (id: string) => Promise<void>;
  addActivity: (
    id: string,
    type:
      | 'fetched'
      | 'pushed'
      | 'branch-created'
      | 'branch-renamed'
      | 'branch-deleted'
      | 'remote-branch-deleted'
      | 'upstream-set',
    detail: string | null,
  ) => void;
  // Credentials for the account's hosted remote of a linked repository; null for any other URL.
  gitAuth?: (
    remoteId: string,
    url: string,
    scope: 'read' | 'write',
  ) => Promise<Record<string, string> | null>;
  desktop: WorkspaceDesktop;
  // Where Keep a copy of discarded changes writes its patches; off when unset.
  discardDir?: string;
  settings: () => Settings;
  watcher: TreeWatcher;
  emitProgress?: (event: ProgressEvent) => void;
  // Records manual fetches and every push, and each remote's last fetch and push time.
  journal?: Journal;
  // Drops a held token after the server refused it, so the retry mints a fresh one.
  forgetAuth?: (remoteId: string) => void;
  // A push finished; the account is told about pushes to its own Git URL.
  onPushed?: (operation: SyncOperation) => void;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console;
  const chains = new Map<string, Promise<unknown>>();
  const fetches = new Map<string, AbortController>();
  const pushes = new Map<string, AbortController>();
  const analyticsCache = new Map<string, RepositoryAnalytics>();
  const watchCounts = new Map<string, number>();
  let autoFetch: { id: string; timer: NodeJS.Timeout } | null = null;
  let editorsCache: FoundEditor[] | null = null;
  const sizes = new Map<string, RepoSize>();
  const sizing = new Map<string, Promise<RepoSize>>();

  function rootOf(id: string): string {
    const row = deps.store.get(id);
    if (!row)
      throw new WorkspaceError('That repository is no longer in gitdesk.');
    if (row.availability && row.availability !== 'available')
      throw new WorkspaceError('The folder is gone. Locate it again.');
    return row.rootPath;
  }

  // Mutations on one repository run one at a time; a failed one never blocks the next.
  function serial<T>(id: string, fn: () => Promise<T>): Promise<T> {
    const previous = chains.get(id) ?? Promise.resolve();
    const run = previous.catch(() => undefined).then(fn);
    chains.set(id, run);
    const release = () => {
      if (chains.get(id) === run) chains.delete(id);
    };
    // Both paths handled, so a rejection reaches the caller only, never an unhandled branch.
    run.then(release, release);
    return run;
  }

  const statusArgs = () => workspaceStatusArgs(changesOptions(deps.settings()));

  // Another program's index.lock is never touched: writes wait for it to go away.
  async function lockHeld(root: string): Promise<boolean> {
    const lock = (
      await gitAt(root)
        .raw(['rev-parse', '--git-path', 'index.lock'])
        .catch(() => '')
    ).trim();
    return (
      !!lock &&
      (await stat(path.resolve(root, lock)).then(
        () => true,
        () => false,
      ))
    );
  }
  async function assertUnlocked(root: string): Promise<void> {
    if (await lockHeld(root)) throw new WorkspaceError(BUSY);
  }

  // Writes read Git's exit code: simple-git reports a failure with empty stderr as success.
  async function gitWrite(
    root: string,
    args: string[],
    input?: Buffer,
  ): Promise<void> {
    const result = await gitBytes(root, args, {
      maxBytes: MAX_WRITE_OUTPUT,
      input,
      timeoutMs: WRITE_TIMEOUT_MS,
    }).catch((err: unknown) => {
      throw new WorkspaceError(describeGitError(err));
    });
    if (result.code === 0) return;
    if (/index\.lock|Another git process/i.test(result.stderr))
      throw new WorkspaceError(BUSY);
    throw new WorkspaceError(
      sanitizeOutput(result.stderr, root)?.split('\n')[0] ??
        "Git didn't make that change.",
    );
  }

  // Git's patch for one file, as the exact bytes it wrote: the diff view, the staleness token,
  // partial staging and Copy patch all start from this.
  async function diffBytes(
    root: string,
    side: 'staged' | 'unstaged' | 'conflict',
    file: ChangedFile,
    options: { context: number; ignoreWhitespace?: boolean; binary?: boolean },
  ): Promise<Buffer> {
    const args = [
      'diff',
      '--no-ext-diff',
      '--no-textconv',
      '--no-color',
      deps.settings().changesRenames ? '-M' : '--no-renames',
      ...(side === 'staged' ? ['--cached'] : []),
      ...(options.ignoreWhitespace ? ['-w'] : []),
      ...(options.binary ? ['--binary'] : []),
      `-U${options.context}`,
      '--',
      file.path,
      ...(file.origPath ? [file.origPath] : []),
    ];
    const result = await gitBytes(root, args, {
      maxBytes: MAX_DIFF_BYTES,
    }).catch((err: unknown) => {
      throw new WorkspaceError(describeGitError(err));
    });
    if (result.code !== 0)
      throw new WorkspaceError("Git couldn't compare this file.");
    return result.stdout;
  }

  const tokenOf = (side: string, context: number, bytes: Buffer) =>
    createHash('sha1')
      .update(`${side}\0${context}\0`)
      .update(bytes)
      .digest('hex');

  async function blobSize(root: string, spec: string): Promise<number | null> {
    const text = (
      await gitAt(root)
        .raw(['cat-file', '-s', spec])
        .catch(() => '')
    ).trim();
    return /^\d+$/.test(text) ? Number(text) : null;
  }

  // The exact changes a discard would remove, binary files included, for its saved copy.
  async function patchOf(
    root: string,
    command: string[],
    paths: string[],
  ): Promise<Buffer> {
    const result = await gitBytes(
      root,
      [
        ...command,
        '--binary',
        '--no-ext-diff',
        '--no-textconv',
        '--no-color',
        '--',
        ...paths,
      ],
      { maxBytes: MAX_DIFF_BYTES },
    ).catch(() => null);
    if (!result || result.code !== 0)
      throw new WorkspaceError(
        "Couldn't read the changes to keep a copy, so nothing was discarded.",
      );
    return result.stdout;
  }

  // Keeps what a discard throws away as a patch in the app data folder, before Git runs. When
  // the copy can't be written, nothing is discarded.
  async function saveDiscard(
    id: string,
    label: string,
    patch: Buffer,
  ): Promise<boolean> {
    if (!deps.settings().changesKeepDiscarded || !deps.discardDir) return false;
    if (!patch.length) return false;
    const safe = (text: string) =>
      text.replace(/[^\w.-]+/g, '_').slice(0, 80) || 'file';
    const folder = path.join(
      deps.discardDir,
      safe(deps.store.get(id)?.name ?? id),
    );
    const stamp = new Date(now()).toISOString().replace(/[:.]/g, '-');
    try {
      await mkdir(folder, { recursive: true });
      await writeFile(
        path.join(folder, `${stamp}-${safe(path.basename(label))}.patch`),
        patch,
        { flag: 'wx' },
      );
    } catch {
      throw new WorkspaceError(
        "Couldn't save a copy of the changes, so nothing was discarded.",
      );
    }
    return true;
  }

  async function gitRaw(root: string, args: string[]): Promise<string> {
    try {
      return await gitAt(root).raw(args);
    } catch (err) {
      if (/index\.lock|Another git process/i.test(errorText(err)))
        throw new WorkspaceError(
          'Another Git process is using this repository. Try again in a moment.',
        );
      throw new WorkspaceError(describeGitError(err));
    }
  }

  // A fresh status that covers these paths. The whole-tree status comes first because only it pairs
  // both sides of a rename; paths past its file cap are read again by name, as literal pathspecs.
  async function statusOf(
    root: string,
    paths: string[],
  ): Promise<ChangedFile[]> {
    const whole = parseStatus(await gitRaw(root, statusArgs()));
    if (!whole.truncated) return whole.files;
    const seen = new Set(whole.files.map((file) => file.path));
    const rest = paths.filter((p) => !seen.has(p));
    const files = [...whole.files];
    for (let i = 0; i < rest.length; i += BATCH) {
      const output = await gitRaw(root, [
        ...statusArgs(),
        '--',
        ...rest.slice(i, i + BATCH),
      ]);
      files.push(...parseStatus(output).files);
    }
    return files;
  }

  // Every path must be one Git reports right now, in one of the allowed states. Anything else
  // means the list on screen is stale, so it is refreshed and nothing runs.
  async function requireChanged(
    id: string,
    root: string,
    paths: string[],
    kinds: ChangedFile['kind'][],
  ): Promise<ChangedFile[]> {
    const unique = [...new Set(paths)];
    const files = await statusOf(root, unique);
    const matched = unique.map((p) =>
      files.find((file) => file.path === p && kinds.includes(file.kind)),
    );
    if (matched.some((file) => !file)) {
      void deps.refresh(id).catch(() => undefined);
      throw new WorkspaceError(
        'Those changes moved on since the list was read. It has been refreshed.',
      );
    }
    return matched as ChangedFile[];
  }

  // A repository file as an absolute path that stays inside the repository, symlinks included.
  async function insideRoot(root: string, rel: string): Promise<string> {
    const inside = await resolveInside(root, rel);
    if (!inside)
      throw new WorkspaceError('That file is outside the repository.');
    return inside.abs;
  }

  async function diff(input: DiffInput): Promise<DiffResult> {
    const root = rootOf(input.id);
    const kind: ChangedFile['kind'] =
      input.side === 'staged'
        ? 'staged'
        : input.side === 'unstaged'
          ? 'modified'
          : input.side === 'untracked'
            ? 'untracked'
            : 'conflict';
    const [file] = await requireChanged(input.id, root, [input.path], [kind]);
    const maxLines = input.full ? MAX_FULL_LINES : MAX_LINES;

    if (input.side === 'untracked') {
      const target = await insideRoot(root, input.path);
      const info = await lstat(target);
      if (info.isSymbolicLink()) {
        const link = await readlink(target);
        // A symlink is staged whole: its target, not lines of a file.
        return {
          status: 'text',
          token: null,
          path: input.path,
          oldPath: null,
          newFile: true,
          deleted: false,
          modeChange: null,
          removed: 0,
          ...untrackedDiff(link, maxLines),
        };
      }
      if (!info.isFile())
        return { status: 'empty', path: input.path, modeChange: null };
      if (info.size > MAX_FILE_BYTES && !input.full)
        return { status: 'too-large', path: input.path, added: 0, removed: 0 };
      const buffer = await readFile(target);
      if (buffer.subarray(0, 8000).includes(0))
        return {
          status: 'binary',
          path: input.path,
          oldPath: null,
          oldSize: null,
          newSize: info.size,
        };
      const lines = untrackedDiff(buffer.toString('utf8'), maxLines);
      return {
        status: 'text',
        path: input.path,
        oldPath: null,
        newFile: true,
        deleted: false,
        modeChange: null,
        removed: 0,
        ...lines,
        token:
          lines.truncated || input.ignoreWhitespace
            ? null
            : tokenOf('untracked', input.context, buffer),
      };
    }

    const side = input.side;
    const binarySizes = async () => {
      const old = file!.origPath ?? input.path;
      if (side === 'staged')
        return {
          oldSize: await blobSize(root, `HEAD:${old}`),
          newSize: await blobSize(root, `:${input.path}`),
        };
      return {
        oldSize: await blobSize(root, `:${input.path}`),
        newSize: await stat(path.resolve(root, input.path))
          .then((info) => info.size)
          .catch(() => null),
      };
    };

    if (side !== 'conflict') {
      const counts = parseNumstat(
        await gitRaw(root, [
          'diff',
          '--no-ext-diff',
          '--no-textconv',
          '--no-color',
          deps.settings().changesRenames ? '-M' : '--no-renames',
          ...(side === 'staged' ? ['--cached'] : []),
          ...(input.ignoreWhitespace ? ['-w'] : []),
          '--numstat',
          '-z',
          '--',
          input.path,
          ...(file!.origPath ? [file!.origPath] : []),
        ]),
      );
      if (counts.binary)
        return {
          status: 'binary',
          path: input.path,
          oldPath: file!.origPath ?? null,
          ...(await binarySizes()),
        };
      const bytes =
        side === 'unstaged'
          ? await stat(path.resolve(root, input.path))
              .then((info) => info.size)
              .catch(() => 0)
          : 0;
      if (
        !input.full &&
        (counts.added + counts.removed > MAX_DIFF_CHANGES ||
          bytes > MAX_FILE_BYTES)
      )
        return { status: 'too-large', path: input.path, ...counts };
    } else {
      // Conflicted files get the same size guard, measured on the working file.
      const bytes = await stat(path.resolve(root, input.path))
        .then((info) => info.size)
        .catch(() => 0);
      if (!input.full && bytes > MAX_FILE_BYTES)
        return { status: 'too-large', path: input.path, added: 0, removed: 0 };
    }
    const raw = await diffBytes(root, side, file!, {
      context: input.context,
      ignoreWhitespace: input.ignoreWhitespace,
    });
    const parsed = parseDiff(raw.toString('utf8'), maxLines);
    if (parsed.binary)
      return {
        status: 'binary',
        path: input.path,
        oldPath: parsed.oldPath,
        ...(await binarySizes()),
      };
    if (!parsed.hunks.length)
      return {
        status: 'empty',
        path: input.path,
        modeChange: parsed.modeChange,
      };
    return {
      status: 'text',
      path: input.path,
      oldPath: parsed.oldPath ?? file!.origPath ?? null,
      added: parsed.added,
      removed: parsed.removed,
      hunks: parsed.hunks,
      truncated: parsed.truncated,
      newFile: parsed.newFile,
      deleted: parsed.deleted,
      modeChange: parsed.modeChange,
      // Hidden whitespace or a cut-off view can't be mapped back onto Git's own patch.
      token:
        side === 'conflict' ||
        input.ignoreWhitespace ||
        parsed.truncated ||
        file!.submodule
          ? null
          : tokenOf(side, input.context, raw),
    };
  }

  async function inBatches(root: string, command: string[], paths: string[]) {
    for (let i = 0; i < paths.length; i += BATCH)
      await gitWrite(root, [...command, '--', ...paths.slice(i, i + BATCH)]);
  }

  // Staging a conflicted file marks it resolved, so it must not still hold conflict markers.
  async function assertResolved(root: string, rel: string) {
    const target = await insideRoot(root, rel);
    const info = await stat(target).catch(() => null);
    if (!info?.isFile() || info.size > MAX_FILE_BYTES) return;
    if (CONFLICT_MARKER.test(await readFile(target, 'utf8')))
      throw new WorkspaceError(
        `${rel} still has conflict markers. Resolve them in your editor first; staging marks the file resolved.`,
      );
  }

  async function headOid(root: string): Promise<string | null> {
    const oid = (
      await gitAt(root)
        .raw(['rev-parse', '--verify', '--quiet', 'HEAD'])
        .catch(() => '')
    ).trim();
    return OID.test(oid) ? oid : null;
  }

  async function currentBranch(root: string): Promise<string | null> {
    const name = (
      await gitAt(root)
        .raw(['symbolic-ref', '--quiet', '--short', 'HEAD'])
        .catch(() => '')
    ).trim();
    return name || null;
  }

  async function remoteNames(root: string): Promise<string[]> {
    return (await gitRaw(root, ['remote']))
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
  }

  async function branches(id: string): Promise<BranchList> {
    const root = rootOf(id);
    const [current, head, remotes, refs] = await Promise.all([
      currentBranch(root),
      headOid(root),
      remoteNames(root),
      gitRaw(root, [
        'for-each-ref',
        '--sort=-committerdate',
        '--count=1000',
        '--format=%(refname)%00%(objectname)%00%(upstream:short)%00%(upstream:track,nobracket)%00%(HEAD)%00%(committerdate:unix)%00%(worktreepath)%00%(contents:subject)',
        'refs/heads',
        'refs/remotes',
      ]),
    ]);
    const rootKey = pathKey(await canonicalPath(root));
    const local: LocalBranch[] = [];
    const remote: RemoteBranch[] = [];
    const lines = refs.split('\n').filter(Boolean);
    for (const line of lines) {
      const [ref, oid, upstream, track, isHead, date, worktree, subject] =
        line.split('\0');
      if (!ref || !oid || !OID.test(oid)) continue;
      const at = Number(date) > 0 ? Number(date) * 1000 : null;
      if (ref.startsWith('refs/heads/')) {
        const ahead = /ahead (\d+)/.exec(track ?? '');
        const behind = /behind (\d+)/.exec(track ?? '');
        const gone = (track ?? '') === 'gone';
        let otherWorktree = false;
        if (worktree && isHead !== '*') {
          const key = await canonicalPath(worktree)
            .then(pathKey)
            .catch(() => pathKey(worktree));
          otherWorktree = key !== rootKey;
        }
        local.push({
          name: ref.slice('refs/heads/'.length).slice(0, 255),
          oid,
          upstream: upstream ? upstream.slice(0, 255) : null,
          ahead: upstream && !gone ? Number(ahead?.[1] ?? 0) : null,
          behind: upstream && !gone ? Number(behind?.[1] ?? 0) : null,
          gone,
          current: isHead === '*',
          otherWorktree,
          at,
          subject: (subject ?? '').slice(0, 200),
        });
      } else if (ref.startsWith('refs/remotes/') && !ref.endsWith('/HEAD')) {
        const short = ref.slice('refs/remotes/'.length);
        const owner = remotes
          .filter((name) => short.startsWith(`${name}/`))
          .sort((a, b) => b.length - a.length)[0];
        if (!owner) continue;
        remote.push({
          name: short.slice(0, 255),
          remote: owner,
          branch: short.slice(owner.length + 1).slice(0, 255),
          oid,
          at,
          subject: (subject ?? '').slice(0, 200),
          hasLocal: false,
        });
      }
    }
    const localNames = new Set(local.map((b) => b.name));
    for (const branch of remote)
      branch.hasLocal = localNames.has(branch.branch);
    return {
      current,
      detached: !current && !!head,
      headOid: head,
      local,
      remote,
      truncated: lines.length >= 1000,
    };
  }

  async function gitStateExists(root: string, name: string): Promise<boolean> {
    const target = (
      await gitAt(root)
        .raw(['rev-parse', '--git-path', name])
        .catch(() => '')
    ).trim();
    return (
      !!target &&
      stat(path.resolve(root, target)).then(
        () => true,
        () => false,
      )
    );
  }

  async function operationInProgress(root: string): Promise<boolean> {
    const files = [
      'MERGE_HEAD',
      'rebase-merge',
      'rebase-apply',
      'CHERRY_PICK_HEAD',
      'REVERT_HEAD',
    ];
    const paths = (
      await gitAt(root)
        .raw(['rev-parse', ...files.flatMap((f) => ['--git-path', f])])
        .catch(() => '')
    )
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const found = await Promise.all(
      paths.map((p) =>
        stat(path.resolve(root, p)).then(
          () => true,
          () => false,
        ),
      ),
    );
    return found.some(Boolean);
  }

  // Git's own protection decides: a switch that would lose local changes is refused, never forced.
  async function runSwitch(
    id: string,
    root: string,
    args: string[],
    branch: string,
  ): Promise<SwitchResult> {
    try {
      await gitAt(root).raw(args);
    } catch (err) {
      const text = errorText(err);
      if (
        /already (used|checked out) by worktree|is already checked out at/i.test(
          text,
        )
      )
        return { status: 'blocked', reason: 'other-worktree' };
      const files = parseBlockedFiles(text);
      if (
        files.length ||
        /would be overwritten|Please commit your changes or stash them/i.test(
          text,
        )
      )
        return { status: 'blocked', reason: 'local-changes', files };
      if (/already exists/i.test(text))
        return { status: 'blocked', reason: 'exists' };
      throw new WorkspaceError(describeGitError(err));
    } finally {
      await deps.refresh(id).catch(() => undefined);
    }
    return { status: 'switched', branch };
  }

  // Credentials only for the hosted remote of a linked repository, read from its own config.
  async function hostedAuth(
    id: string,
    root: string,
    remote: string,
    scope: 'read' | 'write',
  ): Promise<Record<string, string> | undefined> {
    const remoteId = deps.store.get(id)?.remoteId;
    if (!remoteId || !deps.gitAuth) return undefined;
    const args = [
      'remote',
      'get-url',
      ...(scope === 'write' ? ['--push'] : []),
      remote,
    ];
    const url = (
      await gitAt(root)
        .raw(args)
        .catch(() => '')
    ).trim();
    if (!url) return undefined;
    return (await deps.gitAuth(remoteId, url, scope)) ?? undefined;
  }

  // Fetch and push share one setup: transports that run programs (ext::) are refused, and Git's
  // progress lines become progress events for the job.
  function transferGit(
    root: string,
    jobId: string,
    signal: AbortSignal,
    timeoutMs: number,
    auth: Record<string, string> | undefined,
    onLine?: (line: string) => void,
  ) {
    const git = gitAt(root, {
      abort: signal,
      timeoutMs,
      allowProtocolOverride: true,
      auth,
      config: [
        'protocol.allow=never',
        'protocol.https.allow=always',
        'protocol.ssh.allow=always',
        'protocol.file.allow=always',
      ],
    });
    git.outputHandler((_command, _stdout, stderr) => {
      let pending = '';
      stderr.on('data', (chunk: Buffer) => {
        const lines = (pending + chunk.toString('utf8')).split(/[\r\n]/);
        pending = lines.pop() ?? '';
        for (const line of lines) {
          onLine?.(line);
          const progress = parseGitProgress(line);
          if (progress) deps.emitProgress?.({ jobId, ...progress });
        }
      });
    });
    return git;
  }

  // The remote's tip for one branch, straight from the server; null when it has no such branch.
  async function lsRemote(
    id: string,
    root: string,
    remote: string,
    ref: string,
  ): Promise<string | null> {
    const output = await withHostedRetry(id, root, remote, 'read', (auth) =>
      transferGit(
        root,
        randomUUID(),
        new AbortController().signal,
        FETCH_TIMEOUT_MS,
        auth,
      ).raw(['ls-remote', '--', remote, ref]),
    );
    const oid = output.split('\t')[0]?.trim() ?? '';
    return OID.test(oid) ? oid : null;
  }

  // Runs a transfer with the hosted token. A refused token is dropped and the transfer tried once
  // more with a fresh one, since a revoked or expired token is the usual cause.
  async function withHostedRetry<T>(
    id: string,
    root: string,
    remote: string,
    scope: 'read' | 'write',
    run: (auth: Record<string, string> | undefined) => Promise<T>,
  ): Promise<T> {
    const auth = await hostedAuth(id, root, remote, scope);
    try {
      return await run(auth);
    } catch (err) {
      const remoteId = deps.store.get(id)?.remoteId;
      if (
        !auth ||
        !remoteId ||
        !deps.forgetAuth ||
        !/returned error: 401|Authentication failed/i.test(errorText(err))
      )
        throw err;
      deps.forgetAuth(remoteId);
      return run(await hostedAuth(id, root, remote, scope));
    }
  }

  // Two fetches of one remote would fight over its ref locks, so a second caller shares the first.
  const fetching = new Map<string, Promise<FetchResult>>();

  function fetchRemote(
    id: string,
    remote: string,
    jobId: string,
    options: { record?: boolean } = {},
  ): Promise<FetchResult> {
    const key = `${id}\0${remote}`;
    const running = fetching.get(key);
    if (running) return running;
    const work = runFetch(id, remote, jobId, options).finally(() =>
      fetching.delete(key),
    );
    fetching.set(key, work);
    return work;
  }

  async function runFetch(
    id: string,
    remote: string,
    jobId: string,
    options: { record?: boolean },
  ): Promise<FetchResult> {
    const root = rootOf(id);
    const remotes = await remoteNames(root);
    if (!remotes.includes(remote) || remote.startsWith('-'))
      throw new WorkspaceError(
        "That remote isn't configured in this repository.",
      );
    if (fetches.has(jobId))
      throw new WorkspaceError('That fetch is already running.');
    const opId = options.record
      ? deps.journal?.start({
          repoId: id,
          kind: 'fetch',
          state: 'fetching',
          remote,
        })
      : undefined;
    const controller = new AbortController();
    fetches.set(jobId, controller);
    try {
      // Prune follows the user's own fetch.prune.
      await withHostedRetry(id, root, remote, 'read', (auth) =>
        transferGit(root, jobId, controller.signal, FETCH_TIMEOUT_MS, auth).raw(
          ['fetch', '--progress', '--recurse-submodules=no', remote],
        ),
      );
      deps.addActivity(id, 'fetched', remote);
      deps.journal?.markFetched(id, remote);
      if (opId) deps.journal?.update(opId, { state: 'completed' });
      return { status: 'fetched', remote, at: now() };
    } catch (err) {
      const text = errorText(err);
      // A UserError comes from the account side: no token could be had for the hosted remote.
      const reason = controller.signal.aborted
        ? 'cancelled'
        : err instanceof UserError
          ? 'auth'
          : classifyFetchError(text);
      const code = syncCodeFor(reason, text);
      const message =
        err instanceof UserError ? err.message : FETCH_MESSAGES[reason];
      if (opId)
        deps.journal?.update(opId, {
          state: reason === 'cancelled' ? 'cancelled' : 'failed',
          code,
          message,
        });
      return { status: 'failed', reason, code, message };
    } finally {
      fetches.delete(jobId);
      await deps.refresh(id).catch(() => undefined);
    }
  }

  // The current branch goes to its upstream when it has one on a configured remote; otherwise to
  // the same name on the default remote, which then becomes its upstream. Publish names both the
  // remote and the branch. Never a force push: the remote's own check keeps its newer commits.
  async function pushBranch(
    id: string,
    jobId: string,
    publish?: { remote: string; branch: string },
    // A branch other than the current one, from the Branches tab; its own upstream applies.
    local?: string,
  ): Promise<PushResult> {
    const root = rootOf(id);
    const failed = (
      reason: PushFailure,
      message = PUSH_MESSAGES[reason],
      operationId?: string,
      text = '',
    ): PushResult => ({
      status: 'failed',
      reason,
      code: syncCodeFor(reason, text),
      message,
      ...(operationId ? { operationId } : {}),
    });
    const branch = local ?? (await currentBranch(root));
    if (!branch) return failed('detached');
    const branchOid = local
      ? await refOid(root, `refs/heads/${local}`)
      : await headOid(root);
    if (local && !branchOid)
      throw new WorkspaceError(`${local} no longer exists on this computer.`);
    const config = (key: string) =>
      gitAt(root)
        .raw(['config', '--get', key])
        .then((value) => value.trim())
        .catch(() => '');
    const [upstreamRemote, upstreamRef, remotes] = await Promise.all([
      config(`branch.${branch}.remote`),
      config(`branch.${branch}.merge`),
      remoteNames(root),
    ]);
    if (publish && !remotes.includes(publish.remote))
      throw new WorkspaceError(
        "That remote isn't configured in this repository.",
      );
    const tracked =
      !publish &&
      remotes.includes(upstreamRemote) &&
      upstreamRef.startsWith('refs/heads/');
    const remote = publish
      ? publish.remote
      : tracked
        ? upstreamRemote
        : await defaultRemote(id, root);
    if (!remote || remote.startsWith('-')) return failed('no-remote');
    if (pushes.has(jobId))
      throw new WorkspaceError('That push is already running.');
    const target = publish
      ? `refs/heads/${publish.branch}`
      : tracked
        ? upstreamRef
        : `refs/heads/${branch}`;
    const short = target.slice('refs/heads/'.length);
    const [localOid, trackingOid] = await Promise.all([
      branchOid,
      gitAt(root)
        .raw([
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/remotes/${remote}/${short}`,
        ])
        .then((out) => out.trim() || null)
        .catch(() => null),
    ]);
    const opId = deps.journal?.start({
      repoId: id,
      kind: 'push',
      state: 'pushing',
      remote,
      branch: short,
      oldOid: trackingOid,
      newOid: localOid,
    });
    const controller = new AbortController();
    pushes.set(jobId, controller);
    // Once Git reports writing objects, the remote may have the commits whatever happens next.
    let sent = false;
    const done = (): PushResult => {
      deps.addActivity(id, 'pushed', `${remote}/${short}`);
      deps.journal?.markPushed(id, remote);
      const op = opId
        ? deps.journal?.update(opId, { state: 'completed' })
        : null;
      if (op) deps.onPushed?.(op);
      return {
        status: 'pushed',
        remote,
        branch,
        at: now(),
        ...(opId ? { operationId: opId } : {}),
      };
    };
    try {
      await withHostedRetry(id, root, remote, 'write', (auth) =>
        transferGit(
          root,
          jobId,
          controller.signal,
          PUSH_TIMEOUT_MS,
          auth,
          (line) => {
            if (/^(Writing objects|Total \d+)/.test(line)) sent = true;
          },
        ).raw([
          'push',
          '--progress',
          '--recurse-submodules=no',
          ...(tracked ? [] : ['--set-upstream']),
          remote,
          `refs/heads/${branch}:${target}`,
        ]),
      );
      return done();
    } catch (err) {
      const text = errorText(err);
      let reason: PushFailure = controller.signal.aborted
        ? 'cancelled'
        : err instanceof UserError
          ? 'auth'
          : classifyPushError(text);
      // Cut off after sending: ask the remote what it holds before calling it a failure.
      if (
        sent &&
        (reason === 'cancelled' || reason === 'network' || reason === 'failed')
      ) {
        const tip = await lsRemote(id, root, remote, target).catch(
          () => undefined,
        );
        if (tip !== undefined && tip === localOid) return done();
        if (tip === undefined || tip !== trackingOid) reason = 'unknown';
      }
      const message =
        err instanceof UserError ? err.message : PUSH_MESSAGES[reason];
      if (opId)
        deps.journal?.update(opId, {
          state:
            reason === 'unknown'
              ? 'unknown'
              : reason === 'cancelled'
                ? 'cancelled'
                : 'failed',
          code: syncCodeFor(reason, text),
          message,
        });
      return failed(reason, message, opId, text);
    } finally {
      pushes.delete(jobId);
      await deps.refresh(id).catch(() => undefined);
    }
  }

  async function refOid(root: string, ref: string): Promise<string | null> {
    const oid = (
      await gitAt(root)
        .raw(['rev-parse', '--verify', '--quiet', '--end-of-options', ref])
        .catch(() => '')
    ).trim();
    return OID.test(oid) ? oid : null;
  }

  // Every branch the remote has, straight from the server, without downloading anything.
  async function lsRemoteHeads(
    id: string,
    remote: string,
  ): Promise<Map<string, string>> {
    const root = rootOf(id);
    if (!(await remoteNames(root)).includes(remote) || remote.startsWith('-'))
      throw new WorkspaceError(
        "That remote isn't configured in this repository.",
      );
    const output = await withHostedRetry(id, root, remote, 'read', (auth) =>
      transferGit(
        root,
        randomUUID(),
        new AbortController().signal,
        FETCH_TIMEOUT_MS,
        auth,
      ).raw(['ls-remote', '--heads', '--', remote]),
    );
    const heads = new Map<string, string>();
    for (const line of output.split('\n')) {
      const [oid, ref] = line.trim().split('\t');
      if (oid && ref?.startsWith('refs/heads/') && OID.test(oid))
        heads.set(ref.slice('refs/heads/'.length), oid);
    }
    return heads;
  }

  // Deletes a branch on a remote only while it still points at the commit the person saw, so a
  // push someone made meanwhile is never lost. Journaled like a push and reported to the account.
  async function deleteRemoteBranch(input: {
    id: string;
    remote: string;
    branch: string;
    expectedOid: string;
    jobId: string;
  }): Promise<DeleteRemoteResult> {
    const root = rootOf(input.id);
    if (
      !(await remoteNames(root)).includes(input.remote) ||
      input.remote.startsWith('-') ||
      input.branch.startsWith('-')
    )
      throw new WorkspaceError(
        "That remote isn't configured in this repository.",
      );
    if (pushes.has(input.jobId))
      throw new WorkspaceError('That push is already running.');
    const ref = `refs/heads/${input.branch}`;
    const opId = deps.journal?.start({
      repoId: input.id,
      kind: 'remote-delete',
      state: 'pushing',
      remote: input.remote,
      branch: input.branch,
      oldOid: input.expectedOid,
      newOid: null,
    });
    const controller = new AbortController();
    pushes.set(input.jobId, controller);
    const done = (): DeleteRemoteResult => {
      deps.addActivity(
        input.id,
        'remote-branch-deleted',
        `${input.remote}/${input.branch}`,
      );
      deps.journal?.markPushed(input.id, input.remote);
      const op = opId
        ? deps.journal?.update(opId, { state: 'completed' })
        : null;
      if (op) deps.onPushed?.(op);
      return {
        status: 'deleted',
        remote: input.remote,
        branch: input.branch,
        ...(opId ? { operationId: opId } : {}),
      };
    };
    const failed = (
      reason: Extract<DeleteRemoteResult, { status: 'failed' }>['reason'],
      message: string,
      code: SyncCode,
    ): DeleteRemoteResult => {
      if (opId)
        deps.journal?.update(opId, {
          state:
            reason === 'unknown'
              ? 'unknown'
              : reason === 'cancelled'
                ? 'cancelled'
                : 'failed',
          code,
          message,
        });
      return {
        status: 'failed',
        reason,
        code,
        message,
        ...(opId ? { operationId: opId } : {}),
      };
    };
    try {
      await withHostedRetry(input.id, root, input.remote, 'write', (auth) =>
        transferGit(
          root,
          input.jobId,
          controller.signal,
          PUSH_TIMEOUT_MS,
          auth,
        ).raw([
          'push',
          '--progress',
          '--recurse-submodules=no',
          `--force-with-lease=${ref}:${input.expectedOid}`,
          input.remote,
          `:${ref}`,
        ]),
      );
      return done();
    } catch (err) {
      const text = errorText(err);
      if (/stale info/i.test(text))
        return failed(
          'moved',
          `${input.remote}/${input.branch} moved since you looked, so nothing was deleted. Fetch to see the new commits.`,
          'STALE_REFERENCE',
        );
      if (/remote ref does not exist/i.test(text))
        return failed(
          'not-found',
          `${input.remote} no longer has ${input.branch}. Fetch to update this list.`,
          'STALE_REFERENCE',
        );
      const reason = controller.signal.aborted
        ? 'cancelled'
        : err instanceof UserError
          ? 'auth'
          : classifyPushError(text);
      // Cut off or refused for an unclear reason: the remote's own answer settles it.
      if (reason !== 'auth' && reason !== 'refused') {
        const tip = await lsRemote(input.id, root, input.remote, ref).catch(
          () => undefined,
        );
        if (tip === null) return done();
        if (tip !== undefined && tip !== input.expectedOid)
          return failed(
            'moved',
            `${input.remote}/${input.branch} moved since you looked, so nothing was deleted.`,
            'STALE_REFERENCE',
          );
        if (tip === undefined && reason !== 'rejected')
          return failed(
            'unknown',
            "The connection ended, so gitdesk can't tell whether the branch was deleted. Fetch to find out.",
            'OPERATION_RESULT_UNKNOWN',
          );
      }
      return failed(
        reason === 'rejected' || reason === 'not-found' || reason === 'refused'
          ? 'failed'
          : reason,
        err instanceof UserError
          ? err.message
          : reason === 'rejected'
            ? `${input.remote} refused to delete ${input.branch}.`
            : PUSH_MESSAGES[reason],
        syncCodeFor(reason, text),
      );
    } finally {
      pushes.delete(input.jobId);
      await deps.refresh(input.id).catch(() => undefined);
    }
  }

  function effectivePreferences(id: string): RepoPreferences {
    return deps.store.preferences(id);
  }

  async function defaultRemote(
    id: string,
    root: string,
  ): Promise<string | null> {
    const remotes = await remoteNames(root).catch((): string[] => []);
    const chosen = effectivePreferences(id).defaultRemote;
    if (chosen && remotes.includes(chosen)) return chosen;
    return remotes.includes('origin') ? 'origin' : (remotes[0] ?? null);
  }

  // Automatic fetch: only for the open workspace, only online, never while another fetch runs.
  function scheduleAutoFetch(id: string | null) {
    if (autoFetch) clearInterval(autoFetch.timer);
    autoFetch = null;
    if (!id) return;
    const preference = effectivePreferences(id).autoFetch;
    const minutes =
      preference === 'global' ? deps.settings().autoFetch : preference;
    if (!minutes) return;
    const timer = setInterval(() => {
      if (!deps.desktop.isOnline() || fetches.size > 0) return;
      void (async () => {
        const root = rootOf(id);
        const remote = await defaultRemote(id, root);
        if (remote) await fetchRemote(id, remote, randomUUID());
      })().catch((err) => log.warn('automatic fetch failed', errorText(err)));
    }, minutes * 60_000);
    autoFetch = { id, timer };
  }

  async function editors(refresh: boolean): Promise<FoundEditor[]> {
    if (!editorsCache || refresh) editorsCache = await detectEditors();
    return editorsCache;
  }

  async function readConfig(
    root: string,
    scope: '--local' | '--global',
    key: string,
  ) {
    const value = (
      await gitAt(root)
        .raw(['config', scope, '--get', key])
        .catch(() => '')
    ).trim();
    return value || null;
  }

  const boolOf = (value: string | null) =>
    value === null ? null : /^(true|yes|on|1)$/i.test(value);
  const crlfOf = (value: string | null) =>
    value === 'true' || value === 'input' || value === 'false' ? value : null;

  async function gitConfig(id: string): Promise<RepoGitConfig> {
    const root = rootOf(id);
    const [
      name,
      email,
      gName,
      gEmail,
      prune,
      gPrune,
      crlf,
      gCrlf,
      list,
      hooksDir,
      remotes,
    ] = await Promise.all([
      readConfig(root, '--local', 'user.name'),
      readConfig(root, '--local', 'user.email'),
      readConfig(root, '--global', 'user.name'),
      readConfig(root, '--global', 'user.email'),
      readConfig(root, '--local', 'fetch.prune'),
      readConfig(root, '--global', 'fetch.prune'),
      readConfig(root, '--local', 'core.autocrlf'),
      readConfig(root, '--global', 'core.autocrlf'),
      gitAt(root)
        .raw(['config', '--local', '--list', '-z'])
        .catch(() => ''),
      gitAt(root)
        .raw(['rev-parse', '--git-path', 'hooks'])
        .catch(() => ''),
      remoteNames(root).catch((): string[] => []),
    ]);
    const programs = [
      ...new Set(
        list
          .split('\0')
          .map((entry) => entry.split('\n')[0]!.toLowerCase())
          .filter((key) => PROGRAM_KEY.test(key)),
      ),
    ].slice(0, 20);
    let hooks: string[] = [];
    if (hooksDir.trim()) {
      const dir = path.resolve(root, hooksDir.trim());
      hooks = (await readdir(dir, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isFile() && !entry.name.endsWith('.sample'))
        .map((entry) => entry.name.slice(0, 100))
        .slice(0, 20);
    }
    return {
      identity: { name, email },
      globalIdentity: { name: gName, email: gEmail },
      prune: boolOf(prune),
      globalPrune: boolOf(gPrune),
      autocrlf: crlfOf(crlf),
      globalAutocrlf: crlfOf(gCrlf),
      programs,
      hooks,
      remotes,
    };
  }

  async function setLocal(root: string, key: string, value: string | null) {
    if (value === null)
      // Exit status 5 means it was not set, which is the goal anyway.
      await gitAt(root)
        .raw(['config', '--local', '--unset-all', key])
        .catch(() => undefined);
    else await gitRaw(root, ['config', '--local', key, value]);
  }

  return {
    diff,

    stage: (input: PathsInput) =>
      serial(input.id, async () => {
        const root = rootOf(input.id);
        await assertUnlocked(root);
        const files = await requireChanged(input.id, root, input.paths, [
          'modified',
          'untracked',
          'conflict',
        ]);
        for (const file of files)
          if (file.kind === 'conflict') await assertResolved(root, file.path);
        await inBatches(
          root,
          ['add'],
          files.map((f) => f.path),
        );
        await deps.refresh(input.id);
      }),

    stageAll: (id: string) =>
      serial(id, async () => {
        const root = rootOf(id);
        await assertUnlocked(root);
        const status = parseStatus(await gitRaw(root, STATUS_ARGS));
        if (status.conflicts > 0)
          throw new WorkspaceError(
            'Resolve the conflicted files first. Stage all would mark them resolved.',
          );
        await gitWrite(root, ['add', '--all']);
        await deps.refresh(id);
      }),

    unstage: (input: PathsInput) =>
      serial(input.id, async () => {
        const root = rootOf(input.id);
        await assertUnlocked(root);
        const files = await requireChanged(input.id, root, input.paths, [
          'staged',
        ]);
        // A staged rename is a deletion plus an addition; both sides leave the index together.
        const paths = files.flatMap((f) =>
          f.origPath ? [f.path, f.origPath] : [f.path],
        );
        // An unborn branch has no HEAD to restore from; rm --cached only touches the index.
        if (await headOid(root))
          await inBatches(root, ['restore', '--staged'], paths);
        else await inBatches(root, ['rm', '--cached', '--quiet'], paths);
        await deps.refresh(input.id);
      }),

    // Unstaged edits go back to the staged version; untracked files go to the system trash.
    discard: (input: PathsInput) =>
      serial(input.id, async (): Promise<DiscardResult> => {
        const root = rootOf(input.id);
        await assertUnlocked(root);
        const files = await requireChanged(input.id, root, input.paths, [
          'modified',
          'untracked',
        ]);
        const tracked = files
          .filter((f) => f.kind === 'modified')
          .map((f) => f.path);
        let saved = false;
        if (tracked.length) {
          saved = await saveDiscard(
            input.id,
            tracked.length === 1 ? tracked[0]! : `${tracked.length}-files`,
            await patchOf(root, ['diff'], tracked),
          );
          await inBatches(root, ['restore', '--worktree'], tracked);
        }
        for (const file of files.filter((f) => f.kind === 'untracked')) {
          const target = await insideRoot(root, file.path);
          try {
            await deps.desktop.trashItem(target);
          } catch {
            await deps.refresh(input.id).catch(() => undefined);
            throw new WorkspaceError(
              tracked.length
                ? `Couldn't move ${file.path} to the trash. The tracked files were already discarded.`
                : `Couldn't move ${file.path} to the trash. Nothing else was changed.`,
            );
          }
        }
        await deps.refresh(input.id);
        return { saved };
      }),

    // Back to HEAD for both the index and the working tree, a copy saved first.
    discardAll: (input: PathsInput) =>
      serial(input.id, async (): Promise<DiscardResult> => {
        const root = rootOf(input.id);
        await assertUnlocked(root);
        if (!(await headOid(root)))
          throw new WorkspaceError(
            "There's no commit to go back to yet. Unstage the files, then discard them.",
          );
        const files = await requireChanged(input.id, root, input.paths, [
          'staged',
          'modified',
        ]);
        const paths = [
          ...new Set(
            files.flatMap((f) =>
              f.origPath ? [f.path, f.origPath] : [f.path],
            ),
          ),
        ];
        const saved = await saveDiscard(
          input.id,
          paths.length === 1 ? paths[0]! : `${paths.length}-files`,
          await patchOf(root, ['diff', 'HEAD'], paths),
        );
        await inBatches(
          root,
          ['restore', '--source=HEAD', '--staged', '--worktree'],
          paths,
        );
        await deps.refresh(input.id);
        return { saved };
      }),

    applySelection: (input: ApplySelectionInput) =>
      serial(input.id, async (): Promise<SelectionResult> => {
        const root = rootOf(input.id);
        const refuse = (message: string): SelectionResult => ({
          status: 'rejected',
          reason: 'unsupported',
          message,
        });
        if (await lockHeld(root))
          return { status: 'rejected', reason: 'busy', message: BUSY };
        const kind: ChangedFile['kind'] =
          input.side === 'staged'
            ? 'staged'
            : input.side === 'unstaged'
              ? 'modified'
              : 'untracked';
        const [file] = await requireChanged(
          input.id,
          root,
          [input.path],
          [kind],
        );
        if (file!.submodule)
          return refuse(
            'A submodule is staged as a whole: its new commit, not lines.',
          );

        let text: string;
        if (input.side === 'untracked') {
          const target = await insideRoot(root, input.path);
          const info = await lstat(target);
          if (!info.isFile() || info.size > MAX_FILE_BYTES)
            return refuse('Only a regular text file can be staged in parts.');
          const bytes = await readFile(target);
          if (tokenOf('untracked', input.context, bytes) !== input.token)
            return { status: 'stale' };
          if (bytes.subarray(0, 8000).includes(0))
            return refuse('A binary file is staged as a whole.');
          const executable =
            process.platform !== 'win32' && (info.mode & 0o111) !== 0;
          // The patch is bytes held as latin1, so the name goes in as its UTF-8 bytes.
          text = newFilePatch(
            Buffer.from(input.path, 'utf8').toString('latin1'),
            bytes.toString('latin1'),
            executable ? '100755' : '100644',
          );
        } else {
          const bytes = await diffBytes(root, input.side, file!, {
            context: input.context,
          });
          if (tokenOf(input.side, input.context, bytes) !== input.token)
            return { status: 'stale' };
          text = bytes.toString('latin1');
        }

        const parsed = parsePatch(text);
        if (!parsed)
          return refuse('Git returned no text changes for this file.');
        const reverse = input.action !== 'stage';
        const built = buildPatch(parsed, input.hunks, reverse);
        if ('refused' in built) return refuse(REFUSED[built.refused]);
        const patch = Buffer.from(built.patch, 'latin1');
        const args = [
          'apply',
          ...(input.action === 'discard' ? [] : ['--cached']),
          ...(reverse ? ['-R'] : []),
          '--whitespace=nowarn',
          '--recount',
          ...(input.context === 0 ? ['--unidiff-zero'] : []),
        ];
        // --check first, so a selection Git can't apply changes nothing at all.
        const check = await gitBytes(root, [...args, '--check', '-'], {
          maxBytes: MAX_WRITE_OUTPUT,
          input: patch,
        });
        if (check.code !== 0)
          return /index\.lock/.test(check.stderr)
            ? { status: 'rejected', reason: 'busy', message: BUSY }
            : {
                status: 'rejected',
                reason: 'does-not-apply',
                message:
                  "Git can't apply that selection on its own, so nothing changed. Take the whole change, or edit the file in your editor.",
              };
        const saved =
          input.action === 'discard'
            ? await saveDiscard(input.id, input.path, patch)
            : false;
        await gitWrite(root, [...args, '-'], patch);
        await deps.refresh(input.id).catch(() => undefined);
        return { status: 'applied', saved };
      }),

    copyPatch: async (input: {
      id: string;
      path: string;
      side: 'staged' | 'unstaged';
    }) => {
      const root = rootOf(input.id);
      const [file] = await requireChanged(
        input.id,
        root,
        [input.path],
        [input.side === 'staged' ? 'staged' : 'modified'],
      );
      const bytes = await diffBytes(root, input.side, file!, {
        context: deps.settings().diffContext,
        binary: true,
      });
      if (!bytes.length)
        throw new WorkspaceError('There are no changes in this file to copy.');
      deps.desktop.copyText(bytes.toString('utf8'));
    },

    revealDiscarded: async (id: string | null) => {
      if (!deps.discardDir)
        throw new WorkspaceError('Discarded changes are not kept here.');
      const folder =
        id === null
          ? deps.discardDir
          : path.join(
              deps.discardDir,
              (deps.store.get(id)?.name ?? id)
                .replace(/[^\w.-]+/g, '_')
                .slice(0, 80) || 'file',
            );
      await mkdir(folder, { recursive: true });
      const newest = (await readdir(folder).catch(() => [] as string[]))
        .filter((name) => name.endsWith('.patch'))
        .sort()
        .at(-1);
      if (newest) deps.desktop.showItemInFolder(path.join(folder, newest));
      else await deps.desktop.openPath(folder);
    },

    commitIdentity: async (id: string): Promise<CommitIdentity> => {
      const root = rootOf(id);
      const read = async (key: string) => {
        const line = (
          await gitAt(root)
            .raw(['config', '--show-scope', '--get', key])
            .catch(() => '')
        ).trim();
        const tab = line.indexOf('\t');
        return tab < 0
          ? null
          : {
              scope: line.slice(0, tab),
              value: line.slice(tab + 1).slice(0, 254),
            };
      };
      const [name, email] = await Promise.all([
        read('user.name'),
        read('user.email'),
      ]);
      // Git's own environment overrides win over config, as they do when Git commits.
      const envName = process.env.GIT_AUTHOR_NAME;
      const envEmail = process.env.GIT_AUTHOR_EMAIL;
      const scope =
        envName || envEmail ? 'environment' : (email ?? name)?.scope;
      return {
        name: envName || name?.value || null,
        email: envEmail || email?.value || null,
        scope:
          scope === 'local' ||
          scope === 'global' ||
          scope === 'system' ||
          scope === 'environment'
            ? scope
            : null,
      };
    },

    commit: (input: CommitInput) =>
      serial(input.id, async (): Promise<CommitResult> => {
        const root = rootOf(input.id);
        if (await lockHeld(root))
          return { status: 'rejected', reason: 'busy', output: null };
        const status = parseStatus(await gitRaw(root, STATUS_ARGS));
        if (status.conflicts > 0)
          return { status: 'rejected', reason: 'conflicts', output: null };
        // A rebase or a pick of several commits makes its own commits on Continue.
        const [merging, stepping] = await Promise.all([
          gitStateExists(root, 'MERGE_HEAD'),
          Promise.all(
            ['rebase-merge', 'rebase-apply', 'sequencer'].map((name) =>
              gitStateExists(root, name),
            ),
          ).then((found) => found.some(Boolean)),
        ]);
        if (stepping)
          return { status: 'rejected', reason: 'operation', output: null };
        // A merge whose resolution matches HEAD stages nothing and still needs its commit.
        if (status.staged === 0 && !merging)
          return { status: 'rejected', reason: 'nothing-staged', output: null };
        const description = input.description.trim();
        const message = description
          ? `${input.summary}\n\n${description}`
          : input.summary;
        const args = ['commit', '--quiet', '-m', message];
        if (deps.settings().commitSignoff) args.push('--signoff');
        const before = await headOid(root);
        const result = await gitBytes(root, args, {
          maxBytes: MAX_COMMIT_OUTPUT,
          timeoutMs: COMMIT_TIMEOUT_MS,
        }).catch((err: unknown) => ({
          code: -1,
          stdout: Buffer.alloc(0),
          stderr: errorText(err),
        }));
        const after = await headOid(root);
        await deps.refresh(input.id).catch(() => undefined);
        // Success is a new HEAD, not just exit 0: a hook can fail without a word.
        if (result.code === 0 && after && after !== before)
          return {
            status: 'committed',
            oid: after,
            branch: await currentBranch(root),
          };
        const text = `${result.stderr}\n${result.stdout.toString('utf8')}`;
        const output = sanitizeOutput(text, root);
        if (
          /Please tell me who you are|unable to auto-detect email|empty ident|no email was given/i.test(
            text,
          )
        )
          return { status: 'rejected', reason: 'identity', output: null };
        if (/index\.lock|Another git process/i.test(text))
          return { status: 'rejected', reason: 'busy', output: null };
        if (/nothing (added )?to commit|no changes added/i.test(text))
          return { status: 'rejected', reason: 'nothing-staged', output: null };
        const hooksDir = (
          await gitAt(root)
            .raw(['rev-parse', '--git-path', 'hooks'])
            .catch(() => '')
        ).trim();
        const hooks = hooksDir
          ? await readdir(path.resolve(root, hooksDir)).catch(
              () => [] as string[],
            )
          : [];
        const hook = hooks.some((name) =>
          ['pre-commit', 'commit-msg', 'prepare-commit-msg'].includes(name),
        );
        return {
          status: 'rejected',
          reason: hook ? 'hook' : 'failed',
          output,
        };
      }),

    branches,

    switchBranch: (input: {
      id: string;
      name: string;
      kind: 'local' | 'remote';
    }) =>
      serial(input.id, async (): Promise<SwitchResult> => {
        const root = rootOf(input.id);
        if (await operationInProgress(root))
          return { status: 'blocked', reason: 'operation' };
        const list = await branches(input.id);
        if (input.name.startsWith('-'))
          return { status: 'blocked', reason: 'not-found' };
        if (input.kind === 'local') {
          const branch = list.local.find((b) => b.name === input.name);
          if (!branch) return { status: 'blocked', reason: 'not-found' };
          if (branch.current)
            return { status: 'switched', branch: branch.name };
          if (branch.otherWorktree)
            return { status: 'blocked', reason: 'other-worktree' };
          return runSwitch(
            input.id,
            root,
            ['switch', '--no-guess', branch.name],
            branch.name,
          );
        }
        const branch = list.remote.find((b) => b.name === input.name);
        if (!branch || branch.branch.startsWith('-'))
          return { status: 'blocked', reason: 'not-found' };
        if (branch.hasLocal) return { status: 'blocked', reason: 'exists' };
        return runSwitch(
          input.id,
          root,
          ['switch', '--create', branch.branch, '--track', branch.name],
          branch.branch,
        );
      }),

    createBranch: (input: { id: string; name: string }) =>
      serial(input.id, async (): Promise<SwitchResult> => {
        const root = rootOf(input.id);
        const valid = await gitAt(root)
          .raw(['check-ref-format', '--branch', input.name])
          .then(
            () => true,
            () => false,
          );
        if (!valid)
          throw new WorkspaceError("Git can't use that as a branch name.");
        if ((await branches(input.id)).local.some((b) => b.name === input.name))
          return { status: 'blocked', reason: 'exists' };
        const result = await runSwitch(
          input.id,
          root,
          ['switch', '--create', input.name],
          input.name,
        );
        if (result.status === 'switched')
          deps.addActivity(input.id, 'branch-created', input.name);
        return result;
      }),

    // A fetch someone asked for is journaled; the automatic one only updates the remote's time.
    fetch: (input: { id: string; remote: string; jobId: string }) =>
      fetchRemote(input.id, input.remote, input.jobId, { record: true }),
    fetchQuietly: (id: string, remote: string, jobId: string) =>
      fetchRemote(id, remote, jobId),

    cancelFetch(jobId: string): void {
      fetches.get(jobId)?.abort();
    },

    push: (input: { id: string; jobId: string }) =>
      pushBranch(input.id, input.jobId),

    publish: (input: {
      id: string;
      jobId: string;
      remote: string;
      branch: string;
    }) =>
      pushBranch(input.id, input.jobId, {
        remote: input.remote,
        branch: input.branch,
      }),

    // Tracks a branch that already exists on the remote; the ref must be there after a fetch.
    async setUpstream(input: {
      id: string;
      remote: string;
      branch: string;
    }): Promise<void> {
      const root = rootOf(input.id);
      const branch = await currentBranch(root);
      if (!branch)
        throw new WorkspaceError(
          'HEAD is not on a branch. Switch to one first.',
        );
      if (!(await remoteNames(root)).includes(input.remote))
        throw new WorkspaceError(
          "That remote isn't configured in this repository.",
        );
      const exists = await gitAt(root)
        .raw([
          'rev-parse',
          '--verify',
          '--quiet',
          `refs/remotes/${input.remote}/${input.branch}`,
        ])
        .then((out) => !!out.trim())
        .catch(() => false);
      if (!exists)
        throw new WorkspaceError(
          `${input.remote}/${input.branch} isn't here yet. Fetch ${input.remote} first, or publish the branch instead.`,
        );
      await gitRaw(root, [
        'branch',
        `--set-upstream-to=${input.remote}/${input.branch}`,
        '--',
        branch,
      ]);
      await deps.refresh(input.id).catch(() => undefined);
    },

    lsRemote: (id: string, remote: string, ref: string) =>
      lsRemote(id, rootOf(id), remote, ref),
    lsRemoteHeads,
    deleteRemoteBranch,
    // The Branches tab pushes any local branch the same way Push sends the current one.
    pushLocal: (input: { id: string; name: string; jobId: string }) =>
      pushBranch(input.id, input.jobId, undefined, input.name),

    // Pull request merges, conflict steps and reverts share the per-repository mutation lock.
    serial,
    operationInProgress: (id: string) => operationInProgress(rootOf(id)),
    rootOf,
    // For the sync and move services, which run their own transfers with the same protections.
    transferGit,
    hostedAuth,
    remoteNames,
    currentBranch,
    headOid,

    cancelPush(jobId: string): void {
      pushes.get(jobId)?.abort();
    },

    async remotes(id: string): Promise<RemoteInfo[]> {
      const root = rootOf(id);
      const output = await gitRaw(root, ['remote', '-v']);
      const byName = new Map<string, { fetch?: string; push?: string }>();
      for (const line of output.split('\n')) {
        const match = /^(\S+)\t(.+) \((fetch|push)\)$/.exec(line.trim());
        if (!match) continue;
        const entry = byName.get(match[1]!) ?? {};
        entry[match[3] as 'fetch' | 'push'] = match[2]!;
        byName.set(match[1]!, entry);
      }
      return [...byName.entries()].slice(0, 50).map(([name, urls]) => {
        const fetchInfo = redactRemoteUrl(urls.fetch ?? urls.push ?? '');
        const pushInfo =
          urls.push && urls.push !== urls.fetch
            ? redactRemoteUrl(urls.push)
            : null;
        return {
          name: name.slice(0, 255),
          ...fetchInfo,
          pushUrl: pushInfo?.fetchUrl ?? null,
          hadCredentials:
            fetchInfo.hadCredentials || !!pushInfo?.hadCredentials,
        };
      });
    },

    async log(input: {
      id: string;
      oid: string | null;
      skip: number;
    }): Promise<HistoryPage> {
      const root = rootOf(input.id);
      const snapshot = input.oid ?? (await headOid(root));
      if (!snapshot) return { snapshot: null, commits: [], nextSkip: null };
      const exists = await gitAt(root)
        .raw(['cat-file', '-e', `${snapshot}^{commit}`])
        .then(
          () => true,
          () => false,
        );
      if (!exists)
        throw new WorkspaceError(
          'That history was rewritten. Show the latest instead.',
        );
      const output = await gitRaw(root, [
        'log',
        '--format=%H%x00%P%x00%an%x00%ae%x00%ct%x00%s%x00%D%x1e',
        `--max-count=${HISTORY_PAGE + 1}`,
        `--skip=${input.skip}`,
        snapshot,
        '--',
      ]);
      const commits = parseCommitRows(output);
      return {
        snapshot,
        commits: commits.slice(0, HISTORY_PAGE),
        nextSkip:
          commits.length > HISTORY_PAGE ? input.skip + HISTORY_PAGE : null,
      };
    },

    async commitDetail(input: {
      id: string;
      oid: string;
    }): Promise<CommitDetail> {
      const root = rootOf(input.id);
      const output = await gitRaw(root, [
        'show',
        '--no-ext-diff',
        '--no-textconv',
        '--numstat',
        '-z',
        '-M',
        '--format=%H%x00%P%x00%an%x00%ae%x00%ct%x00%B%x00',
        input.oid,
        '--',
      ]);
      const tokens = output.split('\0');
      const [oid, parents, author, email, at, body] = tokens;
      if (!oid || !OID.test(oid))
        throw new WorkspaceError("That commit isn't in this repository.");
      const files: CommitDetail['files'] = [];
      let truncated = false;
      for (let i = 6; i < tokens.length; i++) {
        const token = tokens[i]!.replace(/^\n+/, '');
        const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token);
        if (!match) continue;
        let file = match[3]!;
        let oldPath: string | null = null;
        if (file === '') {
          oldPath = tokens[++i] ?? null;
          file = tokens[++i] ?? '';
        }
        if (!file) continue;
        if (files.length >= 500) {
          truncated = true;
          break;
        }
        files.push({
          path: file.slice(0, 4096),
          oldPath: oldPath?.slice(0, 4096) ?? null,
          added: match[1] === '-' ? null : Number(match[1]),
          removed: match[2] === '-' ? null : Number(match[2]),
        });
      }
      return {
        oid,
        parents: (parents ?? '').split(' ').filter((p) => OID.test(p)),
        author: (author ?? '').slice(0, 100),
        email: (email ?? '').slice(0, 254),
        at: Number(at) * 1000,
        message: (body ?? '').trimEnd().slice(0, 10_000),
        files,
        filesTruncated: truncated,
      };
    },

    // Cached per head commit and range, so tabs and tooltips never walk history twice.
    async analytics(input: {
      id: string;
      range: AnalyticsRange;
    }): Promise<RepositoryAnalytics> {
      const root = rootOf(input.id);
      const head = await headOid(root);
      const day = new Date(now()).toDateString();
      const key = `${input.id}:${head}:${input.range}:${day}`;
      const cached = analyticsCache.get(key);
      if (cached) return cached;
      const branch = await currentBranch(root);
      const options = { range: input.range, now: now(), branch, headOid: head };
      if (!head) {
        return aggregate([], { ...options, totalCommits: 0, truncated: false });
      }
      const since = Math.floor(rangeStart(input.range, now()) / 1000);
      const [count, output] = await Promise.all([
        gitRaw(root, ['rev-list', '--count', head]),
        gitRaw(root, [
          'log',
          `--since=${since} +0000`,
          `--max-count=${MAX_ANALYTICS_COMMITS + 1}`,
          '-z',
          '-M',
          '--numstat',
          '--no-textconv',
          '--format=%x1e%H%x00%ct%x00%an%x00%ae',
          head,
          '--',
        ]),
      ]);
      const entries = parseLogNumstat(output);
      const result = aggregate(entries.slice(0, MAX_ANALYTICS_COMMITS), {
        ...options,
        totalCommits: Number(count.trim()) || 0,
        truncated: entries.length > MAX_ANALYTICS_COMMITS,
      });
      if (analyticsCache.size > 20) analyticsCache.clear();
      analyticsCache.set(key, result);
      return result;
    },

    async revealFile(input: { id: string; path: string }): Promise<void> {
      const root = rootOf(input.id);
      await requireChanged(
        input.id,
        root,
        [input.path],
        ['modified', 'staged', 'untracked', 'conflict'],
      );
      deps.desktop.showItemInFolder(await insideRoot(root, input.path));
    },

    async copyFilePath(input: { id: string; path: string }): Promise<void> {
      const root = rootOf(input.id);
      deps.desktop.copyText(await insideRoot(root, input.path));
    },

    watch(id: string): void {
      const root = rootOf(id);
      watchCounts.set(id, (watchCounts.get(id) ?? 0) + 1);
      if (deps.settings().watchRepositories) deps.watcher.watch(id, root);
      scheduleAutoFetch(id);
    },

    unwatch(id: string): void {
      const count = (watchCounts.get(id) ?? 1) - 1;
      if (count > 0) return void watchCounts.set(id, count);
      watchCounts.delete(id);
      deps.watcher.unwatch(id);
      if (autoFetch?.id === id) scheduleAutoFetch(null);
    },

    // Settings changed: the open workspace's watcher and automatic fetch follow them.
    applySettings(): void {
      const id = [...watchCounts.keys()].at(-1) ?? null;
      if (!id) return;
      const row = deps.store.get(id);
      if (row && deps.settings().watchRepositories)
        deps.watcher.watch(id, row.rootPath);
      else deps.watcher.unwatch(id);
      scheduleAutoFetch(id);
    },

    async editors(refresh: boolean): Promise<DetectedEditor[]> {
      return Promise.all(
        (await editors(refresh)).map(async ({ id, name, location, exe }) => ({
          id,
          name,
          location,
          // Only editors without a published logo need the installed program's icon.
          icon:
            ICON_FROM_APP.has(id) && deps.desktop.fileIcon
              ? await deps.desktop.fileIcon(exe).catch(() => null)
              : null,
        })),
      );
    },

    async openInEditor(input: {
      id: string;
      path: string | null;
      line: number | null;
    }): Promise<void> {
      const root = rootOf(input.id);
      const file = input.path ? await insideRoot(root, input.path) : null;
      if (
        file &&
        !(await stat(file).then(
          (info) => info.isFile(),
          () => false,
        ))
      )
        throw new WorkspaceError('That file is no longer there.');
      const settings = deps.settings();
      const chosen = effectivePreferences(input.id).editor ?? settings.editor;
      if (chosen !== 'system') {
        const editor = (await editors(false)).find((e) => e.id === chosen);
        if (!editor)
          throw new WorkspaceError(
            "That editor wasn't found on this computer any more. Pick another in Settings, Workspace.",
          );
        const args = editorArgs(
          editor.family,
          { folder: root, file, line: input.line },
          {
            gotoLine: settings.editorGotoLine,
            openFolder: settings.editorOpenFolder,
          },
        );
        launchEditor(editor, args, (err) =>
          log.warn('editor failed to start', err.message),
        );
        return;
      }
      if (file && isRunnable(file)) return deps.desktop.showItemInFolder(file);
      const error = await deps.desktop.openPath(file ?? root);
      if (error)
        throw new WorkspaceError(
          "Couldn't open it with the system default app.",
        );
    },

    gitConfig,

    async setGitConfig(input: RepoConfigInput): Promise<RepoGitConfig> {
      return serial(input.id, async () => {
        const root = rootOf(input.id);
        if (input.identity !== undefined) {
          await setLocal(root, 'user.name', input.identity?.name ?? null);
          await setLocal(root, 'user.email', input.identity?.email ?? null);
        }
        if (input.prune !== undefined)
          await setLocal(
            root,
            'fetch.prune',
            input.prune === null ? null : String(input.prune),
          );
        if (input.autocrlf !== undefined)
          await setLocal(root, 'core.autocrlf', input.autocrlf);
        return gitConfig(input.id);
      });
    },

    preferences(id: string): RepoPreferences {
      rootOf(id);
      return effectivePreferences(id);
    },

    setPreferences(input: RepoPreferencesInput): RepoPreferences {
      rootOf(input.id);
      const { id, ...patch } = input;
      const next = { ...effectivePreferences(id), ...patch } as RepoPreferences;
      deps.store.savePreferences(id, next, now());
      if (autoFetch?.id === id || watchCounts.has(id)) scheduleAutoFetch(id);
      return next;
    },

    // Status changes ask often; the folder is walked again at most every 30 seconds unless forced,
    // and two callers asking at once share one walk.
    async size(input: { id: string; force: boolean }): Promise<RepoSize> {
      const root = rootOf(input.id);
      const cached = sizes.get(input.id);
      if (cached && !input.force && now() - cached.measuredAt < SIZE_TTL_MS)
        return cached;
      const running = sizing.get(input.id);
      if (running) return running;
      const job = measureRepository(root, now)
        .then((result) => {
          sizes.set(input.id, result);
          return result;
        })
        .finally(() => sizing.delete(input.id));
      sizing.set(input.id, job);
      return job;
    },

    dispose(): void {
      for (const controller of fetches.values()) controller.abort();
      for (const controller of pushes.values()) controller.abort();
      scheduleAutoFetch(null);
      deps.watcher.dispose();
    },
  };
}

export type WorkspaceService = ReturnType<typeof createWorkspaceService>;
