import { randomBytes, randomUUID } from 'node:crypto';
import { watch, type FSWatcher } from 'node:fs';
import { mkdir, rmdir, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  CREATE_STEPS,
  repositoryNameSchema,
  type RepositoryHistory,
  type RepoTrashInput,
  type RepoUpdateInput,
  type CreateStep,
  type CloneInput,
  type ProgressEvent,
  type CloneResult,
  type AddRepositoryResult,
  type CreateRepositoryInput,
  type CreateRepositoryResult,
  type LocalActivity,
  type RemoteRepository,
  type RepositoryChanges,
  type RepositorySummary,
} from '../../shared/repos';
import { gitDefaultsSchema } from '../../shared/ipc';
import type { Settings } from '../../shared/settings';
import { UserError } from '../errors';
import type { RemoteService } from '../remote/remote-service';
import {
  canonicalPath,
  describeGitError,
  gitAt,
  GitError,
  history,
  inspect,
  listChanges,
  pathKey,
  resolveRoot,
} from './git-inspector';
import { cloneInto } from './clone-runner';
import type { RepoRow, RepositoryStore } from './repository-store';

// Desktop integration the service needs, injected so tests can drive it without Electron.
export type Desktop = {
  pickDirectory(options: {
    title: string;
    create: boolean;
  }): Promise<string | null>;
  openPath(target: string): Promise<string>;
  copyText(text: string): void;
  // The system trash (Recycle Bin). Rejects when the OS can't move the item.
  trashItem(target: string): Promise<void>;
  // Folders that are never trashed, and never trashed as part of a parent folder.
  protectedPaths(): string[];
};

const isInside = (child: string, parent: string): boolean => {
  const relative = path.relative(parent, child);
  return !!relative && !relative.startsWith('..') && !path.isAbsolute(relative);
};

const CONCURRENCY = 3;
const MAX_REPOSITORIES = 500;
const MAX_WATCHERS = 64;
const WATCH_DEBOUNCE_MS = 1500;
const FOCUS_GAP_MS = 30_000;
const TOKEN_TTL_MS = 10 * 60_000;

// Changes inside .git that mean the status may differ: staging, commits, checkouts, fetches.
const WATCHED =
  /^(index|HEAD|ORIG_HEAD|FETCH_HEAD|MERGE_HEAD|packed-refs|refs)/;

export class RepoError extends UserError {}

export function displayPath(root: string, home = os.homedir()): string {
  const relative = path.relative(home, root);
  return relative && !relative.startsWith('..') && !path.isAbsolute(relative)
    ? `~${path.sep}${relative}`
    : root;
}

export function createRepositoryService(deps: {
  store: RepositoryStore;
  remote: Pick<RemoteService, 'create' | 'update'>;
  desktop: Desktop;
  settings: () => Settings;
  emit: (repositories: RepositorySummary[]) => void;
  emitProgress?: (event: ProgressEvent) => void;
  // A background check found a new problem: called once when it appears, not on every check.
  onProblem?: (
    repository: RepositorySummary,
    kind: 'conflict' | 'missing',
  ) => void;
  onCloneDone?: (
    outcome:
      | {
          ok: true;
          repository: RepositorySummary;
          bytes: number | null;
          ms: number;
        }
      | { ok: false; name: string; message: string },
  ) => void;
  // Where a remote repository can be fetched from. Null until the sync transport exists.
  resolveCloneUrl?: (remoteId: string) => Promise<string | null>;
  cloneProtocols?: string[];
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console;
  const { store } = deps;
  const inspecting = new Set<string>();
  const queued = new Map<string, Array<() => void>>();
  const order: string[] = [];
  let running = 0;
  // Bumped when a registration's folder changes, so an inspection of the old path is discarded.
  const generation = new Map<string, number>();
  const watchers = new Map<string, FSWatcher[]>();
  const watchTimers = new Map<string, NodeJS.Timeout>();
  // One-time folder tokens: the renderer refers to a picked folder without ever holding its path.
  const tokens = new Map<string, { dir: string; expires: number }>();
  let emitTimer: NodeJS.Timeout | null = null;
  let interval: NodeJS.Timeout | null = null;
  let lastFocusRefresh = 0;
  let disposed = false;
  const clones = new Map<string, AbortController>();

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
    statusAt: row.statusAt,
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
    const started = generation.get(id) ?? 0;
    const current = () => !disposed && (generation.get(id) ?? 0) === started;
    let result: Parameters<RepositoryStore['saveInspection']>[1];
    try {
      result = await inspect(row.rootPath);
    } catch (err) {
      result = {
        availability: 'available',
        status: null,
        error: err instanceof GitError ? err.message : describeGitError(err),
      };
    }
    if (!current()) return;
    try {
      store.saveInspection(id, result, now());
    } catch (err) {
      // The row can be removed mid-inspection; a failed write must not reject the queue.
      log.warn(
        'saving an inspection failed',
        err instanceof Error ? err.message : err,
      );
    }
    // Only a change of state is news; an unresolved conflict is reported once, not every check.
    const after = store.get(id);
    if (after && row.availability === 'available') {
      if (result.availability === 'missing')
        deps.onProblem?.(toSummary(after), 'missing');
      else if (
        (row.status?.conflicts ?? 0) === 0 &&
        (result.status?.conflicts ?? 0) > 0
      )
        deps.onProblem?.(toSummary(after), 'conflict');
    }
    syncWatcher(id);
  }

  function pump(): void {
    let skipped = 0;
    // One inspection per repository at a time: a newer request waits behind the running one
    // instead of racing it, so an older result can never overwrite a newer one.
    while (!disposed && running < CONCURRENCY && order.length > skipped) {
      const id = order.shift()!;
      if (inspecting.has(id)) {
        order.push(id);
        skipped++;
        continue;
      }
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
    watchers.get(id)?.forEach((watcher) => watcher.close());
    watchers.delete(id);
    clearTimeout(watchTimers.get(id));
    watchTimers.delete(id);
  }

  // Watch events are hints, never the truth: they only schedule a status check, debounced.
  // .git itself is watched shallowly (index, HEAD, merge state); refs/ recursively, because a
  // commit only rewrites refs/heads/<branch>.
  function syncWatcher(id: string): void {
    const row = store.get(id);
    const wanted =
      !!row &&
      deps.settings().watchRepositories &&
      row.availability === 'available';
    if (!wanted) return unwatch(id);
    if (watchers.has(id) || watchers.size >= MAX_WATCHERS) return;
    const schedule = () => {
      clearTimeout(watchTimers.get(id));
      watchTimers.set(
        id,
        setTimeout(() => void enqueue([id]), WATCH_DEBOUNCE_MS),
      );
    };
    // Git reports where its data lives: a linked worktree or submodule has a .git file that points
    // elsewhere, and its refs live in the shared common directory.
    void gitAt(row.rootPath)
      .raw(['rev-parse', '--absolute-git-dir', '--git-common-dir'])
      .then(async (output) => {
        const [own, common] = output.split('\n').map((line) => line.trim());
        if (!own || !common || watchers.has(id)) return;
        const gitDir = path.resolve(row.rootPath, own);
        const commonDir = path.resolve(row.rootPath, common);
        if (!(await stat(gitDir)).isDirectory() || watchers.has(id)) return;
        const shallow = (dir: string) =>
          watch(dir, { persistent: false }, (_event, file) => {
            if (!file || WATCHED.test(String(file))) schedule();
          });
        const opened = [shallow(gitDir)];
        if (commonDir !== gitDir) opened.push(shallow(commonDir));
        try {
          opened.push(
            watch(
              path.join(commonDir, 'refs'),
              { persistent: false, recursive: true },
              schedule,
            ),
          );
        } catch {
          // shortcut: no recursive refs watch where the platform refuses it; focus and interval checks still run.
        }
        for (const watcher of opened) watcher.on('error', () => unwatch(id));
        watchers.set(id, opened);
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
      throw new RepoError(
        'That folder choice expired. Choose the folder again.',
      );
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
      changed();
      return { status: 'exists', repository: toSummary(rowOrThrow(existing)) };
    }
    assertRoom();
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

  function assertRoom(): void {
    if (store.list().length >= MAX_REPOSITORIES)
      throw new RepoError(
        `gitdesk keeps up to ${MAX_REPOSITORIES} repositories.`,
      );
  }

  // The parent folder may sit inside another repository whose local config sets this, so the value
  // is treated as untrusted: the same rule as Settings › Git, and never able to read as an option.
  async function defaultBranch(dir: string): Promise<string> {
    const value = (
      await gitAt(dir)
        .raw(['config', '--get', 'init.defaultBranch'])
        .catch(() => '')
    ).trim();
    const parsed = gitDefaultsSchema.shape.defaultBranch.safeParse(value);
    return parsed.success ? parsed.data : 'main';
  }

  // The local id is the idempotency key: one local repository gets at most one remote, however
  // often the request is retried. Folder names with spaces or accents become a valid remote name.
  async function createRemoteFor(row: RepoRow): Promise<RemoteRepository> {
    const name = repositoryNameSchema.safeParse(
      row.name
        .normalize('NFKD')
        .replace(/[^A-Za-z0-9._-]+/g, '-')
        .replace(/^[.-]+|-+$/g, ''),
    );
    if (!name.success)
      throw new RepoError(
        "This folder's name can't be used for a remote. Rename the folder first.",
      );
    const remote = await deps.remote.create(
      { name: name.data, description: row.description },
      row.id,
    );
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
        await gitAt(dir).raw([
          'init',
          `--initial-branch=${await defaultBranch(dir)}`,
        ]);
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
      generation.set(id, (generation.get(id) ?? 0) + 1);
      store.relocate(id, root.root, key);
      await enqueue([id]);
      return toSummary(rowOrThrow(id));
    },

    // One repository resolves when its check is done. All of them resolves once queued: with
    // hundreds of repositories the caller should not hold an IPC call open for minutes.
    async refresh(id: string | null): Promise<void> {
      if (id) return enqueue([rowOrThrow(id).id]);
      void enqueue(store.list().map((row) => row.id));
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

    // Only ever a folder: openPath on a file would launch it with its default app.
    async reveal(id: string): Promise<void> {
      const row = rowOrThrow(id);
      const isFolder = await stat(row.rootPath)
        .then((info) => info.isDirectory())
        .catch(() => false);
      if (!isFolder)
        throw new RepoError('The folder is gone. Locate it again.');
      const error = await deps.desktop.openPath(row.rootPath);
      if (error)
        throw new RepoError("Couldn't open the folder in your file manager.");
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

    async history(id: string): Promise<RepositoryHistory> {
      const row = rowOrThrow(id);
      if (row.availability && row.availability !== 'available')
        throw new RepoError('The folder is gone. Locate it again.');
      return history(row.rootPath, now());
    },

    // A linked repository's remote is renamed first, so a rejected name leaves both sides as they were.
    async update(input: RepoUpdateInput): Promise<RepositorySummary> {
      const row = rowOrThrow(input.id);
      if (row.remoteId) {
        const name =
          input.name === undefined
            ? undefined
            : repositoryNameSchema.safeParse(input.name);
        if (name && !name.success)
          throw new RepoError(
            name.error.issues[0]?.message ?? "That name can't be used.",
          );
        await deps.remote.update({
          id: row.remoteId,
          name: name?.data,
          description: input.description,
        });
      }
      store.rename(
        row.id,
        { name: input.name, description: input.description },
        now(),
      );
      changed();
      return toSummary(rowOrThrow(row.id));
    },

    // gitdesk never wrote a Git remote for the link, so the repository's Git config isn't touched.
    unlink(id: string): RepositorySummary {
      const row = rowOrThrow(id);
      if (!row.remoteId)
        throw new RepoError('This repository has no remote to disconnect.');
      store.setRemote(id, null);
      store.addActivity(id, 'unlinked', null, now());
      changed();
      return toSummary(rowOrThrow(id));
    },

    // The renderer names a registration and retypes its name; the path always comes from the
    // registry, and is checked again on disk before anything moves. Trash only, never a delete.
    async trash(input: RepoTrashInput): Promise<void> {
      const row = rowOrThrow(input.id);
      if (input.confirmName !== row.name)
        throw new RepoError(`Type ${row.name} exactly to confirm.`);
      const root = await resolveRoot(row.rootPath).catch(() => null);
      if (
        root?.kind !== 'repository' ||
        pathKey(root.root) !== pathKey(row.rootPath)
      )
        throw new RepoError(
          'That folder no longer holds this repository, so nothing was moved.',
        );
      const target = path.resolve(row.rootPath);
      const key = pathKey(target);
      const guarded = deps.desktop
        .protectedPaths()
        .map((p) => path.resolve(p))
        .some((p) => pathKey(p) === key || isInside(p, target));
      if (path.parse(target).root === target || guarded)
        throw new RepoError(
          "gitdesk won't move that folder to the trash. Remove it from gitdesk instead.",
        );
      const nested = store
        .list()
        .find(
          (other) => other.id !== row.id && isInside(other.rootPath, target),
        );
      if (nested)
        throw new RepoError(
          `${nested.name} is inside this folder. Remove it from gitdesk first.`,
        );
      // Open watch handles can make Windows refuse the move.
      unwatch(row.id);
      try {
        await deps.desktop.trashItem(target);
      } catch {
        syncWatcher(row.id);
        throw new RepoError(
          "Couldn't move the folder to the trash. Nothing was deleted.",
        );
      }
      store.remove(row.id);
      changed();
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
      return {
        token: issueToken(canonical),
        displayPath: displayPath(canonical),
      };
    },

    // Local first, then the remote. The local repository exists before any network call, so a
    // remote failure never leaves a half-made local folder, and it is reported apart with a retry.
    async create(
      input: CreateRepositoryInput,
    ): Promise<CreateRepositoryResult> {
      const startedAt = now();
      // Steps that apply to this create, so the bar fills evenly and finishes at 100%.
      const steps = CREATE_STEPS.filter(
        (s) =>
          (s !== 'readme' || input.readme) && (s !== 'remote' || input.remote),
      );
      const step = (stage: CreateStep | 'done') =>
        input.jobId &&
        deps.emitProgress?.({
          jobId: input.jobId,
          stage,
          percent:
            stage === 'done'
              ? 100
              : Math.round((steps.indexOf(stage) / steps.length) * 100),
          receivedBytes: null,
          bytesPerSecond: null,
        });
      const parent = redeem(input.locationToken);
      const target = path.join(parent, input.name);
      if (path.dirname(target) !== parent)
        throw new RepoError("That name can't be used as a folder.");
      // Checked before anything touches disk, so a refusal leaves nothing behind.
      assertRoom();
      step('folder');
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
      step('init');
      try {
        await git.raw([
          'init',
          `--initial-branch=${await defaultBranch(parent)}`,
        ]);
      } catch (err) {
        // Only the empty folder this call just made is removed; rmdir refuses anything non-empty.
        await rmdir(target).catch(() => undefined);
        throw new RepoError(describeGitError(err));
      }

      // From here the folder holds a real repository, so a later failure names it instead of deleting it.
      const leftAt = `The repository was created at ${displayPath(target)}; open it from there.`;
      let readmeCommitted: boolean | null = null;
      if (input.readme) {
        step('readme');
        const body = `# ${input.name}\n${input.description ? `\n${input.description}\n` : ''}`;
        try {
          await writeFile(path.join(target, 'README.md'), body, { flag: 'wx' });
        } catch {
          throw new RepoError(`Couldn't write the README. ${leftAt}`);
        }
        try {
          await git.raw(['add', '--', 'README.md']);
          await git.raw(['commit', '-m', 'Initial commit']);
          readmeCommitted = true;
        } catch {
          readmeCommitted = false;
        }
      }

      let repository: RepositorySummary;
      step('register');
      try {
        ({ repository } = await register(
          await canonicalPath(target),
          'created',
          {
            description: input.description || null,
          },
        ));
      } catch (err) {
        throw new RepoError(
          `${err instanceof UserError ? err.message : "Couldn't add it to gitdesk."} ${leftAt}`,
        );
      }

      if (!input.remote) {
        step('done');
        return {
          repository,
          remote: { status: 'skipped' },
          readmeCommitted,
          timing: { totalMs: now() - startedAt, remoteMs: null },
        };
      }
      step('remote');
      const remoteStart = now();
      try {
        const remote = await createRemoteFor(rowOrThrow(repository.id));
        step('done');
        return {
          repository: toSummary(rowOrThrow(repository.id)),
          remote: { status: 'created', remote },
          readmeCommitted,
          timing: { totalMs: now() - startedAt, remoteMs: now() - remoteStart },
        };
      } catch (err) {
        step('done');
        return {
          repository,
          remote: {
            status: 'failed',
            message:
              err instanceof Error
                ? err.message
                : 'The remote was not created.',
          },
          readmeCommitted,
          timing: { totalMs: now() - startedAt, remoteMs: now() - remoteStart },
        };
      }
    },

    async linkRemote(id: string): Promise<RemoteRepository> {
      const row = rowOrThrow(id);
      if (row.remoteId)
        throw new RepoError('This repository already has a remote.');
      return createRemoteFor(row);
    },

    // The URL is resolved before the folder token is spent, so an unavailable transport costs nothing.
    async clone(input: CloneInput): Promise<CloneResult> {
      const url = (await deps.resolveCloneUrl?.(input.remoteId)) ?? null;
      if (!url) return { status: 'unavailable' };
      if (clones.has(input.jobId))
        throw new RepoError('That clone is already running.');
      const parent = redeem(input.locationToken);
      assertRoom();
      const controller = new AbortController();
      clones.set(input.jobId, controller);
      const startedAt = now();
      let bytes: number | null = null;
      try {
        const target = await cloneInto({
          url,
          parent,
          name: input.name,
          signal: controller.signal,
          protocols: deps.cloneProtocols,
          onProgress: (progress) => {
            bytes = progress.receivedBytes ?? bytes;
            deps.emitProgress?.({ jobId: input.jobId, ...progress });
          },
        });
        const { repository } = await register(
          await canonicalPath(target),
          'cloned',
          {
            remoteId: input.remoteId,
          },
        );
        deps.onCloneDone?.({
          ok: true,
          repository,
          bytes,
          ms: now() - startedAt,
        });
        return { status: 'cloned', repository };
      } catch (err) {
        // A cancel is the person's own choice, so it isn't news.
        if (!controller.signal.aborted)
          deps.onCloneDone?.({
            ok: false,
            name: input.name,
            message:
              err instanceof UserError ? err.message : 'The clone stopped.',
          });
        throw err;
      } finally {
        clones.delete(input.jobId);
      }
    },

    cancelClone(jobId: string): void {
      clones.get(jobId)?.abort();
    },

    // After a remote is deleted, local repositories that pointed at it are simply unlinked.
    forgetRemote(remoteId: string): void {
      store.clearRemoteLink(remoteId);
      changed();
    },

    // Enough for several pages on Home; the store keeps at most 200.
    activity: (): LocalActivity[] => store.activity(120),

    clearActivity(): void {
      store.clearActivity();
    },

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
      for (const controller of clones.values()) controller.abort();
      if (interval) clearInterval(interval);
      if (emitTimer) clearTimeout(emitTimer);
      for (const id of [...watchers.keys()]) unwatch(id);
      for (const waiters of queued.values())
        waiters.forEach((resolve) => resolve());
      queued.clear();
      order.length = 0;
    },
  };
}

export type RepositoryService = ReturnType<typeof createRepositoryService>;
