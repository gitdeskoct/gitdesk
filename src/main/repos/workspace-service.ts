import { randomUUID } from 'node:crypto';
import {
  lstat,
  readFile,
  readdir,
  readlink,
  realpath,
  stat,
} from 'node:fs/promises';
import path from 'node:path';
import type { ChangedFile, ProgressEvent } from '../../shared/repos';
import type { Settings } from '../../shared/settings';
import {
  HISTORY_PAGE,
  type BranchList,
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
  describeGitError,
  gitAt,
  pathKey,
  STATUS_ARGS,
  WORKSPACE_STATUS_ARGS,
} from './git-inspector';
import { parseStatus } from './git-status';
import type { RepositoryStore } from './repository-store';
import { measureRepository } from './repo-size';
import type { TreeWatcher } from './tree-watcher';

const SIZE_TTL_MS = 30_000;

export class WorkspaceError extends UserError {}

// Desktop integration this service needs, injected so tests run without Electron.
export type WorkspaceDesktop = {
  trashItem(target: string): Promise<void>;
  showItemInFolder(target: string): void;
  openPath(target: string): Promise<string>;
  copyText(text: string): void;
  isOnline(): boolean;
};

// The size guard: past these a diff asks before it loads, so one generated file can't stall the UI.
const MAX_DIFF_CHANGES = 5000;
const MAX_FILE_BYTES = 5 * 1024 * 1024;
const MAX_LINES = 10_000;
const MAX_FULL_LINES = 50_000;
const BATCH = 100;
const COMMIT_TIMEOUT_MS = 120_000;
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

export function classifyFetchError(
  text: string,
): Exclude<Extract<FetchResult, { status: 'failed' }>['reason'], 'cancelled'> {
  if (
    /Authentication failed|could not read Username|terminal prompts disabled|Permission denied \(publickey|returned error: 40[13]|Host key verification failed/i.test(
      text,
    )
  )
    return 'auth';
  if (
    /Could not resolve host|unable to access|Connection (timed out|refused)|Network is unreachable|Could not connect|Operation timed out|timed? ?out|block timeout/i.test(
      text,
    )
  )
    return 'network';
  if (
    /does not appear to be a git repository|Repository not found|not found|No such file or directory/i.test(
      text,
    )
  )
    return 'not-found';
  if (/protocol .* is not allowed|transport '.*' not allowed/i.test(text))
    return 'refused';
  return 'failed';
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
): Exclude<PushFailure, 'cancelled' | 'no-remote' | 'detached'> {
  if (
    /\[rejected\]|\[remote rejected\]|non-fast-forward|fetch first|Updates were rejected|hook declined/i.test(
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
    'Push cancelled. The remote may have received part of it; push again to finish.',
  rejected:
    "The remote refused the push. Usually it has commits this branch doesn't: fetch, merge them in, then push again. gitdesk never force-pushes.",
  'no-remote':
    'This repository has no remote to push to. Add one on the Remotes tab.',
  detached:
    'HEAD is not on a branch, so there is nothing to push. Switch to a branch first.',
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
    type: 'fetched' | 'pushed' | 'branch-created',
    detail: string | null,
  ) => void;
  // Credentials for the account's hosted remote of a linked repository; null for any other URL.
  gitAuth?: (
    remoteId: string,
    url: string,
    scope: 'read' | 'write',
  ) => Promise<Record<string, string> | null>;
  desktop: WorkspaceDesktop;
  settings: () => Settings;
  watcher: TreeWatcher;
  emitProgress?: (event: ProgressEvent) => void;
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
    const whole = parseStatus(await gitRaw(root, WORKSPACE_STATUS_ARGS));
    if (!whole.truncated) return whole.files;
    const seen = new Set(whole.files.map((file) => file.path));
    const rest = paths.filter((p) => !seen.has(p));
    const files = [...whole.files];
    for (let i = 0; i < rest.length; i += BATCH) {
      const output = await gitRaw(root, [
        ...WORKSPACE_STATUS_ARGS,
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
    const target = path.resolve(root, rel);
    const realRoot = await realpath(root);
    const parent = await realpath(path.dirname(target)).catch(() => null);
    const relative = parent ? path.relative(realRoot, parent) : '..';
    if (relative.startsWith('..') || path.isAbsolute(relative))
      throw new WorkspaceError('That file is outside the repository.');
    return target;
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
        return {
          status: 'text',
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
        return { status: 'binary', path: input.path, oldPath: null };
      return {
        status: 'text',
        path: input.path,
        oldPath: null,
        newFile: true,
        deleted: false,
        modeChange: null,
        removed: 0,
        ...untrackedDiff(buffer.toString('utf8'), maxLines),
      };
    }

    const base = ['diff', '--no-ext-diff', '--no-textconv', '--no-color', '-M'];
    if (input.side === 'staged') base.push('--cached');
    if (input.ignoreWhitespace) base.push('-w');
    const paths = [
      '--',
      input.path,
      ...(file!.origPath ? [file!.origPath] : []),
    ];

    if (input.side !== 'conflict') {
      const counts = parseNumstat(
        await gitRaw(root, [...base, '--numstat', '-z', ...paths]),
      );
      if (counts.binary)
        return {
          status: 'binary',
          path: input.path,
          oldPath: file!.origPath ?? null,
        };
      const bytes =
        input.side === 'unstaged'
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
    }
    const parsed = parseDiff(
      await gitRaw(root, [...base, `-U${input.context}`, ...paths]),
      maxLines,
    );
    if (parsed.binary)
      return { status: 'binary', path: input.path, oldPath: parsed.oldPath };
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
    };
  }

  async function inBatches(root: string, command: string[], paths: string[]) {
    for (let i = 0; i < paths.length; i += BATCH)
      await gitRaw(root, [...command, '--', ...paths.slice(i, i + BATCH)]);
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
          const progress = parseGitProgress(line);
          if (progress) deps.emitProgress?.({ jobId, ...progress });
        }
      });
    });
    return git;
  }

  const accountMessage = (err: unknown, fallback: string) =>
    err instanceof UserError ? err.message : fallback;

  async function fetchRemote(
    id: string,
    remote: string,
    jobId: string,
  ): Promise<FetchResult> {
    const root = rootOf(id);
    const remotes = await remoteNames(root);
    if (!remotes.includes(remote) || remote.startsWith('-'))
      throw new WorkspaceError(
        "That remote isn't configured in this repository.",
      );
    if (fetches.has(jobId))
      throw new WorkspaceError('That fetch is already running.');
    let auth;
    try {
      auth = await hostedAuth(id, root, remote, 'read');
    } catch (err) {
      return {
        status: 'failed',
        reason: 'auth',
        message: accountMessage(err, FETCH_MESSAGES.auth),
      };
    }
    const controller = new AbortController();
    fetches.set(jobId, controller);
    // Prune follows the user's own fetch.prune.
    const git = transferGit(
      root,
      jobId,
      controller.signal,
      FETCH_TIMEOUT_MS,
      auth,
    );
    try {
      await git.raw(['fetch', '--progress', '--recurse-submodules=no', remote]);
      deps.addActivity(id, 'fetched', remote);
      return { status: 'fetched', remote, at: now() };
    } catch (err) {
      const reason = controller.signal.aborted
        ? 'cancelled'
        : classifyFetchError(errorText(err));
      return { status: 'failed', reason, message: FETCH_MESSAGES[reason] };
    } finally {
      fetches.delete(jobId);
      await deps.refresh(id).catch(() => undefined);
    }
  }

  // The current branch goes to its upstream when it has one on a configured remote; otherwise to
  // the same name on the default remote, which then becomes its upstream. Never a force push.
  async function pushBranch(id: string, jobId: string): Promise<PushResult> {
    const root = rootOf(id);
    const failed = (
      reason: PushFailure,
      message = PUSH_MESSAGES[reason],
    ): PushResult => ({
      status: 'failed',
      reason,
      message,
    });
    const branch = await currentBranch(root);
    if (!branch) return failed('detached');
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
    const tracked =
      remotes.includes(upstreamRemote) && upstreamRef.startsWith('refs/heads/');
    const remote = tracked ? upstreamRemote : await defaultRemote(id, root);
    if (!remote || remote.startsWith('-')) return failed('no-remote');
    if (pushes.has(jobId))
      throw new WorkspaceError('That push is already running.');
    let auth;
    try {
      auth = await hostedAuth(id, root, remote, 'write');
    } catch (err) {
      return failed('auth', accountMessage(err, PUSH_MESSAGES.auth));
    }
    const controller = new AbortController();
    pushes.set(jobId, controller);
    const git = transferGit(
      root,
      jobId,
      controller.signal,
      PUSH_TIMEOUT_MS,
      auth,
    );
    const target = tracked ? upstreamRef : `refs/heads/${branch}`;
    try {
      await git.raw([
        'push',
        '--progress',
        '--recurse-submodules=no',
        ...(tracked ? [] : ['--set-upstream']),
        remote,
        `refs/heads/${branch}:${target}`,
      ]);
      deps.addActivity(
        id,
        'pushed',
        `${remote}/${target.slice('refs/heads/'.length)}`,
      );
      return { status: 'pushed', remote, branch, at: now() };
    } catch (err) {
      return failed(
        controller.signal.aborted
          ? 'cancelled'
          : classifyPushError(errorText(err)),
      );
    } finally {
      pushes.delete(jobId);
      await deps.refresh(id).catch(() => undefined);
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
        const status = parseStatus(await gitRaw(root, STATUS_ARGS));
        if (status.conflicts > 0)
          throw new WorkspaceError(
            'Resolve the conflicted files first. Stage all would mark them resolved.',
          );
        await gitRaw(root, ['add', '--all']);
        await deps.refresh(id);
      }),

    unstage: (input: PathsInput) =>
      serial(input.id, async () => {
        const root = rootOf(input.id);
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
      serial(input.id, async () => {
        const root = rootOf(input.id);
        const files = await requireChanged(input.id, root, input.paths, [
          'modified',
          'untracked',
        ]);
        const tracked = files
          .filter((f) => f.kind === 'modified')
          .map((f) => f.path);
        if (tracked.length)
          await inBatches(root, ['restore', '--worktree'], tracked);
        for (const file of files.filter((f) => f.kind === 'untracked')) {
          const target = await insideRoot(root, file.path);
          try {
            await deps.desktop.trashItem(target);
          } catch {
            throw new WorkspaceError(
              `Couldn't move ${file.path} to the trash. Nothing else was changed.`,
            );
          }
        }
        await deps.refresh(input.id);
      }),

    commit: (input: CommitInput) =>
      serial(input.id, async (): Promise<CommitResult> => {
        const root = rootOf(input.id);
        const status = parseStatus(await gitRaw(root, STATUS_ARGS));
        if (status.conflicts > 0)
          return { status: 'rejected', reason: 'conflicts', output: null };
        if (status.staged === 0)
          return { status: 'rejected', reason: 'nothing-staged', output: null };
        const description = input.description.trim();
        const message = description
          ? `${input.summary}\n\n${description}`
          : input.summary;
        const args = ['commit', '--quiet', '-m', message];
        if (deps.settings().commitSignoff) args.push('--signoff');
        try {
          await gitAt(root, { timeoutMs: COMMIT_TIMEOUT_MS }).raw(args);
        } catch (err) {
          const text = errorText(err);
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
            return {
              status: 'rejected',
              reason: 'nothing-staged',
              output: null,
            };
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
        } finally {
          await deps.refresh(input.id).catch(() => undefined);
        }
        const oid = (await headOid(root)) ?? '';
        return { status: 'committed', oid, branch: await currentBranch(root) };
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

    fetch: (input: { id: string; remote: string; jobId: string }) =>
      fetchRemote(input.id, input.remote, input.jobId),

    cancelFetch(jobId: string): void {
      fetches.get(jobId)?.abort();
    },

    push: (input: { id: string; jobId: string }) =>
      pushBranch(input.id, input.jobId),

    // Pull request merges, conflict steps and reverts share the per-repository mutation lock.
    serial,
    operationInProgress: (id: string) => operationInProgress(rootOf(id)),
    rootOf,

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
      return (await editors(refresh)).map(({ id, name, location }) => ({
        id,
        name,
        location,
      }));
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
