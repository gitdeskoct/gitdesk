import { randomBytes, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, rmdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import type {
  AddRepositoryResult,
  CreateRepositoryInput,
  CreateRepositoryResult,
  LocalActivity,
  RemoteRepository,
  RepositoryChanges,
  RepositorySummary,
} from '../../shared/repos';
import type { Settings } from '../../shared/settings';
import { UserError } from '../errors';
import type { RemoteService } from '../remote/remote-service';
import {
  canonicalPath,
  describeGitError,
  gitAt,
  GitError,
  inspect,
  listChanges,
  pathKey,
  resolveRoot,
} from './git-inspector';
import type { RepoRow, RepositoryStore } from './repository-store';

// Desktop integration the service needs, injected so tests can drive it without Electron.
export type Desktop = {
  pickDirectory(options: { title: string; create: boolean }): Promise<string | null>;
  openPath(target: string): Promise<string>;
  copyText(text: string): void;
};

const CONCURRENCY = 3;
const MAX_REPOSITORIES = 500;
const MAX_WATCHERS = 64;
const WATCH_DEBOUNCE_MS = 1500;
const FOCUS_GAP_MS = 30_000;
const TOKEN_TTL_MS = 10 * 60_000;

// Changes inside .git that mean the status may differ: staging, commits, checkouts, fetches.
const WATCHED = /^(index|HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|packed-refs|refs)/;

export class RepoError extends UserError {}

export function displayPath(root: string, home = os.homedir()): string {
  const relative = path.relative(home, root);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? `~${path.sep}${relative}`
    : root;
}

export function createRepositoryService(deps: {
  store: RepositoryStore;
  remote: Pick<RemoteService, 'create'>;
  desktop: Desktop;
  settings: () => Settings;
  emit: (repositories: RepositorySummary[]) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const { store } = deps;
  const inspecting = new Set<string>();
  const queued = new Map<string, Array<() => void>>();
  const order: string[] = [];
  let running = 0;
  const watchers = new Map<string, FSWatcher>();
  const watchTimers = new Map<string, NodeJS.Timeout>();
  // One-time folder tokens: the renderer refers to a picked folder without ever holding its path.
  const tokens = new Map<string, { dir: string; expires: number }>();
  let emitTimer: NodeJS.Timeout | null = null;
  let interval: NodeJS.Timeout | null = null;
  let lastFocusRefresh = 0;
  let disposed = false;

  const toSummary = (row: RepoRow): RepositorySummary => ({
    id: row.id,
    name: row.name,
    description: row.description,
    displayPath: displayPath(row.rootPath),
    pinned: row.pinned,
    addedAt: row.addedAt,
    lastOpenedAt: row.lastOpenedAt,
    availability: row.availability ?? 'available',
    status: row.status,
    inspectedAt: row.inspectedAt,
    inspecting: inspecting.has(row.id) || queued.has(row.id),
    error: row.error,
    remoteId: row.remoteId,
  });

  const list = () => store.list().map(toSummary);

  // Coalesces bursts (a queue draining, a watcher storm) into one push to the renderer.
  function changed(): void {
    if (emitTimer || disposed) return;
    emitTimer = setTimeout(() => {
      emitTimer = null;
      deps.emit(list());
    }, 80);
  }

  function rowOrThrow(id: string): RepoRow {
    const row = store.get(id);
    if (!row) throw new RepoError('That repository is no longer in gitdesk.');
    return row;
  }

  async function inspectOne(id: string): Promise<void> {
    if (disposed) return;
    const row = store.get(id);
    if (!row) return;
    try {
      const result = await inspect(row.rootPath);
      if (disposed) return;
      store.saveInspection(id, result, now());
    } catch (err) {
      if (disposed) return;
      store.saveInspection(
        id,
        {
          availability: 'available',
          status: null,
          error: err instanceof GitError ? err.message : describeGitError(err),
        },
        now(),
      );
    }
    syncWatcher(id);
  }

  function pump(): void {
    while (!disposed && running < CONCURRENCY && order.length) {
      const id = order.shift()!;
      const waiters = queued.get(id) ?? [];
      queued.delete(id);
      inspecting.add(id);
      running++;
      void inspectOne(id).finally(() => {
        running--;
        inspecting.delete(id);
        waiters.forEach((resolve) => resolve());
        changed();
        pump();
      });
    }
  }

  // Bounded and de-duplicated: a repository already waiting is not queued twice.
  function enqueue(ids: string[]): Promise<void> {
    const waits = ids.map(
      (id) =>
        new Promise<void>((resolve) => {
          const waiting = queued.get(id);
          if (waiting) return waiting.push(resolve);
          queued.set(id, [resolve]);
          order.push(id);
        }),
    );
    changed();
    pump();
    return Promise.all(waits).then(() => undefined);
  }

  function unwatch(id: string): void {
    watchers.get(id)?.close();
    watchers.delete(id);
    clearTimeout(watchTimers.get(id));
    watchTimers.delete(id);
  }

  // Watch events are hints, never the truth: they only schedule a status check, debounced.
  function syncWatcher(id: string): void {
    const row = store.get(id);
    const wanted =
      !!row &&
      deps.settings().watchRepositories &&
      row.availability === 'available';
    if (!wanted) return unwatch(id);
    if (watchers.has(id) || watchers.size >= MAX_WATCHERS) return;
    const gitDir = path.join(row.rootPath, '.git');
    void stat(gitDir)
      .then((info) => {
        // A worktree's .git is a file pointing elsewhere; those rely on focus and interval checks.
        if (!info.isDirectory() || watchers.has(id)) return;
        const watcher = watch(gitDir, { persistent: false }, (_event, file) => {
          if (file && !WATCHED.test(String(file))) return;
          clearTimeout(watchTimers.get(id));
          watchTimers.set(
            id,
            setTimeout(() => void enqueue([id]), WATCH_DEBOUNCE_MS),
          );
        });
        watcher.on('error', () => unwatch(id));
        watchers.set(id, watcher);
      })
      .catch(() => undefined);
  }

  function issueToken(dir: string): string {
    const token = randomBytes(24).toString('base64url');
    const time = now();
    for (const [key, value] of tokens)
      if (value.expires < time) tokens.delete(key);
    tokens.set(token, { dir, expires: time + TOKEN_TTL_MS });
    return token;
  }

  function redeem(token: string): string {
    const entry = tokens.get(token);
    tokens.delete(token);
    if (!entry || entry.expires < now())
      throw new RepoError('That folder choice expired. Choose the folder again.');
    return entry.dir;
  }

  async function register(
    root: string,
    activity: LocalActivity['type'],
    extra: { description?: string | null; remoteId?: string | null } = {},
  ): Promise<{ status: 'added' | 'exists'; repository: RepositorySummary }> {
    const key = pathKey(root);
    const existing = store.idForKey(key);
    if (existing) {
      store.touchOpened(existing, now());
      return { status: 'exists', repository: toSummary(rowOrThrow(existing)) };
    }
    if (store.list().length >= MAX_REPOSITORIES)
      throw new RepoError(`gitdesk keeps up to ${MAX_REPOSITORIES} repositories.`);
    const id = randomUUID();
    store.insert({
      id,
      rootPath: root,
      pathKey: key,
      name: path.basename(root) || root,
      description: extra.description ?? null,
      remoteId: extra.remoteId ?? null,
      now: now(),
      activity,
    });
    await enqueue([id]);
    return { status: 'added', repository: toSummary(rowOrThrow(id)) };
  }

  async function defaultBranch(dir: string): Promise<string> {
    const value = (
      await gitAt(dir)
        .raw(['config', '--get', 'init.defaultBranch'])
        .catch(() => '')
    ).trim();
    return /^[A-Za-z0-9._/-]{1,100}$/.test(value) ? value : 'main';
  }

  async function createRemoteFor(
    row: RepoRow,
  ): Promise<RemoteRepository> {
    const remote = await deps.remote.create({
      name: row.name,
      description: row.description,
    });
    store.setRemote(row.id, remote.id);
    changed();
    return remote;
  }

  return {
    list,

    async add(): Promise<AddRepositoryResult> {
      const dir = await deps.desktop.pickDirectory({
        title: 'Open repository',
        create: false,
      });
      if (!dir) return { status: 'canceled' };
      const root = await resolveRoot(dir);
      if (root.kind === 'bare')
        throw new RepoError(
          "That's a bare repository. Open a folder with a working tree.",
        );
      if (root.kind === 'not-a-repository') {
        const canonical = await canonicalPath(dir);
        return {
          status: 'not-a-repository',
          displayPath: displayPath(canonical),
          token: issueToken(canonical),
        };
      }
      return register(root.root, 'added');
    },

    // The deliberate "initialize Git here" step for a folder add() found was not a repository.
    async initialize(token: string): Promise<RepositorySummary> {
      const dir = redeem(token);
      const root = await resolveRoot(dir);
      if (root.kind === 'repository')
        return (await register(root.root, 'added')).repository;
      try {
        await gitAt(dir).raw(['init', '-b', await defaultBranch(dir)]);
      } catch (err) {
        throw new RepoError(describeGitError(err));
      }
      return (await register(await canonicalPath(dir), 'created')).repository;
    },

    // Points a moved repository's registration at its new folder.
    async locate(id: string): Promise<RepositorySummary | null> {
      rowOrThrow(id);
      const dir = await deps.desktop.pickDirectory({
        title: 'Locate repository',
        create: false,
      });
      if (!dir) return null;
      const root = await resolveRoot(dir);
      if (root.kind !== 'repository')
        throw new RepoError("That folder isn't a Git repository.");
      const key = pathKey(root.root);
      const owner = store.idForKey(key);
      if (owner && owner !== id)
        throw new RepoError('That folder is already in gitdesk.');
      unwatch(id);
      store.relocate(id, root.root, key);
      await enqueue([id]);
      return toSummary(rowOrThrow(id));
    },

    refresh(id: string | null): Promise<void> {
      const ids = id ? [rowOrThrow(id).id] : store.list().map((row) => row.id);
      return enqueue(ids);
    },

    open(id: string): RepositorySummary {
      rowOrThrow(id);
      store.touchOpened(id, now());
      void enqueue([id]);
      return toSummary(rowOrThrow(id));
    },

    pin(id: string, pinned: boolean): RepositorySummary {
      rowOrThrow(id);
      store.setPinned(id, pinned, now());
      changed();
      return toSummary(rowOrThrow(id));
    },

    // Removes gitdesk's registration only. The folder and its history stay exactly as they are.
    remove(id: string): void {
      unwatch(id);
      store.remove(id);
      changed();
    },

    forgetAll(): void {
      for (const id of [...watchers.keys()]) unwatch(id);
      store.removeAll();
      changed();
    },

    async reveal(id: string): Promise<void> {
      const row = rowOrThrow(id);
      const error = await deps.desktop.openPath(row.rootPath);
      if (error) throw new RepoError("Couldn't open the folder. It may have moved.");
    },

    copyPath(id: string): void {
      deps.desktop.copyText(rowOrThrow(id).rootPath);
    },

    async changes(id: string): Promise<RepositoryChanges> {
      const row = rowOrThrow(id);
      try {
        return await listChanges(row.rootPath);
      } catch (err) {
        throw new RepoError(err instanceof Error ? err.message : String(err));
      }
    },

    async chooseLocation(): Promise<{
      token: string;
      displayPath: string;
    } | null> {
      const dir = await deps.desktop.pickDirectory({
        title: 'Choose where to create the repository',
        create: true,
      });
      if (!dir) return null;
      const canonical = await canonicalPath(dir);
      return { token: issueToken(canonical), displayPath: displayPath(canonical) };
    },

    // Local first, then the remote. The local repository exists before any network call, so a
    // remote failure never leaves a half-made local folder, and it is reported apart with a retry.
    async create(input: CreateRepositoryInput): Promise<CreateRepositoryResult> {
      const parent = redeem(input.locationToken);
      const target = path.join(parent, input.name);
      if (path.dirname(target) !== parent)
        throw new RepoError("That name can't be used as a folder.");
      try {
        await mkdir(target);
      } catch (err) {
        throw new RepoError(
          (err as NodeJS.ErrnoException).code === 'EEXIST'
            ? `A folder named ${input.name} already exists there.`
            : "Couldn't create the folder there.",
        );
      }
      const git = gitAt(target);
      try {
        await git.raw(['init', '-b', await defaultBranch(parent)]);
      } catch (err) {
        // Only the empty folder this call just made is removed; rmdir refuses anything non-empty.
        await rmdir(target).catch(() => undefined);
        throw new RepoError(describeGitError(err));
      }

      let readmeCommitted: boolean | null = null;
      if (input.readme) {
        const body = `# ${input.name}\n${input.description ? `\n${input.description}\n` : ''}`;
        await writeFile(path.join(target, 'README.md'), body, { flag: 'wx' });
        try {
          await git.raw(['add', '--', 'README.md']);
          await git.raw(['commit', '-m', 'Initial commit']);
          readmeCommitted = true;
        } catch {
          readmeCommitted = false;
        }
      }

      const { repository } = await register(
        await canonicalPath(target),
        'created',
        { description: input.description || null },
      );

      if (!input.remote)
        return { repository, remote: { status: 'skipped' }, readmeCommitted };
      try {
        const remote = await createRemoteFor(rowOrThrow(repository.id));
        return {
          repository: toSummary(rowOrThrow(repository.id)),
          remote: { status: 'created', remote },
          readmeCommitted,
        };
      } catch (err) {
        return {
          repository,
          remote: {
            status: 'failed',
            message: err instanceof Error ? err.message : 'The remote was not created.',
          },
          readmeCommitted,
        };
      }
    },

    async linkRemote(id: string): Promise<RemoteRepository> {
      const row = rowOrThrow(id);
      if (row.remoteId) throw new RepoError('This repository already has a remote.');
      return createRemoteFor(row);
    },

    activity: (): LocalActivity[] => store.activity(20),

    // Startup, focus and settings hooks, called from main.
    start(): void {
      void this.refresh(null);
      this.applySettings();
    },

    windowFocused(): void {
      if (!deps.settings().refreshOnFocus) return;
      if (now() - lastFocusRefresh < FOCUS_GAP_MS) return;
      lastFocusRefresh = now();
      void this.refresh(null);
    },

    applySettings(): void {
      const settings = deps.settings();
      if (interval) clearInterval(interval);
      interval = settings.backgroundRefresh
        ? setInterval(
            () => void this.refresh(null),
            settings.backgroundRefresh * 60_000,
          )
        : null;
      for (const row of store.list()) syncWatcher(row.id);
    },

    // Stops timers, watchers and queued work; waiting callers are released, not left hanging.
    dispose(): void {
      disposed = true;
      if (interval) clearInterval(interval);
      if (emitTimer) clearTimeout(emitTimer);
      for (const id of [...watchers.keys()]) unwatch(id);
      for (const waiters of queued.values()) waiters.forEach((resolve) => resolve());
      queued.clear();
      order.length = 0;
    },
  };
}

export type RepositoryService = ReturnType<typeof createRepositoryService>;
