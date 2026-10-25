import { stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  AccountPushPage,
  AccountPushStats,
  CheckResult,
  PullResult,
  PullStrategy,
  RemoteCheck,
  SyncActivityPage,
  SyncCode,
  SyncOperation,
  SyncOverview,
  SyncState,
  UpstreamComparison,
} from '../../shared/sync';
import { SYNC_PAGE } from '../../shared/sync';
import type { DiffResult, PushResult } from '../../shared/workspace';
import { UserError } from '../errors';
import {
  compare,
  fileDiff,
  isAncestor,
  mergeBase,
  unmergedFiles,
} from '../pulls/pull-git';
import { sameUrl } from '../remote/git-auth';
import { describeGitError, gitAt } from '../repos/git-inspector';
import type { RepositoryStore } from '../repos/repository-store';
import {
  classifyFetchError,
  sanitizeOutput,
  syncCodeFor,
  type WorkspaceService,
} from '../repos/workspace-service';
import type { Journal } from './journal';

export class SyncError extends UserError {}

// Counts from a fetch older than this may not match the server any more.
export const STALE_AFTER_MS = 60 * 60_000;
const MERGE_TIMEOUT_MS = 120_000;
const OID = /^[0-9a-f]{40,64}$/;

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

const PULL_STOPS: Partial<Record<SyncCode, string>> = {
  DETACHED:
    'HEAD is not on a branch, so there is nothing to pull into. Switch to a branch first.',
  NO_UPSTREAM:
    "This branch doesn't track a remote branch. Publish it, or track a branch on the remote first.",
  OPERATION_IN_PROGRESS:
    'A merge, rebase or similar operation is in progress. Finish or abort it first.',
  LOCAL_CHANGES:
    'These files have uncommitted changes. Commit or discard them first; gitdesk never stashes for you.',
  DIVERGED:
    'Both sides have new commits, so a fast-forward is not possible. Nothing changed. Pull with Merge or Rebase to bring them together.',
  STALE_REFERENCE:
    "The branch this one tracks isn't on the remote: it was deleted there, or never pushed. Publish this branch or track another one.",
  LOCAL_CONFLICT:
    'The pull stopped on conflicts. Resolve them on the Sync tab.',
};

export function createSyncService(deps: {
  store: RepositoryStore;
  journal: Journal;
  workspace: Pick<
    WorkspaceService,
    | 'serial'
    | 'rootOf'
    | 'operationInProgress'
    | 'currentBranch'
    | 'headOid'
    | 'fetchQuietly'
    | 'cancelFetch'
    | 'publish'
    | 'setUpstream'
    | 'lsRemote'
  >;
  // The account's Git URL for a linked repository, or null.
  hostedUrl?: (remoteId: string) => Promise<string | null>;
  // Tells the account about a push to its Git URL; resolves with what the server found.
  report?: (
    remoteId: string,
    body: {
      operationId: string;
      kind: 'push';
      ref: string;
      oldOid: string | null;
      newOid: string;
    },
  ) => Promise<'confirmed' | 'unverified' | 'rejected' | 'failed'>;
  // The account's push records from every device; absent or throwing when there's no account.
  account?: {
    list(input: {
      cursor: string | null;
      result: 'all' | 'unverified';
    }): Promise<AccountPushPage>;
    stats(): Promise<AccountPushStats>;
  };
  addActivity: (id: string, type: 'pulled', detail: string | null) => void;
  refresh: (id: string) => Promise<void>;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console;
  const ws = deps.workspace;
  const { journal } = deps;

  const git = (root: string, args: string[], timeoutMs?: number) =>
    gitAt(root, { timeoutMs }).raw(args);

  const configValue = (root: string, key: string) =>
    git(root, ['config', '--get', key])
      .then((value) => value.trim())
      .catch(() => '');

  async function refOid(root: string, ref: string): Promise<string | null> {
    const out = await git(root, [
      'rev-parse',
      '--verify',
      '--quiet',
      `${ref}^{commit}`,
    ]).catch(() => '');
    const oid = out.trim();
    return OID.test(oid) ? oid : null;
  }

  // The branch, the remote it tracks and the upstream's short name, read from this branch's config.
  async function tracking(root: string) {
    const branch = await ws.currentBranch(root);
    if (!branch)
      return { branch: null, remote: null, merge: null, upstream: null };
    const [remote, merge] = await Promise.all([
      configValue(root, `branch.${branch}.remote`),
      configValue(root, `branch.${branch}.merge`),
    ]);
    const ok = remote && remote !== '.' && merge.startsWith('refs/heads/');
    return {
      branch,
      remote: ok ? remote : null,
      merge: ok ? merge : null,
      upstream: ok ? `${remote}/${merge.slice('refs/heads/'.length)}` : null,
    };
  }

  async function exists(root: string, name: string): Promise<boolean> {
    const rel = (
      await git(root, ['rev-parse', '--git-path', name]).catch(() => '')
    ).trim();
    if (!rel) return false;
    return stat(path.resolve(root, rel)).then(
      () => true,
      () => false,
    );
  }

  async function trackedChanges(root: string): Promise<string[]> {
    const output = await git(root, [
      'status',
      '--porcelain=v1',
      '-z',
      '--untracked-files=no',
    ]);
    return output
      .split('\0')
      .map((entry) => entry.slice(3))
      .filter(Boolean)
      .slice(0, 20);
  }

  // Pushes to the account's Git URL are reported once, by operation id; a failed report waits for
  // the next push or the next start.
  async function report(op: SyncOperation): Promise<void> {
    if (op.kind !== 'push' || !op.remote || !op.branch || !op.newOid) return;
    const row = deps.store.get(op.repositoryId);
    if (!row?.remoteId || !deps.report || !deps.hostedUrl) return;
    const hosted = await deps.hostedUrl(row.remoteId).catch(() => null);
    const url = await git(row.rootPath, [
      'remote',
      'get-url',
      '--push',
      '--',
      op.remote,
    ])
      .then((out) => out.trim())
      .catch(() => '');
    if (!hosted || !sameUrl(url, hosted)) return;
    try {
      const result = await deps.report(row.remoteId, {
        operationId: op.id,
        kind: 'push',
        ref: `refs/heads/${op.branch}`,
        oldOid: op.oldOid,
        newOid: op.newOid,
      });
      journal.update(op.id, {
        state: 'completed',
        server: result === 'confirmed' ? 'confirmed' : 'unverified',
      });
    } catch (err) {
      log.warn('push not reported yet', errorText(err));
      journal.update(op.id, { state: 'report_pending' });
    }
  }

  function retryReports(): void {
    void (async () => {
      for (const op of journal.unreported()) await report(op);
    })();
  }

  function stopped(
    code: SyncCode,
    files: string[] = [],
    message?: string,
  ): PullResult {
    return {
      status: 'stopped',
      code,
      message:
        message ?? PULL_STOPS[code] ?? "Git couldn't pull. Nothing changed.",
      files,
    };
  }

  async function runPull(
    id: string,
    jobId: string,
    strategy: PullStrategy,
  ): Promise<PullResult> {
    const root = ws.rootOf(id);
    const t = await tracking(root);
    if (!t.branch) return stopped('DETACHED');
    if (!t.remote || !t.merge || !t.upstream) return stopped('NO_UPSTREAM');
    if (await ws.operationInProgress(id))
      return stopped('OPERATION_IN_PROGRESS');
    const dirty = await trackedChanges(root);
    if (dirty.length) return stopped('LOCAL_CHANGES', dirty);
    const before = await ws.headOid(root);
    const opId = journal.start({
      repoId: id,
      kind: 'pull',
      state: 'fetching',
      remote: t.upstream,
      branch: t.branch,
      strategy,
      headRef: t.branch,
      oldOid: before,
    });
    const fail = (code: SyncCode, files: string[] = [], message?: string) => {
      const result = stopped(code, files, message);
      journal.update(opId, {
        state: code === 'CANCELLED' ? 'cancelled' : 'failed',
        code,
        message: message ?? PULL_STOPS[code] ?? null,
      });
      return result;
    };

    const fetched = await ws.fetchQuietly(id, t.remote, jobId);
    if (fetched.status === 'failed')
      return fail(fetched.code ?? 'FAILED', [], fetched.message);
    // Pinned once: an automatic fetch during the merge can't slip in commits nobody looked at.
    const upstreamOid = await refOid(root, `refs/remotes/${t.upstream}`);
    if (!upstreamOid) return fail('STALE_REFERENCE');
    journal.update(opId, { newOid: upstreamOid });
    const head = await ws.headOid(root);
    if (!head || (await isAncestor(root, upstreamOid, head))) {
      journal.update(opId, { state: 'completed' });
      return {
        status: 'pulled',
        mode: 'up-to-date',
        branch: t.branch,
        upstream: t.upstream,
      };
    }
    const fastForward = await isAncestor(root, head, upstreamOid);
    const done = (
      mode: Extract<PullResult, { status: 'pulled' }>['mode'],
    ): PullResult => {
      journal.update(opId, { state: 'completed' });
      deps.addActivity(id, 'pulled', t.upstream);
      return {
        status: 'pulled',
        mode,
        branch: t.branch!,
        upstream: t.upstream!,
      };
    };
    const verify = async () => {
      const after = await ws.headOid(root);
      return !!after && (await isAncestor(root, upstreamOid, after));
    };

    if (fastForward || strategy === 'ff-only') {
      if (!fastForward) return fail('DIVERGED');
      await git(
        root,
        ['merge', '--ff-only', '--no-autostash', upstreamOid],
        MERGE_TIMEOUT_MS,
      ).catch(() => undefined);
      return (await verify())
        ? done('fast-forward')
        : fail(
            'FAILED',
            [],
            "Git couldn't fast-forward this branch. Nothing changed.",
          );
    }

    if (strategy === 'rebase') {
      journal.update(opId, { state: 'merging' });
      let thrown: unknown = null;
      await git(
        root,
        ['rebase', '--no-autostash', upstreamOid],
        MERGE_TIMEOUT_MS,
      ).catch((err: unknown) => {
        thrown = err;
      });
      const stuck =
        (await exists(root, 'rebase-merge')) ||
        (await exists(root, 'rebase-apply'));
      if (stuck) {
        // Conflicts wait on the conflict screen, one replayed commit at a time; a stop for any
        // other reason is undone, so the branch is never left half-rebased.
        const conflicted = await unmergedFiles(root).catch(() => []);
        if (conflicted.length) {
          const files = conflicted.map((file) => file.path);
          journal.update(opId, {
            state: 'conflict_resolution',
            code: 'LOCAL_CONFLICT',
            conflicts: files,
          });
          return { status: 'conflicts', files, upstream: t.upstream };
        }
        await git(root, ['rebase', '--abort']).catch(() => undefined);
        return fail(
          'FAILED',
          [],
          'Git stopped the rebase without a conflict, so gitdesk undid it. Nothing changed.',
        );
      }
      if (thrown && !(await verify()))
        return fail(
          'FAILED',
          [],
          sanitizeOutput(errorText(thrown), root) ?? describeGitError(thrown),
        );
      return (await verify())
        ? done('rebase')
        : fail(
            'FAILED',
            [],
            "Git couldn't rebase this branch. Nothing changed.",
          );
    }

    const message = `Merge ${t.upstream} into ${t.branch}`;
    journal.update(opId, { state: 'merging' });
    let thrown: unknown = null;
    await git(
      root,
      ['merge', '--no-edit', '--no-autostash', '-m', message, upstreamOid],
      MERGE_TIMEOUT_MS,
    ).catch((err: unknown) => {
      thrown = err;
    });
    // A conflicted merge can exit without stderr, which simple-git doesn't treat as an error,
    // so the index decides.
    const conflicted = await unmergedFiles(root).catch(() => []);
    if (conflicted.length) {
      const files = conflicted.map((file) => file.path);
      journal.update(opId, {
        state: 'conflict_resolution',
        code: 'LOCAL_CONFLICT',
        conflicts: files,
      });
      return { status: 'conflicts', files, upstream: t.upstream };
    }
    if (thrown || (await exists(root, 'MERGE_HEAD'))) {
      if (await exists(root, 'MERGE_HEAD'))
        await git(root, ['merge', '--abort']).catch(() => undefined);
      return fail(
        'FAILED',
        [],
        thrown
          ? (sanitizeOutput(errorText(thrown), root) ??
              describeGitError(thrown))
          : 'Git stopped the merge. Nothing changed.',
      );
    }
    return (await verify())
      ? done('merge')
      : fail(
          'FAILED',
          [],
          "Git finished, but the branch doesn't contain the upstream commit.",
        );
  }

  return {
    async overview(id: string): Promise<SyncOverview> {
      const row = deps.store.get(id);
      if (!row) throw new SyncError('That repository is no longer in gitdesk.');
      const root = ws.rootOf(id);
      const status = row.status;
      const t = await tracking(root);
      const remote = t.remote;
      let state: SyncState;
      if (!status || status.detached || !t.branch) state = 'detached';
      else if (!status.hasRemotes) state = 'no-remote';
      // With no commits yet, Git calls the upstream gone only because nothing was ever pushed.
      else if (!t.upstream || status.headOid === null) state = 'no-upstream';
      else if (status.ahead === null || status.behind === null) state = 'gone';
      else if (status.ahead && status.behind) state = 'diverged';
      else if (status.ahead) state = 'ahead';
      else if (status.behind) state = 'behind';
      else state = 'up-to-date';
      const marks = remote
        ? journal.marks(id, remote)
        : { fetchedAt: null, pushedAt: null };
      const fetchedAt = marks.fetchedAt ?? status?.fetchedAt ?? null;
      return {
        branch: t.branch,
        upstream: t.upstream,
        remote,
        state,
        noCommits: !!status && !status.detached && status.headOid === null,
        ahead: status?.ahead ?? null,
        behind: status?.behind ?? null,
        changed: status
          ? status.staged +
            status.unstaged +
            status.untracked +
            status.conflicts
          : 0,
        fetchedAt,
        pushedAt: marks.pushedAt,
        stale: !fetchedAt || now() - fetchedAt > STALE_AFTER_MS,
        pending: journal.pending(id),
        recent: journal.recent(id, 5),
      };
    },

    async compare(id: string): Promise<UpstreamComparison> {
      const root = ws.rootOf(id);
      const t = await tracking(root);
      if (!t.upstream)
        throw new SyncError(
          "This branch doesn't track a remote branch, so there's nothing to compare.",
        );
      const [head, upstreamOid] = await Promise.all([
        ws.headOid(root),
        refOid(root, `refs/remotes/${t.upstream}`),
      ]);
      if (!head || !upstreamOid)
        throw new SyncError(
          `${t.upstream} isn't here. It may have been deleted on the remote; fetch to check.`,
        );
      const [outgoing, incoming] = await Promise.all([
        compare(root, upstreamOid, head),
        compare(root, head, upstreamOid),
      ]);
      return { upstream: t.upstream, outgoing, incoming };
    },

    async fileDiff(input: {
      id: string;
      side: 'outgoing' | 'incoming';
      path: string;
      oldPath: string | null;
      context: number;
      ignoreWhitespace: boolean;
      full: boolean;
    }): Promise<DiffResult> {
      const root = ws.rootOf(input.id);
      const t = await tracking(root);
      const [head, upstreamOid] = await Promise.all([
        ws.headOid(root),
        t.upstream ? refOid(root, `refs/remotes/${t.upstream}`) : null,
      ]);
      if (!head || !upstreamOid)
        throw new SyncError("There's no upstream to compare with any more.");
      const base = await mergeBase(root, head, upstreamOid);
      if (!base) throw new SyncError('These branches share no history.');
      return fileDiff(root, {
        base,
        source: input.side === 'outgoing' ? head : upstreamOid,
        path: input.path,
        oldPath: input.oldPath,
        context: input.context,
        ignoreWhitespace: input.ignoreWhitespace,
        full: input.full,
      });
    },

    // Asks the server for the upstream's tip without downloading anything.
    async check(id: string): Promise<RemoteCheck> {
      const root = ws.rootOf(id);
      const t = await tracking(root);
      if (!t.remote || !t.merge || !t.upstream)
        return {
          status: 'failed',
          code: 'NO_UPSTREAM',
          message: PULL_STOPS.NO_UPSTREAM!,
        };
      try {
        const [tip, known] = await Promise.all([
          ws.lsRemote(id, t.remote, t.merge),
          refOid(root, `refs/remotes/${t.upstream}`),
        ]);
        return { status: tip === known ? 'same' : 'moved', oid: tip };
      } catch (err) {
        const text = errorText(err);
        const reason =
          err instanceof UserError ? 'auth' : classifyFetchError(text);
        return {
          status: 'failed',
          code: syncCodeFor(reason, text),
          message:
            err instanceof UserError
              ? err.message
              : reason === 'network'
                ? "Couldn't reach the remote. Check your connection and try again."
                : "The remote didn't answer the check.",
        };
      }
    },

    pull(input: {
      id: string;
      jobId: string;
      strategy: PullStrategy;
    }): Promise<PullResult> {
      return ws.serial(input.id, async () => {
        try {
          return await runPull(input.id, input.jobId, input.strategy);
        } finally {
          await deps.refresh(input.id).catch(() => undefined);
        }
      });
    },

    cancel(jobId: string): void {
      ws.cancelFetch(jobId);
    },

    publish(input: {
      id: string;
      jobId: string;
      remote: string;
      branch: string;
    }): Promise<PushResult> {
      return ws.publish(input);
    },

    setUpstream(input: {
      id: string;
      remote: string;
      branch: string;
    }): Promise<void> {
      return ws.serial(input.id, () => ws.setUpstream(input));
    },

    // Settles a push whose result was unknown from what the remote holds now. Nothing is pushed.
    async checkPush(input: {
      id: string;
      operationId: string;
    }): Promise<CheckResult> {
      const op = journal.get(input.operationId);
      if (
        !op ||
        op.repositoryId !== input.id ||
        op.kind !== 'push' ||
        !op.remote ||
        !op.branch
      )
        throw new SyncError('That push is no longer in gitdesk.');
      let tip: string | null;
      try {
        tip = await ws.lsRemote(input.id, op.remote, `refs/heads/${op.branch}`);
      } catch (err) {
        return {
          status: 'unreachable',
          message:
            err instanceof UserError
              ? err.message
              : "Couldn't reach the remote, so the push is still unconfirmed. Try again when you're online.",
        };
      }
      if (tip && tip === op.newOid) {
        const done = journal.update(op.id, {
          state: 'completed',
          code: null,
          message: null,
        });
        journal.markPushed(input.id, op.remote);
        if (done) void report(done);
        await deps.refresh(input.id).catch(() => undefined);
        return { status: 'completed' };
      }
      journal.update(op.id, {
        state: 'failed',
        code: tip === op.oldOid ? 'REMOTE_UNAVAILABLE' : 'STALE_REFERENCE',
        message:
          tip === op.oldOid
            ? "The remote didn't take the push. Push again."
            : 'The remote moved to another commit. Fetch to see it before pushing.',
      });
      return tip === op.oldOid
        ? { status: 'not-pushed' }
        : { status: 'moved', remoteOid: tip ?? '' };
    },

    accountActivity(input: {
      cursor: string | null;
      result: 'all' | 'unverified';
    }): Promise<AccountPushPage> {
      if (!deps.account)
        throw new SyncError('Sign in to see the pushes your account recorded.');
      return deps.account.list(input);
    },

    accountStats(): Promise<AccountPushStats> {
      if (!deps.account)
        throw new SyncError('Sign in to see the pushes your account recorded.');
      return deps.account.stats();
    },

    activity(input: {
      filter: 'all' | 'failed' | 'unconfirmed';
      offset: number;
    }): SyncActivityPage {
      return journal.page({ ...input, limit: SYNC_PAGE });
    },

    // Called by the workspace after every successful push.
    pushed(op: SyncOperation): void {
      void report(op).then(() => retryReports());
    },

    // At start-up: a fetch a crash cut off simply failed; a push may or may not have landed; a pull
    // that was merging is either waiting on conflicts or never got going.
    async recover(): Promise<void> {
      for (const op of journal.interrupted()) {
        if (op.kind === 'push') {
          journal.update(op.id, {
            state: 'unknown',
            code: 'OPERATION_RESULT_UNKNOWN',
            message:
              "gitdesk closed while this push ran, so it can't tell whether the remote took it. Check status asks the remote.",
          });
          continue;
        }
        let waiting = false;
        if (op.kind === 'pull') {
          const row = deps.store.get(op.repositoryId);
          waiting =
            !!row &&
            ((await exists(row.rootPath, 'MERGE_HEAD').catch(() => false)) ||
              (await exists(row.rootPath, 'rebase-merge').catch(() => false)) ||
              (await exists(row.rootPath, 'rebase-apply').catch(() => false)));
        }
        journal.update(
          op.id,
          waiting
            ? { state: 'conflict_resolution', code: 'LOCAL_CONFLICT' }
            : {
                state: 'failed',
                code: 'FAILED',
                message: 'gitdesk closed before this finished.',
              },
        );
      }
      journal.prune();
      retryReports();
    },
  };
}

export type SyncService = ReturnType<typeof createSyncService>;
