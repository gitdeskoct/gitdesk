import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import type {
  AddCommentInput,
  CommentAnchor,
  ComparePreview,
  Comparison,
  CompareProblem,
  ConflictFile,
  ConflictOperation,
  ConflictSides,
  ConflictState,
  ContinueResult,
  CreatePullInput,
  MergeInput,
  MergeOperation,
  MergeOperationState,
  MergeResult,
  PullActivityPage,
  PullAuthor,
  PullComment,
  PullDetail,
  PullFileDiffInput,
  PullListInput,
  PullOverview,
  PullPage,
  PullRef,
  PullRequest,
  PullReview,
  PullStatRange,
  PullStats,
  RevertInfo,
  RevertResult,
  SubmitReviewInput,
  UpdatePullInput,
} from '../../shared/pulls';
import type {
  BranchMergeMethod,
  BranchMergeResult,
} from '../../shared/branches';
import type { DiffResult, PushResult } from '../../shared/workspace';
import type { AppDatabase } from '../db/database';
import { UserError } from '../errors';
import { describeGitError, gitAt, gitBytes } from '../repos/git-inspector';
import { parseStatusPaths } from '../repos/git-status';
import { resolveInside } from '../repos/paths';
import type { RepositoryStore } from '../repos/repository-store';
import { sanitizeOutput } from '../repos/workspace-service';
import {
  checkMergeability,
  compare as compareRefs,
  fileDiff,
  gitPath,
  isAncestor,
  lineHash,
  resolveBranch,
  stageText,
  unmergedFiles,
} from './pull-git';
import {
  PullNotFound,
  type PullRecords,
  type ReportedEvent,
  type StoredComment,
} from './records';

export class PullError extends UserError {}

const MERGE_TIMEOUT_MS = 120_000;
const CONFLICT_MARKER = /^(<{7}|>{7})(\s|$)/m;
const MAX_WORKING_BYTES = 2 * 1024 * 1024;
// shortcut: a working file larger than this is overwritten without a saved copy; stream it if that matters.
const MAX_COPY_BYTES = 64 * 1024 * 1024;
const LOCKED =
  'Another Git process is using this repository, so nothing changed. gitdesk leaves its lock alone; try again when it finishes.';

type Workspace = {
  serial<T>(id: string, fn: () => Promise<T>): Promise<T>;
  rootOf(id: string): string;
  lockHeld(id: string): Promise<boolean>;
  // Settings › Git › Keep a copy: saves bytes about to be overwritten; false when the setting is off.
  keepCopy(
    id: string,
    label: string,
    bytes: Buffer,
    suffix: string,
  ): Promise<boolean>;
  operationInProgress(id: string): Promise<boolean>;
  push(input: { id: string; jobId: string }): Promise<PushResult>;
};

type OpRow = {
  id: string;
  repository_id: string;
  pull_id: string | null;
  kind: 'merge' | 'revert' | 'pull' | 'branch-merge';
  state: MergeOperationState;
  strategy: MergeOperation['strategy'];
  source_oid: string;
  target_oid: string;
  result_oid: string | null;
  push: number;
  recorded: number;
  head_ref: string | null;
  conflicts_json: string;
  message: string | null;
  commit_message: string | null;
  // A pull of the upstream: the upstream (origin/main) and the local branch it went into. A branch
  // merge keeps its two names the same way: remote is the source, branch the target.
  remote: string | null;
  branch: string | null;
  updated_at: number;
};

const toOperation = (row: OpRow): MergeOperation => ({
  id: row.id,
  pullId: row.pull_id,
  kind: row.kind,
  state: row.state,
  strategy: row.strategy,
  sourceOid: row.source_oid,
  targetOid: row.target_oid,
  resultOid: row.result_oid,
  message: row.message,
  updatedAt: row.updated_at,
});

const errorText = (err: unknown) =>
  err instanceof Error ? err.message : String(err);

export function createPullService(deps: {
  db: AppDatabase;
  store: RepositoryStore;
  workspace: Workspace;
  // Local SQLite for an unlinked repository, the account for a linked one. Throws a UserError
  // when a linked repository can't reach the account (signed out, local-only).
  recordsFor(repoId: string): PullRecords;
  author(): Promise<PullAuthor>;
  viewed: {
    list(pullId: string, version: number): string[];
    set(pullId: string, version: number, path: string, viewed: boolean): void;
  };
  addActivity(
    repoId: string,
    type: 'pr-merged' | 'pr-reverted' | 'pulled' | 'branch-merged',
    detail: string | null,
  ): void;
  refresh(repoId: string): Promise<void>;
  now?: () => number;
  log?: Pick<Console, 'warn'>;
}) {
  const now = deps.now ?? Date.now;
  const log = deps.log ?? console;

  // Account failures surface as UserErrors from the records; a missing pull request reads as one.
  async function pullOf(
    records: PullRecords,
    id: string,
  ): Promise<PullRequest> {
    const pull = await records.get(id).catch((err: unknown) => {
      if (err instanceof PullNotFound) return null;
      throw err;
    });
    if (!pull) throw new PullError('That pull request no longer exists.');
    return pull;
  }

  async function wrap<T>(work: () => Promise<T>): Promise<T> {
    try {
      return await work();
    } catch (err) {
      if (err instanceof UserError) throw err;
      if (err instanceof PullNotFound)
        throw new PullError('That pull request no longer exists.');
      log.warn('pull request step failed', err);
      // Raw Git text can carry paths and config; only UserError messages reach the renderer.
      throw new PullError('That step failed. Check the logs for details.');
    }
  }

  // Events are part of the record, but a merge or a check never fails because one couldn't be written.
  async function report(
    records: PullRecords,
    id: string,
    type: ReportedEvent,
    detail: string | null,
  ) {
    try {
      await records.recordEvent(id, type, detail, await deps.author());
    } catch (err) {
      log.warn('pull request event not recorded', err);
    }
  }

  async function git(
    root: string,
    args: string[],
    timeoutMs?: number,
  ): Promise<string> {
    try {
      return await gitAt(root, { timeoutMs }).raw(args);
    } catch (err) {
      throw new PullError(describeGitError(err));
    }
  }

  // Index writes for conflict steps: Git's exit code decides, and a held lock is reported, never raced.
  async function gitIndex(root: string, args: string[]): Promise<void> {
    const result = await gitBytes(root, args, {
      maxBytes: 1024 * 1024,
      timeoutMs: 60_000,
    }).catch((err: unknown) => {
      throw new PullError(describeGitError(err));
    });
    if (result.code === 0) return;
    if (/index\.lock|Another git process/i.test(result.stderr))
      throw new PullError(LOCKED);
    throw new PullError(
      sanitizeOutput(result.stderr, root)?.split('\n')[0] ??
        "Git didn't make that change.",
    );
  }

  async function currentBranch(root: string): Promise<string | null> {
    const name = (
      await gitAt(root)
        .raw(['symbolic-ref', '--quiet', '--short', 'HEAD'])
        .catch(() => '')
    ).trim();
    return name || null;
  }

  async function refCommit(root: string, ref: string): Promise<string | null> {
    const oid = (
      await gitAt(root)
        .raw([
          'rev-parse',
          '--verify',
          '--quiet',
          '--end-of-options',
          `${ref}^{commit}`,
        ])
        .catch(() => '')
    ).trim();
    return /^[0-9a-f]{40,64}$/.test(oid) ? oid : null;
  }

  async function exists(root: string, name: string): Promise<boolean> {
    return stat(path.resolve(root, await gitPath(root, name))).then(
      () => true,
      () => false,
    );
  }

  async function rebasing(root: string): Promise<boolean> {
    return (
      (await exists(root, 'rebase-merge')) ||
      (await exists(root, 'rebase-apply'))
    );
  }

  // A rebase replays your commits onto the upstream, so Git's sides are the other way round:
  // "ours" (stage 2) is the upstream and "theirs" (stage 3) is your commit. The screen keeps
  // Yours and Incoming by swapping them here.
  async function swappedSides(repoId: string, root: string): Promise<boolean> {
    const op = ops.activeFor(repoId);
    // A rebase started outside gitdesk has the same sides as gitdesk's own rebase pull.
    return (
      (!op || (op.kind === 'pull' && String(op.strategy) === 'rebase')) &&
      (await rebasing(root))
    );
  }

  // Git's state file for an operation started outside gitdesk, read as text and capped.
  async function stateFile(root: string, name: string): Promise<string> {
    const target = path.resolve(root, await gitPath(root, name));
    const text = await readFile(target, 'utf8').catch(() => '');
    return text.trim().slice(0, 255);
  }

  // A ref or commit in words: its branch or tag name when one points at it, else a short id.
  async function nameOf(root: string, rev: string): Promise<string> {
    const name = (
      await git(root, ['name-rev', '--name-only', '--no-undefined', rev]).catch(
        () => '',
      )
    ).trim();
    if (name && !/[~^]/.test(name)) return name.replace(/^tags\//, '');
    return (await git(root, ['rev-parse', '--short', rev]).catch(() => rev))
      .trim()
      .slice(0, 64);
  }

  async function externalSides(
    root: string,
    operation: ConflictOperation,
    files: ConflictFile[],
  ): Promise<NonNullable<ConflictState['external']>> {
    const branch = (await currentBranch(root)) ?? 'HEAD';
    const subjectOf = (rev: string) =>
      git(root, ['log', '-1', '--format=%s', rev])
        .then((text) => text.trim().slice(0, 200) || null)
        .catch(() => null);
    // Staged paths belong to the operation itself; working-tree edits outside the conflict are yours.
    const conflicted = new Set(files.map((file) => file.path));
    const otherChanges = parseStatusPaths(
      await git(root, [
        'status',
        '--porcelain=v2',
        '-z',
        '--untracked-files=no',
      ]).catch(() => ''),
    )
      .filter((entry) => entry.y !== '.' && !conflicted.has(entry.path))
      .map((entry) => entry.path)
      .slice(0, 20);
    if (operation === 'rebase') {
      const head = await stateFile(
        root,
        (await exists(root, 'rebase-merge'))
          ? 'rebase-merge/head-name'
          : 'rebase-apply/head-name',
      );
      const onto = await stateFile(
        root,
        (await exists(root, 'rebase-merge'))
          ? 'rebase-merge/onto'
          : 'rebase-apply/onto',
      );
      return {
        ours: head.replace(/^refs\/heads\//, '') || 'your branch',
        theirs: /^[0-9a-f]{7,64}$/.test(onto)
          ? await nameOf(root, onto)
          : 'upstream',
        subject: await subjectOf('REBASE_HEAD'),
        otherChanges,
      };
    }
    const head =
      operation === 'merge'
        ? 'MERGE_HEAD'
        : operation === 'cherry-pick'
          ? 'CHERRY_PICK_HEAD'
          : 'REVERT_HEAD';
    return {
      ours: branch,
      theirs: await nameOf(root, head),
      subject: operation === 'merge' ? null : await subjectOf(head),
      otherChanges,
    };
  }

  // Runs a step that may want an editor or fail quietly: exit codes are checked, and the commit
  // message Git prepared is accepted as it is.
  async function finishStep(root: string, args: string[]): Promise<void> {
    const result = await gitBytes(root, args, {
      maxBytes: 1_000_000,
      timeoutMs: MERGE_TIMEOUT_MS,
      noEditor: true,
    });
    if (result.code !== 0)
      throw new PullError(
        sanitizeOutput(
          `${result.stderr}\n${result.stdout.toString('utf8')}`,
          root,
        ) ?? 'Git stopped this step.',
      );
  }

  // Tracked files with uncommitted changes. Untracked files don't block a merge; Git refuses on
  // its own if one would be overwritten.
  async function trackedChanges(root: string): Promise<string[]> {
    // v2 with -z: a rename's old path is its own field, never mistaken for a changed file.
    const output = await git(root, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=no',
    ]);
    return parseStatusPaths(output, 20).map((entry) => entry.path);
  }

  // Validates a branch pair and computes what a pull request between them would hold.
  async function preview(
    root: string,
    source: string,
    target: string,
  ): Promise<ComparePreview> {
    if (source === target) return { status: 'problem', problem: 'same-branch' };
    const [sourceOid, targetOid] = await Promise.all([
      resolveBranch(root, source),
      resolveBranch(root, target),
    ]);
    if (!sourceOid) return { status: 'problem', problem: 'source-missing' };
    if (!targetOid) return { status: 'problem', problem: 'target-missing' };
    const comparison = await compareRefs(root, targetOid, sourceOid);
    if (!comparison) return { status: 'problem', problem: 'unrelated' };
    if (!comparison.commits.length)
      return { status: 'problem', problem: 'nothing-to-merge' };
    return { status: 'ok', comparison };
  }

  // Operations: one row per merge or revert gitdesk starts, so an interrupted one can be found.
  const ops = {
    insert(
      input: Omit<
        OpRow,
        | 'updated_at'
        | 'result_oid'
        | 'recorded'
        | 'conflicts_json'
        | 'message'
        | 'remote'
        | 'branch'
      > &
        Partial<Pick<OpRow, 'remote' | 'branch'>>,
    ) {
      deps.db
        .prepare(
          `INSERT INTO merge_operations
             (id, repository_id, pull_id, kind, state, strategy, source_oid, target_oid, push, head_ref,
              commit_message, remote, branch, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .run(
          input.id,
          input.repository_id,
          input.pull_id,
          input.kind,
          input.state,
          input.strategy,
          input.source_oid,
          input.target_oid,
          input.push,
          input.head_ref,
          input.commit_message,
          input.remote ?? null,
          input.branch ?? null,
          now(),
          now(),
        );
      return ops.get(input.id)!;
    },
    get(id: string) {
      return deps.db
        .prepare('SELECT * FROM merge_operations WHERE id = ?')
        .get(id) as OpRow | undefined;
    },
    update(
      id: string,
      patch: Partial<
        Pick<
          OpRow,
          'state' | 'result_oid' | 'recorded' | 'conflicts_json' | 'message'
        >
      >,
    ) {
      const row = ops.get(id)!;
      const next = { ...row, ...patch };
      deps.db
        .prepare(
          `UPDATE merge_operations SET state = ?, result_oid = ?, recorded = ?, conflicts_json = ?, message = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(
          next.state,
          next.result_oid,
          next.recorded,
          next.conflicts_json,
          next.message,
          now(),
          id,
        );
      return ops.get(id)!;
    },
    latestFor(pullId: string) {
      return deps.db
        .prepare(
          'SELECT * FROM merge_operations WHERE pull_id = ? ORDER BY updated_at DESC LIMIT 1',
        )
        .get(pullId) as OpRow | undefined;
    },
    activeFor(repoId: string) {
      return deps.db
        .prepare(
          `SELECT * FROM merge_operations WHERE repository_id = ? AND state IN ('merging', 'conflict_resolution')
           ORDER BY updated_at DESC LIMIT 1`,
        )
        .get(repoId) as OpRow | undefined;
    },
  };

  // Finishes the account side of a merge done on this computer: tells the account (once, by
  // operation id) and notes whether the push is still owed.
  async function settle(
    records: PullRecords,
    op: OpRow,
    pushOk: boolean,
  ): Promise<{ row: OpRow; recorded: boolean }> {
    let recorded = op.recorded === 1;
    if (!recorded && op.result_oid) {
      try {
        await records.recordMerge(
          op.pull_id!,
          {
            operationId: op.id,
            mergeCommitOid: op.result_oid,
            targetOid: op.target_oid,
          },
          await deps.author(),
        );
        recorded = true;
      } catch (err) {
        log.warn('merge result not recorded yet', err);
      }
    }
    const state: MergeOperationState = !pushOk
      ? 'push_pending'
      : recorded
        ? 'completed'
        : 'report_pending';
    return {
      row: ops.update(op.id, { state, recorded: recorded ? 1 : 0 }),
      recorded,
    };
  }

  async function finishMerge(
    repoId: string,
    records: PullRecords,
    op: OpRow,
    pull: PullRequest,
    jobId: string,
  ): Promise<MergeResult> {
    const root = deps.workspace.rootOf(repoId);
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    if (!(await isAncestor(root, op.source_oid, head))) {
      const failed = ops.update(op.id, {
        state: 'failed',
        message: 'The merge result does not contain the source.',
      });
      await report(records, pull.id, 'merge_failed', failed.message);
      return {
        status: 'failed',
        message:
          "Git finished, but the target doesn't contain the source. Nothing was recorded as merged.",
      };
    }
    let row = ops.update(op.id, { state: 'locally_merged', result_oid: head });
    deps.addActivity(
      repoId,
      'pr-merged',
      `#${pull.number} ${pull.title}`.slice(0, 200),
    );
    let push: 'pushed' | 'skipped' | 'failed' = 'skipped';
    let pushMessage: string | null = null;
    if (row.push) {
      const result = await deps.workspace.push({ id: repoId, jobId });
      push = result.status === 'pushed' ? 'pushed' : 'failed';
      pushMessage = result.status === 'pushed' ? null : result.message;
      if (result.status === 'pushed')
        await report(
          records,
          pull.id,
          'pushed',
          `${result.remote}/${result.branch}`,
        );
    }
    const settled = await settle(records, row, push !== 'failed');
    row = settled.row;
    return {
      status: 'merged',
      operation: toOperation(row),
      push,
      pushMessage,
      recorded: settled.recorded,
    };
  }

  // A pull of the upstream whose conflicts are resolved: commit the merge and check that it holds
  // the upstream commit pinned when the pull started. Nothing is pushed.
  async function finishPull(
    root: string,
    repoId: string,
    op: OpRow,
  ): Promise<MergeResult> {
    try {
      if (await rebasing(root)) {
        // Commit the resolved step with its own message, so continuing never needs an editor; a
        // step whose resolution left nothing to commit is skipped, as Git would ask.
        const staged = (
          await git(root, ['diff', '--cached', '--name-only'])
        ).trim();
        const run = gitAt(root, { timeoutMs: MERGE_TIMEOUT_MS });
        if (staged) {
          await run.raw(['commit', '--no-edit']);
          await run.raw(['rebase', '--continue']).catch(() => undefined);
        } else await run.raw(['rebase', '--skip']).catch(() => undefined);
        // The next commit may stop on its own conflicts: the screen shows those next.
        const next = await unmergedFiles(root).catch((): ConflictFile[] => []);
        if (next.length) {
          const row = ops.update(op.id, {
            state: 'conflict_resolution',
            conflicts_json: JSON.stringify(next.map((file) => file.path)),
          });
          await deps.refresh(repoId).catch(() => undefined);
          return {
            status: 'conflicts',
            operation: toOperation(row),
            files: next,
          };
        }
        if (await rebasing(root))
          throw new PullError(
            'Git stopped the rebase for another reason. Finish it in your terminal, or abort it here.',
          );
      } else if (await exists(root, 'MERGE_HEAD'))
        await gitAt(root, { timeoutMs: MERGE_TIMEOUT_MS }).raw([
          'commit',
          '--no-edit',
        ]);
    } catch (err) {
      if (err instanceof PullError) throw err;
      throw new PullError(
        sanitizeOutput(errorText(err), root) ?? describeGitError(err),
      );
    }
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    if (!(await isAncestor(root, op.source_oid, head))) {
      ops.update(op.id, {
        state: 'failed',
        message: "The result doesn't contain the upstream commit.",
      });
      return {
        status: 'failed',
        message:
          "Git finished, but the branch doesn't contain the upstream commit. Nothing was recorded as pulled.",
      };
    }
    const row = ops.update(op.id, { state: 'completed', result_oid: head });
    deps.addActivity(repoId, 'pulled', op.remote);
    await deps.refresh(repoId).catch(() => undefined);
    return {
      status: 'merged',
      operation: toOperation(row),
      push: 'skipped',
      pushMessage: null,
      recorded: true,
    };
  }

  // A branch merge Git finished: the target must now contain the source commit pinned at the start.
  async function finishBranchMerge(
    root: string,
    repoId: string,
    op: OpRow,
    jobId: string,
  ): Promise<BranchMergeResult> {
    const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
    if (!(await isAncestor(root, op.source_oid, head))) {
      ops.update(op.id, {
        state: 'failed',
        message: 'The merge result does not contain the source.',
      });
      return {
        status: 'failed',
        message:
          "Git finished, but the target doesn't contain the source, so this isn't reported as merged.",
      };
    }
    let row = ops.update(op.id, { state: 'locally_merged', result_oid: head });
    deps.addActivity(
      repoId,
      'branch-merged',
      `${op.remote ?? 'a branch'} into ${op.branch ?? 'HEAD'}`.slice(0, 200),
    );
    let push: 'pushed' | 'skipped' | 'failed' = 'skipped';
    let pushMessage: string | null = null;
    if (row.push) {
      const result = await deps.workspace.push({ id: repoId, jobId });
      push = result.status === 'pushed' ? 'pushed' : 'failed';
      pushMessage = result.status === 'pushed' ? null : result.message;
    }
    row = ops.update(op.id, {
      state: push === 'failed' ? 'push_pending' : 'completed',
    });
    return {
      status: 'merged',
      operation: toOperation(row),
      fastForward: head === op.source_oid,
      push,
      pushMessage,
    };
  }

  // The working-tree file for a conflicted path, read only when it stays inside the repository.
  async function workingFile(
    root: string,
    rel: string,
  ): Promise<string | null> {
    const inside = await resolveInside(root, rel);
    if (!inside) throw new PullError('That file is outside the repository.');
    // lstat: a symlink is never followed, so a link pointing out of the repository isn't read.
    if (!inside.stat?.isFile()) return null;
    if (inside.stat.size > MAX_WORKING_BYTES) return null;
    return readFile(inside.abs, 'utf8');
  }

  async function conflictState(repoId: string): Promise<ConflictState> {
    const root = deps.workspace.rootOf(repoId);
    const [files, merging, reverting, picking, inRebase, rebase] =
      await Promise.all([
        unmergedFiles(root),
        exists(root, 'MERGE_HEAD'),
        exists(root, 'REVERT_HEAD'),
        exists(root, 'CHERRY_PICK_HEAD'),
        rebasing(root),
        swappedSides(repoId, root),
      ]);
    const op = ops.activeFor(repoId);
    // gitdesk's own pulls, merges and reverts read as before; a rebase pull is shown as a pull.
    const operation: ConflictOperation | null = op
      ? merging
        ? 'merge'
        : reverting || op.kind === 'revert'
          ? 'revert'
          : 'merge'
      : inRebase
        ? 'rebase'
        : picking
          ? 'cherry-pick'
          : merging
            ? 'merge'
            : reverting
              ? 'revert'
              : null;
    const conflicted = op ? (JSON.parse(op.conflicts_json) as string[]) : [];
    const open = new Set(files.map((file) => file.path));
    return {
      operation,
      pullId: op?.pull_id ?? null,
      upstream:
        op?.kind === 'pull' && op.branch && op.remote
          ? { ours: op.branch, theirs: op.remote, rebase }
          : null,
      branchMerge:
        op?.kind === 'branch-merge' && op.branch && op.remote
          ? { target: op.branch, source: op.remote }
          : null,
      files,
      resolved: conflicted.filter((p) => !open.has(p)),
      external:
        !op && operation ? await externalSides(root, operation, files) : null,
    };
  }

  // Finds an anchored line again in the latest comparison: same side, same text, nearest to where
  // it was. A line that can't be found is reported outdated rather than pinned somewhere wrong.
  function locate(diff: DiffResult, anchor: CommentAnchor): number | null {
    if (diff.status !== 'text') return null;
    const wanted = anchor.side === 'new' ? anchor.newLine : anchor.oldLine;
    let best: number | null = null;
    for (const hunk of diff.hunks)
      for (const line of hunk.lines) {
        const number = anchor.side === 'new' ? line.new : line.old;
        if (number === null || lineHash(line.text) !== anchor.contextHash)
          continue;
        if (
          best === null ||
          Math.abs(number - (wanted ?? 0)) < Math.abs(best - (wanted ?? 0))
        )
          best = number;
      }
    return best;
  }

  async function viewComments(
    repoId: string,
    pull: PullRequest,
    stored: StoredComment[],
  ): Promise<PullComment[]> {
    const me = await deps.author();
    const latest = pull.latest;
    const root = deps.workspace.rootOf(repoId);
    const diffs = new Map<string, Promise<DiffResult | null>>();
    const diffFor = (file: string) => {
      if (!latest?.mergeBaseOid) return Promise.resolve(null);
      let pending = diffs.get(file);
      if (!pending) {
        pending = fileDiff(root, {
          base: latest.mergeBaseOid,
          source: latest.sourceOid,
          path: file,
          oldPath: null,
          context: 1_000_000,
          ignoreWhitespace: false,
          full: false,
        }).catch(() => null);
        diffs.set(file, pending);
      }
      return pending;
    };
    return Promise.all(
      stored.map(async (comment): Promise<PullComment> => {
        const mine =
          (me.accountId !== null &&
            comment.author.accountId === me.accountId) ||
          (pull.store === 'local' && comment.author.accountId === null);
        if (!comment.anchor)
          return { ...comment, position: null, outdated: false, mine };
        const anchor = comment.anchor;
        const line = anchor.side === 'new' ? anchor.newLine : anchor.oldLine;
        if (
          latest &&
          anchor.comparisonVersion === latest.version &&
          line !== null
        )
          return {
            ...comment,
            position: { path: anchor.path, side: anchor.side, line },
            outdated: false,
            mine,
          };
        const diff = await diffFor(anchor.path);
        const found = diff ? locate(diff, anchor) : null;
        return found === null
          ? { ...comment, position: null, outdated: true, mine }
          : {
              ...comment,
              position: { path: anchor.path, side: anchor.side, line: found },
              outdated: false,
              mine,
            };
      }),
    );
  }

  // The live picture: the record, Git's comparison right now, and a new snapshot if a ref moved.
  async function detail(repoId: string, id: string): Promise<PullDetail> {
    const records = deps.recordsFor(repoId);
    const root = deps.workspace.rootOf(repoId);
    let pull = await pullOf(records, id);
    let comparison: Comparison | null = null;
    let problem: CompareProblem | null = null;
    const frozen = () =>
      pull.latest
        ? compareRefs(root, pull.latest.targetOid, pull.latest.sourceOid).catch(
            () => null,
          )
        : Promise.resolve(null);
    if (pull.status === 'open') {
      const [sourceOid, targetOid] = await Promise.all([
        resolveBranch(root, pull.sourceRef),
        resolveBranch(root, pull.targetRef),
      ]);
      if (!sourceOid) problem = 'source-missing';
      else if (!targetOid) problem = 'target-missing';
      else {
        comparison = await compareRefs(root, targetOid, sourceOid);
        if (!comparison) problem = 'unrelated';
      }
      // The target already holds every source commit: merged outside gitdesk, or by a merge here
      // that isn't recorded yet. Keep the last snapshot readable instead of recording an empty one.
      if (comparison && !comparison.commits.length && pull.latest) {
        problem = 'nothing-to-merge';
        comparison = await frozen();
      } else if (sourceOid && targetOid)
        pull = await records.recordComparison(
          id,
          {
            sourceOid,
            targetOid,
            mergeBaseOid: comparison?.mergeBaseOid ?? null,
          },
          await deps.author(),
        );
    } else {
      // Closed or merged: the review stays readable as it was, from the last snapshot.
      comparison = await frozen();
    }
    let op = ops.latestFor(id);
    // A merge done here that the account hasn't heard about yet is reported again, same id.
    if (op && op.kind === 'merge' && op.result_oid && op.recorded === 0) {
      const settled = await settle(records, op, op.state !== 'push_pending');
      op = settled.row;
      if (settled.recorded) pull = await pullOf(records, id);
    }
    return {
      pull,
      comparison,
      problem,
      changedSinceReview:
        !!pull.review &&
        !!pull.latest &&
        pull.review.version < pull.latest.version,
      mergeOperation: op ? toOperation(op) : null,
    };
  }

  return {
    async list(input: PullListInput): Promise<PullPage> {
      return wrap(async () => {
        const records = deps.recordsFor(input.repoId);
        const page = await records.list({
          status: input.status,
          q: input.q,
          cursor: input.cursor,
        });
        return { store: records.store, ...page };
      });
    },

    async overview(): Promise<PullOverview> {
      const rows: PullOverview['rows'] = [];
      const unavailable: string[] = [];
      for (const repo of deps.store.list()) {
        try {
          const page = await deps
            .recordsFor(repo.id)
            .list({ status: 'open', q: '', cursor: null });
          for (const pull of page.pulls)
            rows.push({ repository: { id: repo.id, name: repo.name }, pull });
        } catch {
          unavailable.push(repo.name);
        }
      }
      rows.sort((a, b) => b.pull.updatedAt - a.pull.updatedAt);
      return { rows, unavailable };
    },

    compare: (input: { repoId: string; source: string; target: string }) =>
      wrap(() =>
        preview(
          deps.workspace.rootOf(input.repoId),
          input.source,
          input.target,
        ),
      ),

    async create(input: CreatePullInput): Promise<PullRequest> {
      return wrap(async () => {
        const root = deps.workspace.rootOf(input.repoId);
        const checked = await preview(root, input.source, input.target);
        if (checked.status === 'problem')
          throw new PullError(PROBLEM_TEXT[checked.problem]);
        const records = deps.recordsFor(input.repoId);
        const author = await deps.author();
        const pull = await records.create({
          title: input.title,
          description: input.description,
          sourceRef: input.source,
          targetRef: input.target,
          draft: input.draft,
          key: input.key,
          author,
        });
        const { comparison } = checked;
        return records.recordComparison(
          pull.id,
          {
            sourceOid: comparison.sourceOid,
            targetOid: comparison.targetOid,
            mergeBaseOid: comparison.mergeBaseOid,
          },
          author,
        );
      });
    },

    get: (input: PullRef) => wrap(() => detail(input.repoId, input.id)),

    update: (input: UpdatePullInput) =>
      wrap(async () => {
        const records = deps.recordsFor(input.repoId);
        const pull = await pullOf(records, input.id);
        if (pull.status === 'merged')
          throw new PullError('A merged pull request can no longer be edited.');
        return records.update(
          input.id,
          {
            title: input.title,
            description: input.description,
            draft: input.draft,
          },
          await deps.author(),
        );
      }),

    // Reopening checks the branches first: a pull request with a deleted source can't be reviewed.
    setStatus: (input: {
      repoId: string;
      id: string;
      status: 'open' | 'closed';
    }) =>
      wrap(async () => {
        const records = deps.recordsFor(input.repoId);
        const pull = await pullOf(records, input.id);
        if (pull.status === 'merged')
          throw new PullError(
            'A merged pull request stays merged. Revert it to undo its changes.',
          );
        if (input.status === 'open') {
          const root = deps.workspace.rootOf(input.repoId);
          if (!(await resolveBranch(root, pull.sourceRef)))
            throw new PullError(
              `${pull.sourceRef} no longer exists here. Restore the branch, then reopen.`,
            );
          if (!(await resolveBranch(root, pull.targetRef)))
            throw new PullError(
              `${pull.targetRef} no longer exists here. Restore the branch, then reopen.`,
            );
        }
        return records.setStatus(input.id, input.status, await deps.author());
      }),

    // Only the latest comparison's commits: a stale screen asks again instead of reading old ones.
    fileDiff: (input: PullFileDiffInput) =>
      wrap(async () => {
        const records = deps.recordsFor(input.repoId);
        const pull = await pullOf(records, input.id);
        const latest = pull.latest;
        if (
          !latest ||
          latest.mergeBaseOid !== input.base ||
          latest.sourceOid !== input.source
        )
          throw new PullError(
            'The comparison moved on. Refresh to see the latest changes.',
          );
        return fileDiff(deps.workspace.rootOf(input.repoId), {
          base: input.base,
          source: input.source,
          path: input.path,
          oldPath: input.oldPath,
          context: input.context,
          ignoreWhitespace: input.ignoreWhitespace,
          full: input.full,
        });
      }),

    checkMergeability: (input: PullRef) =>
      wrap(async () => {
        const records = deps.recordsFor(input.repoId);
        const root = deps.workspace.rootOf(input.repoId);
        const pull = await pullOf(records, input.id);
        if (pull.status !== 'open')
          throw new PullError('Only an open pull request can be checked.');
        const [sourceOid, targetOid] = await Promise.all([
          resolveBranch(root, pull.sourceRef),
          resolveBranch(root, pull.targetRef),
        ]);
        if (!sourceOid || !targetOid)
          throw new PullError(
            `${sourceOid ? pull.targetRef : pull.sourceRef} no longer exists here.`,
          );
        const author = await deps.author();
        const recorded = await records.recordComparison(
          input.id,
          {
            sourceOid,
            targetOid,
            mergeBaseOid:
              (await compareRefs(root, targetOid, sourceOid))?.mergeBaseOid ??
              null,
          },
          author,
        );
        const check = await checkMergeability(root, targetOid, sourceOid);
        return records.recordCheck(
          input.id,
          recorded.latest!.version,
          check,
          author,
        );
      }),

    comments: (input: PullRef) =>
      wrap(async () => {
        const records = deps.recordsFor(input.repoId);
        const pull = await pullOf(records, input.id);
        return viewComments(
          input.repoId,
          pull,
          await records.comments(input.id),
        );
      }),

    addComment: (input: AddCommentInput) =>
      wrap(async () => {
        const records = deps.recordsFor(input.repoId);
        const pull = await pullOf(records, input.id);
        let anchor: CommentAnchor | null = null;
        if (input.line) {
          const latest = pull.latest;
          if (!latest?.mergeBaseOid)
            throw new PullError('There is no comparison to comment on yet.');
          const diff = await fileDiff(deps.workspace.rootOf(input.repoId), {
            base: latest.mergeBaseOid,
            source: latest.sourceOid,
            path: input.line.path,
            oldPath: null,
            context: 1_000_000,
            ignoreWhitespace: false,
            full: false,
          });
          const { side, line: number } = input.line;
          const line =
            diff.status === 'text'
              ? diff.hunks
                  .flatMap((hunk) => hunk.lines)
                  .find((l) => (side === 'new' ? l.new : l.old) === number)
              : undefined;
          if (!line)
            throw new PullError(
              "That line isn't in the latest changes. Refresh and try again.",
            );
          anchor = {
            comparisonVersion: latest.version,
            sourceOid: latest.sourceOid,
            targetOid: latest.targetOid,
            path: input.line.path,
            side,
            oldLine: line.old,
            newLine: line.new,
            contextHash: lineHash(line.text),
          };
        }
        const stored = await records.addComment(input.id, {
          parentId: input.parentId,
          body: input.body,
          anchor,
          author: await deps.author(),
        });
        const [view] = await viewComments(
          input.repoId,
          await pullOf(records, input.id),
          [stored],
        );
        return view!;
      }),

    editComment: (input: {
      repoId: string;
      id: string;
      commentId: string;
      body?: string;
      resolved?: boolean;
    }) =>
      wrap(async () => {
        const records = deps.recordsFor(input.repoId);
        const stored = await records.editComment(
          input.id,
          input.commentId,
          { body: input.body, resolved: input.resolved },
          await deps.author(),
        );
        const [view] = await viewComments(
          input.repoId,
          await pullOf(records, input.id),
          [stored],
        );
        return view!;
      }),

    deleteComment: (input: { repoId: string; id: string; commentId: string }) =>
      wrap(async () => {
        await deps
          .recordsFor(input.repoId)
          .deleteComment(input.id, input.commentId, await deps.author());
      }),

    reviews: (input: PullRef) =>
      wrap(async () => {
        const records = deps.recordsFor(input.repoId);
        const pull = await pullOf(records, input.id);
        const latest = pull.latest?.version ?? 0;
        return (await records.reviews(input.id)).map(
          (review): PullReview => ({
            ...review,
            stale: review.version < latest,
          }),
        );
      }),

    // A review is about exactly the commits on screen; if they moved on, it is refused.
    submitReview: (input: SubmitReviewInput) =>
      wrap(async () => {
        const records = deps.recordsFor(input.repoId);
        const pull = await pullOf(records, input.id);
        const latest = pull.latest;
        if (!latest || latest.version !== input.version)
          throw new PullError(
            'The branches moved since you opened this. Look at the latest changes, then review.',
          );
        const review = await records.addReview(input.id, {
          decision: input.decision,
          body: input.body,
          version: latest.version,
          sourceOid: latest.sourceOid,
          targetOid: latest.targetOid,
          author: await deps.author(),
        });
        return { ...review, stale: false };
      }),

    activity: (input: {
      repoId: string;
      id: string;
      cursor: string | null;
    }): Promise<PullActivityPage> =>
      wrap(() =>
        deps.recordsFor(input.repoId).activity(input.id, input.cursor),
      ),

    viewed: (input: { repoId: string; id: string; version: number }) =>
      wrap(async () => {
        await pullOf(deps.recordsFor(input.repoId), input.id);
        return deps.viewed.list(input.id, input.version);
      }),

    setViewed: (input: {
      repoId: string;
      id: string;
      version: number;
      path: string;
      viewed: boolean;
    }) =>
      wrap(async () => {
        await pullOf(deps.recordsFor(input.repoId), input.id);
        deps.viewed.set(input.id, input.version, input.path, input.viewed);
        return deps.viewed.list(input.id, input.version);
      }),

    // Git and the record can't change together. The steps run in order, each persisted in
    // merge_operations, and the pull request becomes merged only after Git's result is checked.
    merge: (input: MergeInput) =>
      wrap(() =>
        deps.workspace.serial(input.repoId, async (): Promise<MergeResult> => {
          const records = deps.recordsFor(input.repoId);
          const root = deps.workspace.rootOf(input.repoId);
          const pull = await pullOf(records, input.id);
          const blocked = (
            reason: Extract<MergeResult, { status: 'blocked' }>['reason'],
            message: string,
            files: string[] = [],
          ): MergeResult => ({
            status: 'blocked',
            reason,
            message,
            files,
          });
          if (pull.status !== 'open')
            return blocked(
              'not-open',
              'Only an open pull request can be merged.',
            );
          const [sourceOid, targetOid] = await Promise.all([
            resolveBranch(root, pull.sourceRef),
            resolveBranch(root, pull.targetRef),
          ]);
          if (!sourceOid)
            return blocked(
              'source-missing',
              `${pull.sourceRef} no longer exists here.`,
            );
          if (!targetOid)
            return blocked(
              'target-missing',
              `${pull.targetRef} no longer exists here.`,
            );
          if (sourceOid !== input.sourceOid || targetOid !== input.targetOid)
            return blocked(
              'changed',
              'The branches moved since you confirmed. Look at the latest changes, then merge.',
            );
          if (await deps.workspace.operationInProgress(input.repoId))
            return blocked(
              'operation',
              'Another merge, rebase or revert is in progress. Finish or abort it first.',
            );
          const dirty = await trackedChanges(root);
          if (dirty.length)
            return blocked(
              'local-changes',
              'These files have uncommitted changes. Commit or discard them on Changes first; gitdesk never stashes for you.',
              dirty,
            );
          const startedOn = await currentBranch(root);
          if (startedOn !== pull.targetRef) {
            try {
              await gitAt(root).raw(['switch', '--no-guess', pull.targetRef]);
            } catch (err) {
              const text = errorText(err);
              if (/already (checked out|used by worktree)/i.test(text))
                return blocked(
                  'target-elsewhere',
                  `${pull.targetRef} is checked out in another worktree. Merge it there.`,
                );
              return { status: 'failed', message: describeGitError(err) };
            }
          }
          const message = `Merge pull request #${pull.number}: ${pull.title}\n\nMerges ${pull.sourceRef} into ${pull.targetRef}.`;
          const op = ops.insert({
            id: randomUUID(),
            repository_id: input.repoId,
            pull_id: pull.id,
            kind: 'merge',
            state: 'merging',
            strategy: input.strategy,
            source_oid: sourceOid,
            target_oid: targetOid,
            push: input.push ? 1 : 0,
            head_ref: startedOn,
            commit_message: message,
          });
          await report(
            records,
            pull.id,
            'merge_started',
            `${input.strategy}:${sourceOid}`,
          );
          // A conflicted merge can exit without stderr, which simple-git doesn't treat as an error,
          // so the index decides: unmerged paths mean conflicts whether or not anything threw.
          let thrown: unknown = null;
          await gitAt(root, { timeoutMs: MERGE_TIMEOUT_MS })
            .raw([
              'merge',
              '--no-edit',
              input.strategy === 'no-ff' ? '--no-ff' : '--ff',
              '-m',
              message,
              sourceOid,
            ])
            .catch((err: unknown) => {
              thrown = err;
            });
          const conflicted = await unmergedFiles(root).catch(
            (): ConflictFile[] => [],
          );
          if (
            thrown ||
            conflicted.length ||
            (await exists(root, 'MERGE_HEAD'))
          ) {
            const err = thrown ?? new Error('Git stopped the merge.');
            const files = conflicted;
            if (files.length) {
              const row = ops.update(op.id, {
                state: 'conflict_resolution',
                conflicts_json: JSON.stringify(files.map((file) => file.path)),
              });
              await report(
                records,
                pull.id,
                'merge_conflicts',
                String(files.length),
              );
              await deps.refresh(input.repoId).catch(() => undefined);
              return {
                status: 'conflicts',
                operation: toOperation(row),
                files,
              };
            }
            if (await exists(root, 'MERGE_HEAD'))
              await gitAt(root)
                .raw(['merge', '--abort'])
                .catch(() => undefined);
            const text =
              sanitizeOutput(errorText(err), root) ?? describeGitError(err);
            ops.update(op.id, { state: 'failed', message: text });
            await report(records, pull.id, 'merge_failed', text.slice(0, 200));
            await deps.refresh(input.repoId).catch(() => undefined);
            return { status: 'failed', message: text };
          }
          const result = await finishMerge(
            input.repoId,
            records,
            ops.get(op.id)!,
            pull,
            input.jobId,
          );
          await deps.refresh(input.repoId).catch(() => undefined);
          return result;
        }),
      ),

    // A merge from the Branches tab: no pull request and no record, the same Git steps and the
    // same conflict screen. The commits are pinned to the ones the person compared.
    mergeBranches: (input: {
      repoId: string;
      target: string;
      // A fully qualified ref the caller already found in Git's own branch list.
      sourceRef: string;
      sourceName: string;
      targetOid: string;
      sourceOid: string;
      method: BranchMergeMethod;
      push: boolean;
      jobId: string;
    }) =>
      wrap(() =>
        deps.workspace.serial(
          input.repoId,
          async (): Promise<BranchMergeResult> => {
            const root = deps.workspace.rootOf(input.repoId);
            const blocked = (
              reason: Extract<
                BranchMergeResult,
                { status: 'blocked' }
              >['reason'],
              message: string,
              files: string[] = [],
            ): BranchMergeResult => ({
              status: 'blocked',
              reason,
              message,
              files,
            });
            const [sourceOid, targetOid] = await Promise.all([
              refCommit(root, input.sourceRef),
              resolveBranch(root, input.target),
            ]);
            if (!sourceOid)
              return blocked(
                'source-missing',
                `${input.sourceName} no longer exists here.`,
              );
            if (!targetOid)
              return blocked(
                'target-missing',
                `${input.target} no longer exists here.`,
              );
            if (sourceOid !== input.sourceOid || targetOid !== input.targetOid)
              return blocked(
                'changed',
                'The branches moved since you compared them. Look at the new comparison, then merge.',
              );
            if (await deps.workspace.operationInProgress(input.repoId))
              return blocked(
                'operation',
                'Another merge, rebase or revert is in progress. Finish or abort it first.',
              );
            const dirty = await trackedChanges(root);
            if (dirty.length)
              return blocked(
                'local-changes',
                'These files have uncommitted changes. Commit or discard them on Changes first; gitdesk never stashes for you.',
                dirty,
              );
            if (
              input.method === 'ff-only' &&
              !(await isAncestor(root, targetOid, sourceOid))
            )
              return blocked(
                'not-fast-forward',
                `${input.target} has commits ${input.sourceName} doesn't, so it can't simply move forward. Choose another method to make a merge commit.`,
              );
            const startedOn = await currentBranch(root);
            if (startedOn !== input.target) {
              try {
                await gitAt(root).raw(['switch', '--no-guess', input.target]);
              } catch (err) {
                const text = errorText(err);
                if (/already (checked out|used by worktree)/i.test(text))
                  return blocked(
                    'target-elsewhere',
                    `${input.target} is checked out in another worktree. Merge it there.`,
                  );
                return { status: 'failed', message: describeGitError(err) };
              }
            }
            const message = `Merge ${input.sourceName} into ${input.target}`;
            const op = ops.insert({
              id: randomUUID(),
              repository_id: input.repoId,
              pull_id: null,
              kind: 'branch-merge',
              state: 'merging',
              strategy: input.method,
              source_oid: sourceOid,
              target_oid: targetOid,
              push: input.push ? 1 : 0,
              head_ref: startedOn,
              commit_message: message,
              remote: input.sourceName,
              branch: input.target,
            });
            // As for a pull request merge, the index decides: unmerged paths mean conflicts.
            let thrown: unknown = null;
            await gitAt(root, { timeoutMs: MERGE_TIMEOUT_MS })
              .raw([
                'merge',
                '--no-edit',
                input.method === 'no-ff'
                  ? '--no-ff'
                  : input.method === 'ff-only'
                    ? '--ff-only'
                    : '--ff',
                '-m',
                message,
                sourceOid,
              ])
              .catch((err: unknown) => {
                thrown = err;
              });
            const conflicted = await unmergedFiles(root).catch(
              (): ConflictFile[] => [],
            );
            if (
              thrown ||
              conflicted.length ||
              (await exists(root, 'MERGE_HEAD'))
            ) {
              if (conflicted.length) {
                const row = ops.update(op.id, {
                  state: 'conflict_resolution',
                  conflicts_json: JSON.stringify(
                    conflicted.map((file) => file.path),
                  ),
                });
                await deps.refresh(input.repoId).catch(() => undefined);
                return {
                  status: 'conflicts',
                  operation: toOperation(row),
                  files: conflicted,
                };
              }
              if (await exists(root, 'MERGE_HEAD'))
                await gitAt(root)
                  .raw(['merge', '--abort'])
                  .catch(() => undefined);
              const err = thrown ?? new Error('Git stopped the merge.');
              const text =
                sanitizeOutput(errorText(err), root) ?? describeGitError(err);
              ops.update(op.id, { state: 'failed', message: text });
              await deps.refresh(input.repoId).catch(() => undefined);
              return { status: 'failed', message: text };
            }
            const result = await finishBranchMerge(
              root,
              input.repoId,
              ops.get(op.id)!,
              input.jobId,
            );
            await deps.refresh(input.repoId).catch(() => undefined);
            return result;
          },
        ),
      ),

    conflicts: (repoId: string) => wrap(() => conflictState(repoId)),

    conflictSides: (input: { repoId: string; path: string }) =>
      wrap(async (): Promise<ConflictSides> => {
        const root = deps.workspace.rootOf(input.repoId);
        const file = (await unmergedFiles(root)).find(
          (entry) => entry.path === input.path,
        );
        if (!file) throw new PullError('That file is no longer in conflict.');
        const swap = await swappedSides(input.repoId, root);
        const [base, target, source] = await Promise.all([
          stageText(root, 1, input.path),
          stageText(root, swap ? 3 : 2, input.path),
          stageText(root, swap ? 2 : 3, input.path),
        ]);
        const merged = file.binary ? null : await workingFile(root, input.path);
        return {
          path: input.path,
          binary: file.binary || base.binary || target.binary || source.binary,
          tooLarge: base.tooLarge || target.tooLarge || source.tooLarge,
          base: base.text,
          target: target.text,
          source: source.text,
          merged,
          markers: merged
            ? (merged.match(/^(<{7}|={7}|>{7})(\s|$)/gm) ?? []).length
            : 0,
        };
      }),

    // Taking a side writes that version (or removes the file when that side deleted it) and stages
    // it; "working" stages the edited file. Git then says whether the path is still unmerged.
    resolveConflict: (input: {
      repoId: string;
      path: string;
      take: 'target' | 'source' | 'working';
    }) =>
      wrap(() =>
        deps.workspace.serial(input.repoId, async () => {
          const root = deps.workspace.rootOf(input.repoId);
          if (await deps.workspace.lockHeld(input.repoId))
            throw new PullError(LOCKED);
          const file = (await unmergedFiles(root)).find(
            (entry) => entry.path === input.path,
          );
          if (!file) throw new PullError('That file is no longer in conflict.');
          const swap = await swappedSides(input.repoId, root);
          const stages = await Promise.all(
            (swap ? [3, 2] : [2, 3]).map((s) =>
              stageText(root, s as 2 | 3, input.path),
            ),
          );
          if (input.take === 'working') {
            const text = await workingFile(root, input.path).catch(() => null);
            if (text !== null && CONFLICT_MARKER.test(text))
              throw new PullError(
                'The file still has conflict markers. Edit them out, then mark it resolved.',
              );
            await gitIndex(
              root,
              text === null
                ? ['rm', '--quiet', '--', input.path]
                : ['add', '--', input.path],
            );
          } else {
            const index = input.take === 'target' ? 0 : 1;
            const side = stages[index]!;
            // Taking a side overwrites the working file, edits included: keep a copy first.
            const inside = await resolveInside(root, input.path);
            if (!inside)
              throw new PullError('That file is outside the repository.');
            if (inside.stat?.isFile() && inside.stat.size <= MAX_COPY_BYTES) {
              const working = await readFile(inside.abs);
              if (side.text === null || working.toString('utf8') !== side.text)
                await deps.workspace.keepCopy(
                  input.repoId,
                  input.path,
                  working,
                  '.orig',
                );
            }
            const present = side.text !== null || side.binary || side.tooLarge;
            if (present) {
              await gitIndex(root, [
                'checkout',
                (input.take === 'target') !== swap ? '--ours' : '--theirs',
                '--',
                input.path,
              ]);
              await gitIndex(root, ['add', '--', input.path]);
            } else await gitIndex(root, ['rm', '--quiet', '--', input.path]);
          }
          // Resolved is Git's word, not ours: the path must have left the unmerged entries.
          const still = await gitBytes(
            root,
            ['ls-files', '-u', '-z', '--', input.path],
            {
              maxBytes: 64 * 1024,
            },
          ).catch(() => null);
          await deps.refresh(input.repoId).catch(() => undefined);
          if (!still || still.code !== 0 || still.stdout.length > 0)
            throw new PullError(
              `Git still lists ${input.path} as unmerged, so it isn't resolved yet. Refresh and try again.`,
            );
          return conflictState(input.repoId);
        }),
      ),

    // Commits once Git reports no unmerged path, then finishes the merge or the revert.
    continueMerge: (repoId: string) =>
      wrap(() =>
        deps.workspace.serial(
          repoId,
          async (): Promise<MergeResult | RevertResult | ContinueResult> => {
            const root = deps.workspace.rootOf(repoId);
            const op = ops.activeFor(repoId);
            if ((await unmergedFiles(root)).length)
              throw new PullError(
                'Some files are still in conflict. Resolve each one first.',
              );
            if (!op) {
              const { operation } = await conflictState(repoId);
              if (!operation)
                throw new PullError(
                  'No merge, pick, revert or rebase is in progress.',
                );
              await finishStep(
                root,
                operation === 'merge'
                  ? ['commit', '--no-edit']
                  : [operation, '--continue'],
              );
              const remaining = (await unmergedFiles(root)).length;
              await deps.refresh(repoId).catch(() => undefined);
              return { status: 'continued', operation, remaining };
            }
            if (op.kind === 'pull') return finishPull(root, repoId, op);
            if (op.kind === 'branch-merge') {
              try {
                if (await exists(root, 'MERGE_HEAD'))
                  await gitAt(root, { timeoutMs: MERGE_TIMEOUT_MS }).raw([
                    'commit',
                    '--no-edit',
                  ]);
              } catch (err) {
                throw new PullError(
                  sanitizeOutput(errorText(err), root) ?? describeGitError(err),
                );
              }
              const result = await finishBranchMerge(
                root,
                repoId,
                op,
                randomUUID(),
              );
              await deps.refresh(repoId).catch(() => undefined);
              if (result.status !== 'merged')
                return {
                  status: 'failed',
                  message:
                    result.status === 'failed'
                      ? result.message
                      : 'Git stopped the merge.',
                };
              return {
                status: 'merged',
                operation: result.operation,
                push: result.push,
                pushMessage: result.pushMessage,
                recorded: true,
              };
            }
            const records = deps.recordsFor(repoId);
            const pull = await pullOf(records, op.pull_id!);
            try {
              if (await exists(root, 'MERGE_HEAD'))
                await gitAt(root, { timeoutMs: MERGE_TIMEOUT_MS }).raw([
                  'commit',
                  '--no-edit',
                ]);
              else
                await gitAt(root, { timeoutMs: MERGE_TIMEOUT_MS }).raw([
                  'commit',
                  '-m',
                  op.commit_message ?? `Revert pull request #${pull.number}`,
                ]);
            } catch (err) {
              throw new PullError(
                sanitizeOutput(errorText(err), root) ?? describeGitError(err),
              );
            }
            await gitAt(root)
              .raw(['revert', '--quit'])
              .catch(() => undefined);
            if (op.kind === 'merge') {
              const result = await finishMerge(
                repoId,
                records,
                op,
                pull,
                randomUUID(),
              );
              await deps.refresh(repoId).catch(() => undefined);
              return result;
            }
            const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
            const row = ops.update(op.id, {
              state: 'completed',
              result_oid: head,
            });
            await report(records, pull.id, 'reverted', head);
            deps.addActivity(
              repoId,
              'pr-reverted',
              `#${pull.number} ${pull.title}`.slice(0, 200),
            );
            await deps.refresh(repoId).catch(() => undefined);
            return {
              status: 'reverted',
              oid: head,
              branch: (await currentBranch(root)) ?? '',
              operation: toOperation(row),
            };
          },
        ),
      ),

    // Git's own abort restores the state before the merge. gitdesk started the merge on a clean
    // tree, so nothing of yours is lost; it then goes back to the branch you were on.
    abortMerge: (repoId: string) =>
      wrap(() =>
        deps.workspace.serial(repoId, async () => {
          const root = deps.workspace.rootOf(repoId);
          const op = ops.activeFor(repoId);
          // Git's own abort for each operation; edits outside the conflict are left as they are.
          if (await exists(root, 'MERGE_HEAD'))
            await finishStep(root, ['merge', '--abort']);
          else if ((!op || op.kind === 'pull') && (await rebasing(root)))
            await finishStep(root, ['rebase', '--abort']);
          else if (await exists(root, 'CHERRY_PICK_HEAD'))
            await finishStep(root, ['cherry-pick', '--abort']);
          else if (await exists(root, 'REVERT_HEAD'))
            await finishStep(root, ['revert', '--abort']);
          else if (op) await git(root, ['reset', '--merge']);
          if (op) {
            ops.update(op.id, { state: 'failed', message: 'Aborted.' });
            if (op.pull_id)
              await report(
                deps.recordsFor(repoId),
                op.pull_id,
                'merge_aborted',
                null,
              );
            const current = await currentBranch(root);
            if (op.head_ref && current !== op.head_ref)
              await gitAt(root)
                .raw(['switch', '--no-guess', op.head_ref])
                .catch(() => undefined);
          }
          await deps.refresh(repoId).catch(() => undefined);
          return conflictState(repoId);
        }),
      ),

    revertInfo: (input: PullRef) =>
      wrap(async (): Promise<RevertInfo> => {
        const records = deps.recordsFor(input.repoId);
        const root = deps.workspace.rootOf(input.repoId);
        const pull = await pullOf(records, input.id);
        if (pull.status !== 'merged' || !pull.mergeCommitOid)
          throw new PullError('Only a merged pull request can be reverted.');
        const mergeOid = pull.mergeCommitOid;
        const parents = (
          await git(root, ['rev-list', '--parents', '-n', '1', mergeOid])
        )
          .trim()
          .split(' ')
          .slice(1);
        const isMerge = parents.length > 1;
        const subjects = await Promise.all(
          parents.map(async (oid) => ({
            oid,
            subject: (await git(root, ['log', '-1', '--format=%s', oid]))
              .trim()
              .slice(0, 300),
          })),
        );
        const before = isMerge
          ? null
          : (ops.latestFor(pull.id)?.target_oid ??
            pull.latest?.targetOid ??
            null);
        const from = isMerge ? parents[0]! : before;
        if (!from)
          throw new PullError(
            "gitdesk can't tell what this merge changed, so it can't revert it.",
          );
        const numstat = await git(root, [
          'diff',
          '--no-ext-diff',
          '--numstat',
          from,
          mergeOid,
          '--',
        ]);
        let added = 0;
        let removed = 0;
        let files = 0;
        for (const line of numstat.split('\n')) {
          const match = /^(\d+|-)\t(\d+|-)\t/.exec(line);
          if (!match) continue;
          files++;
          if (match[1] !== '-') added += Number(match[1]);
          if (match[2] !== '-') removed += Number(match[2]);
        }
        return {
          mergeOid,
          isMerge,
          parents: subjects,
          range: before ? { before, after: mergeOid } : null,
          files,
          added: removed,
          removed: added,
        };
      }),

    // A revert adds commits that undo the merge; the pull request stays merged.
    revert: (input: {
      repoId: string;
      id: string;
      mainline: 1 | 2 | null;
      branch: string | null;
    }) =>
      wrap(() =>
        deps.workspace.serial(input.repoId, async (): Promise<RevertResult> => {
          const records = deps.recordsFor(input.repoId);
          const root = deps.workspace.rootOf(input.repoId);
          const pull = await pullOf(records, input.id);
          const blocked = (
            reason: Extract<RevertResult, { status: 'blocked' }>['reason'],
            message: string,
            files: string[] = [],
          ): RevertResult => ({
            status: 'blocked',
            reason,
            message,
            files,
          });
          if (pull.status !== 'merged' || !pull.mergeCommitOid)
            return blocked(
              'not-merged',
              'Only a merged pull request can be reverted.',
            );
          if (await deps.workspace.operationInProgress(input.repoId))
            return blocked(
              'operation',
              'Another merge, rebase or revert is in progress. Finish or abort it first.',
            );
          const dirty = await trackedChanges(root);
          if (dirty.length)
            return blocked(
              'local-changes',
              'These files have uncommitted changes. Commit or discard them first.',
              dirty,
            );
          const parents = (
            await git(root, [
              'rev-list',
              '--parents',
              '-n',
              '1',
              pull.mergeCommitOid,
            ])
          )
            .trim()
            .split(' ')
            .slice(1);
          const isMerge = parents.length > 1;
          if (isMerge && !input.mainline)
            return blocked(
              'mainline',
              'Choose which side of the merge commit to keep.',
            );
          const before = isMerge
            ? null
            : (ops.latestFor(pull.id)?.target_oid ??
              pull.latest?.targetOid ??
              null);
          if (!isMerge && !before)
            return blocked(
              'mainline',
              "gitdesk can't tell what this merge changed.",
            );
          if (input.branch && (await resolveBranch(root, input.branch)))
            return blocked(
              'exists',
              `A branch named ${input.branch} already exists.`,
            );
          const startedOn = await currentBranch(root);
          try {
            if (input.branch)
              await gitAt(root).raw([
                'switch',
                '--no-guess',
                '--create',
                input.branch,
                pull.targetRef,
              ]);
            else if (startedOn !== pull.targetRef)
              await gitAt(root).raw(['switch', '--no-guess', pull.targetRef]);
          } catch (err) {
            return { status: 'failed', message: describeGitError(err) };
          }
          const message = `Revert pull request #${pull.number}: ${pull.title}\n\nThis reverts ${isMerge ? `merge commit ${pull.mergeCommitOid}` : `${before}..${pull.mergeCommitOid}`}.`;
          const op = ops.insert({
            id: randomUUID(),
            repository_id: input.repoId,
            pull_id: pull.id,
            kind: 'revert',
            state: 'merging',
            strategy: null,
            source_oid: pull.mergeCommitOid,
            target_oid: (await git(root, ['rev-parse', 'HEAD'])).trim(),
            push: 0,
            head_ref: startedOn,
            commit_message: message,
          });
          try {
            await gitAt(root, { timeoutMs: MERGE_TIMEOUT_MS }).raw(
              isMerge
                ? [
                    'revert',
                    '--no-commit',
                    '-m',
                    String(input.mainline),
                    pull.mergeCommitOid,
                  ]
                : [
                    'revert',
                    '--no-commit',
                    `${before}..${pull.mergeCommitOid}`,
                  ],
            );
            // Same as merging: unmerged paths mean conflicts even when nothing was thrown.
            if ((await unmergedFiles(root)).length)
              throw new Error('Git stopped the revert.');
            await gitAt(root, { timeoutMs: MERGE_TIMEOUT_MS }).raw([
              'commit',
              '-m',
              message,
            ]);
            await gitAt(root)
              .raw(['revert', '--quit'])
              .catch(() => undefined);
          } catch (err) {
            const files = await unmergedFiles(root).catch(
              (): ConflictFile[] => [],
            );
            if (files.length) {
              const row = ops.update(op.id, {
                state: 'conflict_resolution',
                conflicts_json: JSON.stringify(files.map((file) => file.path)),
              });
              await deps.refresh(input.repoId).catch(() => undefined);
              return {
                status: 'conflicts',
                operation: toOperation(row),
                files,
              };
            }
            await gitAt(root)
              .raw(['revert', '--abort'])
              .catch(() =>
                gitAt(root)
                  .raw(['reset', '--merge'])
                  .catch(() => undefined),
              );
            const text =
              sanitizeOutput(errorText(err), root) ?? describeGitError(err);
            ops.update(op.id, { state: 'failed', message: text });
            await deps.refresh(input.repoId).catch(() => undefined);
            return { status: 'failed', message: text };
          }
          const head = (await git(root, ['rev-parse', 'HEAD'])).trim();
          const row = ops.update(op.id, {
            state: 'completed',
            result_oid: head,
          });
          await report(records, pull.id, 'reverted', head);
          deps.addActivity(
            input.repoId,
            'pr-reverted',
            `#${pull.number} ${pull.title}`.slice(0, 200),
          );
          await deps.refresh(input.repoId).catch(() => undefined);
          return {
            status: 'reverted',
            oid: head,
            branch: input.branch ?? pull.targetRef,
            operation: toOperation(row),
          };
        }),
      ),

    // Git's safe delete: refused when the branch has commits the current branch doesn't.
    deleteBranch: (input: PullRef) =>
      wrap(() =>
        deps.workspace.serial(input.repoId, async () => {
          const records = deps.recordsFor(input.repoId);
          const root = deps.workspace.rootOf(input.repoId);
          const pull = await pullOf(records, input.id);
          if (pull.status !== 'merged')
            throw new PullError(
              'Only the branch of a merged pull request is offered for deletion.',
            );
          if ((await currentBranch(root)) === pull.sourceRef)
            return {
              deleted: false,
              message: `${pull.sourceRef} is checked out. Switch to another branch first.`,
            };
          if (!(await resolveBranch(root, pull.sourceRef)))
            return {
              deleted: false,
              message: `${pull.sourceRef} is already gone.`,
            };
          try {
            await gitAt(root).raw(['branch', '--delete', '--', pull.sourceRef]);
          } catch (err) {
            return {
              deleted: false,
              message: /not fully merged/i.test(errorText(err))
                ? `${pull.sourceRef} has commits that aren't merged, so Git kept it.`
                : describeGitError(err),
            };
          }
          await report(records, pull.id, 'branch_deleted', pull.sourceRef);
          await deps.refresh(input.repoId).catch(() => undefined);
          return { deleted: true, message: null };
        }),
      ),

    stats: (input: { repoId: string; range: PullStatRange }) =>
      wrap(async (): Promise<PullStats> => {
        const records = deps.recordsFor(input.repoId);
        return { store: records.store, ...(await records.stats(input.range)) };
      }),
  };
}

export const PROBLEM_TEXT: Record<CompareProblem, string> = {
  'same-branch': 'Pick two different branches.',
  'source-missing': 'The branch with the changes no longer exists here.',
  'target-missing': 'The branch to merge into no longer exists here.',
  unrelated: 'These branches share no history, so there is nothing to compare.',
  'nothing-to-merge': 'The target already has every commit on that branch.',
};

export type PullService = ReturnType<typeof createPullService>;
