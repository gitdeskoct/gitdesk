import { randomUUID } from 'node:crypto';
import type {
  MovePreview,
  MoveResult,
  MoveUndo,
  ProgressEvent,
} from '../../shared/repos';
import type { AppDatabase } from '../db/database';
import { UserError } from '../errors';
import { sameUrl } from '../remote/git-auth';
import { describeGitError, gitAt } from '../repos/git-inspector';
import type { RepositoryStore } from '../repos/repository-store';
import {
  classifyFetchError,
  redactRemoteUrl,
  type WorkspaceService,
} from '../repos/workspace-service';

// Cloudflare Artifacts keeps at most 1 GB per repository (created on or after 29 Sep 2026).
export const MAX_MOVE_BYTES = 1024 ** 3;
// Inactivity limit: Git reports progress while it transfers, so only a stall trips it.
const TRANSFER_TIMEOUT_MS = 120_000;

export class MoveError extends UserError {}

type ConfigEntry = [key: string, value: string];
// Everything Undo needs to put .git/config back: the removed remotes' own keys, every branch's
// upstream, and the name the gitdesk remote had before the move (null when it wasn't added yet).
type Backup = {
  hostedUrl: string;
  hostedBefore: string | null;
  remotes: { name: string; config: ConfigEntry[] }[];
};

const lines = (output: string) =>
  output
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

// `git config --get-regexp` prints "key value"; keys never hold spaces.
function parseConfig(output: string): ConfigEntry[] {
  return output
    .split('\n')
    .filter(Boolean)
    .map((line) => {
      const space = line.indexOf(' ');
      return space < 0
        ? ([line, ''] as ConfigEntry)
        : ([line.slice(0, space), line.slice(space + 1)] as ConfigEntry);
    });
}

const UPSTREAM_KEY = /^branch\.(.+)\.(remote|merge)$/;

export function createMoveService(deps: {
  db: AppDatabase;
  store: RepositoryStore;
  workspace: Pick<
    WorkspaceService,
    | 'serial'
    | 'rootOf'
    | 'operationInProgress'
    | 'transferGit'
    | 'remoteNames'
    | 'headOid'
  >;
  hostedUrl: (remoteId: string) => Promise<string | null>;
  gitAuth: (
    remoteId: string,
    url: string,
    scope: 'read' | 'write',
  ) => Promise<Record<string, string> | null>;
  emitProgress?: (event: ProgressEvent) => void;
  addActivity: (
    id: string,
    type: 'moved' | 'move-undone',
    detail: string | null,
  ) => void;
  refresh: (id: string) => Promise<void>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const ws = deps.workspace;
  const moves = new Map<string, AbortController>();

  const journal = {
    insert(op: { id: string; repoId: string; head: string; remote: string }) {
      deps.db
        .prepare(
          `INSERT INTO merge_operations (id, repository_id, kind, state, source_oid, remote,
             created_at, updated_at)
           VALUES (?, ?, 'move', 'fetching', ?, ?, ?, ?)`,
        )
        .run(op.id, op.repoId, op.head, op.remote, now(), now());
    },
    set(id: string, state: string, errorCode: string | null = null) {
      deps.db
        .prepare(
          'UPDATE merge_operations SET state = ?, error_code = ?, updated_at = ? WHERE id = ?',
        )
        .run(state, errorCode, now(), id);
    },
  };

  const run = (root: string, args: string[]) =>
    gitAt(root)
      .raw(args)
      .catch((err: unknown) => {
        throw new MoveError(describeGitError(err));
      });

  async function survey(id: string) {
    const row = deps.store.get(id);
    if (!row) throw new MoveError('That repository is no longer in gitdesk.');
    const root = ws.rootOf(id);
    const hosted = row.remoteId
      ? await deps.hostedUrl(row.remoteId).catch(() => null)
      : null;
    const others: { name: string; url: string }[] = [];
    let hostedName: string | null = null;
    for (const name of await ws.remoteNames(root)) {
      const url = (
        await gitAt(root)
          .raw(['remote', 'get-url', '--', name])
          .catch(() => '')
      ).trim();
      if (hosted && sameUrl(url, hosted)) hostedName ??= name;
      else others.push({ name, url });
    }
    return { row, root, hosted, hostedName, others };
  }

  // LFS objects live outside Git history, so a move would leave them behind.
  async function usesLfs(root: string): Promise<boolean> {
    const files = lines(
      await gitAt(root)
        .raw(['ls-tree', '-r', '--name-only', 'HEAD'])
        .catch(() => ''),
    ).filter(
      (file) => file === '.gitattributes' || file.endsWith('/.gitattributes'),
    );
    for (const file of files.slice(0, 50)) {
      const text = await gitAt(root)
        .raw(['cat-file', '-p', `HEAD:${file}`])
        .catch(() => '');
      if (/filter=lfs/.test(text)) return true;
    }
    return false;
  }

  // Packed plus loose objects, from Git's own count, in bytes.
  async function historyBytes(root: string): Promise<number> {
    const output = await gitAt(root)
      .raw(['count-objects', '-v'])
      .catch(() => '');
    let kib = 0;
    for (const [key, value] of output
      .split('\n')
      .map((line) => line.split(':').map((part) => part.trim())))
      if (key === 'size' || key === 'size-pack' || key === 'size-garbage')
        kib += Number(value) || 0;
    return kib * 1024;
  }

  async function refList(
    root: string,
    prefix: string,
  ): Promise<Map<string, string>> {
    const refs = new Map<string, string>();
    for (const line of lines(
      await gitAt(root)
        .raw(['for-each-ref', '--format=%(objectname) %(refname)', prefix])
        .catch(() => ''),
    )) {
      const [oid, ref] = line.split(' ');
      if (oid && ref) refs.set(ref, oid);
    }
    return refs;
  }

  // What the move would copy: local branches, tags, and branches that only exist on an old remote.
  async function plan(root: string, others: { name: string }[]) {
    const heads = await refList(root, 'refs/heads');
    const tags = await refList(root, 'refs/tags');
    const extra = new Map<string, { ref: string; oid: string }>();
    for (const { name } of others) {
      const prefix = `refs/remotes/${name}/`;
      for (const [ref, oid] of await refList(root, prefix)) {
        const branch = ref.slice(prefix.length);
        if (
          branch === 'HEAD' ||
          heads.has(`refs/heads/${branch}`) ||
          extra.has(branch)
        )
          continue;
        extra.set(branch, { ref, oid });
      }
    }
    return { heads, tags, extra };
  }

  async function refusal(
    id: string,
    found: Awaited<ReturnType<typeof survey>>,
  ): Promise<Extract<MovePreview, { status: 'refused' }> | null> {
    const refused = (
      reason: Extract<MovePreview, { status: 'refused' }>['reason'],
      message: string,
    ) => ({ status: 'refused' as const, reason, message });
    if (!found.row.remoteId || !found.hosted)
      return refused(
        'not-linked',
        "This repository doesn't have a gitdesk Git URL yet. Link it to your account first.",
      );
    if (!found.others.length)
      return refused('nothing', 'Every remote already points at gitdesk.');
    if (await ws.operationInProgress(id))
      return refused(
        'operation',
        'A merge, rebase or similar operation is in progress. Finish or abort it first.',
      );
    if (await usesLfs(found.root))
      return refused(
        'lfs',
        "This repository uses Git LFS. gitdesk hosting stores Git history only, so large files tracked by LFS wouldn't be copied. Nothing was changed.",
      );
    if ((await historyBytes(found.root)) > MAX_MOVE_BYTES)
      return refused(
        'too-large',
        'Its Git history is over 1 GB, the most a gitdesk repository can hold. Nothing was changed.',
      );
    return null;
  }

  async function restoreUpstreams(root: string, entries: ConfigEntry[]) {
    for (const [key, value] of entries)
      if (UPSTREAM_KEY.test(key)) await run(root, ['config', key, value]);
  }

  async function latestBackup(id: string) {
    const row = deps.db
      .prepare(
        `SELECT operation_id, remotes_json, upstreams_json, created_at FROM remote_backups
         WHERE repository_id = ? AND undone_at IS NULL ORDER BY created_at DESC LIMIT 1`,
      )
      .get(id) as
      | {
          operation_id: string;
          remotes_json: string;
          upstreams_json: string;
          created_at: number;
        }
      | undefined;
    if (!row) return null;
    return {
      operationId: row.operation_id,
      at: row.created_at,
      backup: JSON.parse(row.remotes_json) as Backup,
      upstreams: JSON.parse(row.upstreams_json) as ConfigEntry[],
    };
  }

  return {
    async preview(id: string): Promise<MovePreview> {
      const found = await survey(id);
      const refused = await refusal(id, found);
      if (refused) return refused;
      const { heads, tags, extra } = await plan(found.root, found.others);
      return {
        status: 'ready',
        remotes: found.others.map((other) => ({
          name: other.name,
          url: redactRemoteUrl(other.url).fetchUrl,
        })),
        branches: heads.size + extra.size,
        tags: tags.size,
      };
    },

    // Nothing in .git/config changes until every branch and tag is confirmed on gitdesk, and the
    // config is saved first, so a crash mid-switch can still be undone.
    move(input: { id: string; jobId: string }): Promise<MoveResult> {
      return ws.serial(input.id, async () => {
        const found = await survey(input.id);
        const refused = await refusal(input.id, found);
        if (refused) return refused;
        const { root, hosted, others, hostedName } = found;
        const remoteId = found.row.remoteId!;
        if (moves.has(input.jobId))
          throw new MoveError('That move is already running.');
        const controller = new AbortController();
        moves.set(input.jobId, controller);
        const opId = randomUUID();
        journal.insert({
          id: opId,
          repoId: input.id,
          head: (await ws.headOid(root)) ?? '',
          remote: hostedName ?? 'origin',
        });
        const step = (stage: string, percent: number) =>
          deps.emitProgress?.({
            jobId: input.jobId,
            stage,
            percent,
            receivedBytes: null,
            bytesPerSecond: null,
          });
        const transfer = (auth?: Record<string, string>) =>
          ws.transferGit(
            root,
            input.jobId,
            controller.signal,
            TRANSFER_TIMEOUT_MS,
            auth,
          );
        const fail = (
          reason: Extract<MoveResult, { status: 'failed' }>['reason'],
          message: string,
        ): MoveResult => {
          journal.set(
            opId,
            reason === 'cancelled' ? 'cancelled' : 'failed',
            reason,
          );
          return { status: 'failed', reason, message };
        };
        const stop = (
          reason: Extract<MoveResult, { status: 'refused' }>['reason'],
          message: string,
        ): MoveResult => {
          journal.set(opId, 'failed', reason);
          return { status: 'refused', reason, message };
        };
        try {
          for (const other of others) {
            step(`Fetching ${other.name}`, 0);
            try {
              await transfer().raw([
                'fetch',
                '--progress',
                '--prune',
                '--recurse-submodules=no',
                '--',
                other.name,
              ]);
            } catch (err) {
              if (controller.signal.aborted)
                return fail(
                  'cancelled',
                  'Move cancelled. Your remotes are unchanged.',
                );
              const reason = classifyFetchError(errorText(err));
              return fail(
                reason === 'auth'
                  ? 'auth'
                  : reason === 'network'
                    ? 'network'
                    : 'failed',
                `Couldn't fetch ${other.name}, so its newest branches can't be copied. ${
                  reason === 'auth'
                    ? 'Fetch it once from a terminal so your credential helper has the sign-in, then move again.'
                    : 'Check your connection and try again.'
                } Your remotes are unchanged.`,
              );
            }
          }

          const { heads, tags, extra } = await plan(root, others);
          if (!heads.size && !tags.size && !extra.size)
            return stop(
              'nothing',
              'This repository has no commits to move yet.',
            );
          const refspecs = [
            ...(heads.size ? ['refs/heads/*:refs/heads/*'] : []),
            ...(tags.size ? ['refs/tags/*:refs/tags/*'] : []),
            ...[...extra].map(
              ([branch, { ref }]) => `${ref}:refs/heads/${branch}`,
            ),
          ];
          journal.set(opId, 'copying');
          step('Copying to gitdesk', 0);
          const write = await deps
            .gitAuth(remoteId, hosted!, 'write')
            .catch(() => null);
          if (!write)
            return fail(
              'auth',
              "Couldn't get Git access to your gitdesk repository. Sign in and try again.",
            );
          try {
            // Never forced: a branch gitdesk already holds with other commits stops the move.
            await transfer(write).raw([
              'push',
              '--progress',
              '--recurse-submodules=no',
              hosted!,
              ...refspecs,
            ]);
          } catch (err) {
            if (controller.signal.aborted)
              return fail(
                'cancelled',
                'Move cancelled. Some branches may already be on gitdesk; your remotes are unchanged.',
              );
            const text = errorText(err);
            const rejected = /!\s+\[(?:remote )?rejected\]\s+(\S+)/.exec(text);
            if (rejected || /non-fast-forward|fetch first/i.test(text))
              return stop(
                'diverged',
                `gitdesk already has a different ${rejected?.[1] ?? 'branch'}, with commits this repository doesn't. gitdesk never force-pushes. Nothing was switched; pull from gitdesk first, then move again.`,
              );
            const reason = classifyFetchError(text);
            return fail(
              reason === 'auth'
                ? 'auth'
                : reason === 'network'
                  ? 'network'
                  : 'failed',
              'The copy to gitdesk stopped. Your remotes are unchanged: origin still points where it did.',
            );
          }

          journal.set(opId, 'verifying');
          step('Checking gitdesk', 100);
          const read = await deps
            .gitAuth(remoteId, hosted!, 'read')
            .catch(() => null);
          const listed = new Map<string, string>();
          for (const line of lines(
            await transfer(read ?? undefined)
              .raw(['ls-remote', hosted!])
              .catch(() => ''),
          )) {
            const [oid, ref] = line.split('\t');
            if (oid && ref) listed.set(ref, oid);
          }
          const expected = new Map([...heads, ...tags]);
          for (const [branch, { oid }] of extra)
            expected.set(`refs/heads/${branch}`, oid);
          for (const [ref, oid] of expected)
            if (listed.get(ref) !== oid)
              return stop(
                'unverified',
                `${ref.replace(/^refs\/(heads|tags)\//, '')} didn't arrive on gitdesk as expected. Nothing was switched; try the move again.`,
              );

          // The backup is written before the first config change.
          const upstreams = parseConfig(
            await gitAt(root)
              .raw([
                'config',
                '--local',
                '--get-regexp',
                '^branch\\..*\\.(remote|merge)$',
              ])
              .catch(() => ''),
          );
          const remoteConfig = parseConfig(
            await gitAt(root)
              .raw(['config', '--local', '--get-regexp', '^remote\\.'])
              .catch(() => ''),
          );
          const backup: Backup = {
            hostedUrl: hosted!,
            hostedBefore: hostedName,
            remotes: others.map(({ name }) => ({
              name,
              config: remoteConfig.filter(([key]) =>
                key.startsWith(`remote.${name}.`),
              ),
            })),
          };
          deps.db
            .prepare(
              `INSERT INTO remote_backups (operation_id, repository_id, remotes_json, upstreams_json, created_at)
               VALUES (?, ?, ?, ?, ?)`,
            )
            .run(
              opId,
              input.id,
              JSON.stringify(backup),
              JSON.stringify(upstreams),
              now(),
            );
          journal.set(opId, 'switching');

          for (const { name } of others)
            await run(root, ['remote', 'remove', '--', name]);
          if (!hostedName)
            await run(root, ['remote', 'add', '--', 'origin', hosted!]);
          else if (hostedName !== 'origin')
            await run(root, ['remote', 'rename', '--', hostedName, 'origin']);
          // Branches that tracked a removed remote follow the same branch on origin. `git remote
          // remove` deleted both their .remote and .merge, so both are written back.
          const removed = new Set(others.map((other) => other.name));
          const moved = new Set(
            upstreams
              .map(([key, value]) => [UPSTREAM_KEY.exec(key), value] as const)
              .filter(([m, value]) => m?.[2] === 'remote' && removed.has(value))
              .map(([m]) => m![1]),
          );
          for (const [key, value] of upstreams) {
            const match = UPSTREAM_KEY.exec(key);
            if (!match || !moved.has(match[1])) continue;
            await run(root, [
              'config',
              key,
              match[2] === 'remote' ? 'origin' : value,
            ]);
          }
          await transfer(read ?? undefined)
            .raw(['fetch', '--prune', '--recurse-submodules=no', 'origin'])
            .catch(() => undefined);

          journal.set(opId, 'completed');
          const branches = heads.size + extra.size;
          deps.addActivity(
            input.id,
            'moved',
            `${branches} branches, ${tags.size} tags`,
          );
          return {
            status: 'moved',
            branches,
            tags: tags.size,
            removed: others.map((other) => other.name),
          };
        } finally {
          moves.delete(input.jobId);
          await deps.refresh(input.id).catch(() => undefined);
        }
      });
    },

    cancel(jobId: string): void {
      moves.get(jobId)?.abort();
    },

    async undoState(id: string): Promise<MoveUndo> {
      const latest = await latestBackup(id);
      return latest
        ? {
            operationId: latest.operationId,
            at: latest.at,
            remotes: latest.backup.remotes.map((remote) => remote.name),
          }
        : null;
    },

    // Puts the saved remotes and upstreams back. Nothing on the gitdesk server is deleted.
    undo(id: string): Promise<void> {
      return ws.serial(id, async () => {
        const latest = await latestBackup(id);
        if (!latest)
          throw new MoveError('There is no move to undo for this repository.');
        const root = ws.rootOf(id);
        const { backup, upstreams } = latest;
        const names = await ws.remoteNames(root);
        let hostedNow: string | null = null;
        for (const name of names) {
          const url = (
            await gitAt(root)
              .raw(['remote', 'get-url', '--', name])
              .catch(() => '')
          ).trim();
          if (sameUrl(url, backup.hostedUrl)) hostedNow ??= name;
        }
        const taken = backup.remotes.find(
          ({ name }) => name !== hostedNow && names.includes(name),
        );
        if (taken)
          throw new MoveError(
            `A remote named ${taken.name} exists again, so the old one can't be put back. Rename it first.`,
          );
        if (hostedNow) await run(root, ['remote', 'remove', '--', hostedNow]);
        if (backup.hostedBefore)
          await run(root, [
            'remote',
            'add',
            '--',
            backup.hostedBefore,
            backup.hostedUrl,
          ]);
        for (const remote of backup.remotes)
          for (const [key, value] of remote.config)
            if (key.startsWith(`remote.${remote.name}.`))
              await run(root, ['config', '--add', key, value]);
        await restoreUpstreams(root, upstreams);
        deps.db
          .prepare(
            'UPDATE remote_backups SET undone_at = ? WHERE operation_id = ?',
          )
          .run(now(), latest.operationId);
        deps.addActivity(
          id,
          'move-undone',
          backup.remotes.map((r) => r.name).join(', '),
        );
        // Their remote-tracking branches come back with the next fetch; a failed one changes nothing.
        const signal = new AbortController().signal;
        for (const remote of backup.remotes)
          await ws
            .transferGit(
              root,
              randomUUID(),
              signal,
              TRANSFER_TIMEOUT_MS,
              undefined,
            )
            .raw(['fetch', '--recurse-submodules=no', '--', remote.name])
            .catch(() => undefined);
        await deps.refresh(id).catch(() => undefined);
      });
    },

    // A move a crash stopped mid-switch is marked failed; its backup keeps Undo available.
    recover(): void {
      deps.db
        .prepare(
          `UPDATE merge_operations SET state = 'failed', error_code = 'OPERATION_RESULT_UNKNOWN',
             updated_at = ? WHERE kind = 'move' AND state NOT IN ('completed', 'failed', 'cancelled')`,
        )
        .run(now());
    },

    dispose(): void {
      for (const controller of moves.values()) controller.abort();
    },
  };
}

export type MoveService = ReturnType<typeof createMoveService>;
