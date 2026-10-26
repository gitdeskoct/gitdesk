import type {
  BranchActionResult,
  BranchBlock,
  BranchComparison,
  BranchMergeResult,
  BranchOverview,
  BranchRef,
  BranchStart,
  BranchTarget,
  DeleteRemoteResult,
  MergeabilityCheck,
  MergeBranchesInput,
  RemoteHeadsCheck,
} from '../../shared/branches';
import { LIST_MERGEABILITY_LIMIT } from '../../shared/branches';
import {
  isProtected,
  type BranchList,
  type DiffResult,
  type PushResult,
} from '../../shared/workspace';
import { UserError } from '../errors';
import {
  checkMergeability,
  compare as compareRefs,
  fileDiff,
  mergeBase,
} from '../pulls/pull-git';
import type { PullService } from '../pulls/pull-service';
import { describeGitError, gitAt, gitBytes } from '../repos/git-inspector';
import type { RepositoryStore } from '../repos/repository-store';
import {
  parseBlockedFiles,
  parseCommitRows,
  sanitizeOutput,
  type WorkspaceService,
} from '../repos/workspace-service';

// Branch Management: Git on this computer owns every ref. This service validates what the
// renderer asks for against Git's own branch list, runs Git with argument arrays, and answers in
// results the page can explain. Nothing here forces, stashes or rewrites a remote it wasn't asked to.

export class BranchError extends UserError {}

const OID = /^[0-9a-f]{40,64}$/;
const WRITE_TIMEOUT_MS = 60_000;
const MAX_OUTPUT = 1_000_000;
// Unique commits a refused delete lists; the total is counted separately.
const MAX_UNMERGED = 50;
const MAX_CACHED_CHECKS = 200;

export function createBranchService(deps: {
  store: Pick<RepositoryStore, 'preferences'>;
  workspace: Pick<
    WorkspaceService,
    | 'branches'
    | 'serial'
    | 'rootOf'
    | 'operationInProgress'
    | 'remoteNames'
    | 'currentBranch'
    | 'pushLocal'
    | 'deleteRemoteBranch'
    | 'lsRemoteHeads'
    | 'setPreferences'
  >;
  pulls: Pick<PullService, 'mergeBranches'>;
  addActivity: (
    id: string,
    type:
      | 'branch-created'
      | 'branch-renamed'
      | 'branch-deleted'
      | 'upstream-set',
    detail: string | null,
  ) => void;
  refresh: (id: string) => Promise<void>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const ws = deps.workspace;
  // Keyed by repository and the exact pair of commits: a moved tip is a new key, never a stale answer.
  const checks = new Map<string, MergeabilityCheck>();

  // Exit codes are read here, since simple-git treats a failure with empty stderr as success.
  async function run(
    root: string,
    args: string[],
  ): Promise<{ code: number | null; stdout: string; stderr: string }> {
    const result = await gitBytes(root, args, {
      maxBytes: MAX_OUTPUT,
      timeoutMs: WRITE_TIMEOUT_MS,
      noEditor: true,
    }).catch((err: unknown) => {
      throw new BranchError(describeGitError(err));
    });
    return { ...result, stdout: result.stdout.toString('utf8') };
  }

  function gitFailure(root: string, stderr: string, fallback: string): never {
    if (/index\.lock|Another git process/i.test(stderr))
      throw new BranchError(
        'Another program is using this repository. Try again when it finishes.',
      );
    throw new BranchError(
      sanitizeOutput(stderr, root)?.split('\n')[0] ?? fallback,
    );
  }

  const blocked = (
    reason: BranchBlock,
    message: string,
    files: string[] = [],
  ): BranchActionResult => ({ status: 'blocked', reason, message, files });

  async function commitOf(root: string, rev: string): Promise<string | null> {
    const oid = (
      await gitAt(root)
        .raw([
          'rev-parse',
          '--verify',
          '--quiet',
          '--end-of-options',
          `${rev}^{commit}`,
        ])
        .catch(() => '')
    ).trim();
    return OID.test(oid) ? oid : null;
  }

  async function validName(root: string, name: string): Promise<boolean> {
    // The schema already refused "@{", so check-ref-format can't expand @{-N} into another ref.
    return (await run(root, ['check-ref-format', '--branch', name])).code === 0;
  }

  const protectedPatterns = (id: string) =>
    deps.store.preferences(id).protectedBranches;

  // The branch Merged, Unmerged and the checks compare against, with where the choice came from.
  async function resolveTarget(
    id: string,
    root: string,
    list: BranchList,
  ): Promise<BranchTarget | null> {
    const find = (name: string) =>
      list.local.find((b) => b.name === name) ??
      list.remote.find((b) => b.name === name);
    const chosen = deps.store.preferences(id).compareAgainst;
    const set = chosen ? find(chosen) : undefined;
    if (chosen && set) return { name: chosen, oid: set.oid, source: 'setting' };
    for (const remote of await ws.remoteNames(root)) {
      const head = (
        await gitAt(root)
          .raw(['symbolic-ref', '--quiet', `refs/remotes/${remote}/HEAD`])
          .catch(() => '')
      ).trim();
      const prefix = `refs/remotes/${remote}/`;
      if (!head.startsWith(prefix)) continue;
      const branch = head.slice(prefix.length);
      const local = list.local.find((b) => b.name === branch);
      if (local)
        return { name: local.name, oid: local.oid, source: 'remote-head' };
      const tracking = list.remote.find(
        (b) => b.name === `${remote}/${branch}`,
      );
      if (tracking)
        return {
          name: tracking.name,
          oid: tracking.oid,
          source: 'remote-head',
        };
    }
    const configured = (
      await gitAt(root)
        .raw(['config', '--get', 'init.defaultBranch'])
        .catch(() => '')
    ).trim();
    for (const name of [configured, 'main', 'master'].filter(Boolean)) {
      const local = list.local.find((b) => b.name === name);
      if (local) return { name, oid: local.oid, source: 'default' };
    }
    const current = list.local.find((b) => b.current);
    return current
      ? { name: current.name, oid: current.oid, source: 'current' }
      : null;
  }

  async function overview(id: string): Promise<BranchOverview> {
    const root = ws.rootOf(id);
    const list = await ws.branches(id);
    const target = await resolveTarget(id, root, list);
    let merged: string[] = [];
    if (target) {
      const out = await gitAt(root)
        .raw([
          'for-each-ref',
          `--merged=${target.oid}`,
          '--format=%(refname)',
          'refs/heads',
        ])
        .catch(() => '');
      merged = out
        .split('\n')
        .map((line) => line.trim())
        .filter((ref) => ref.startsWith('refs/heads/'))
        .map((ref) => ref.slice('refs/heads/'.length));
    }
    const patterns = protectedPatterns(id);
    return {
      ...list,
      target,
      merged,
      protected: list.local
        .filter((b) => isProtected(b.name, patterns))
        .map((b) => b.name),
    };
  }

  // The commits only on `name`, measured the way `git branch -d` decides: against its upstream,
  // or HEAD when it has none.
  async function unmergedCommits(
    root: string,
    name: string,
    upstream: string | null,
  ) {
    const base = upstream ? `refs/remotes/${upstream}` : 'HEAD';
    const range = `${base}..refs/heads/${name}`;
    const [log, count] = await Promise.all([
      gitAt(root)
        .raw([
          'log',
          '--format=%H%x00%P%x00%an%x00%ae%x00%ct%x00%s%x00%D%x1e',
          `--max-count=${MAX_UNMERGED}`,
          range,
          '--',
        ])
        .catch(() => ''),
      gitAt(root)
        .raw(['rev-list', '--count', range])
        .catch(() => '0'),
    ]);
    return { commits: parseCommitRows(log), total: Number(count.trim()) || 0 };
  }

  async function startRef(
    root: string,
    list: BranchList,
    start: BranchStart,
  ): Promise<{ arg: string | null; branch: boolean } | BranchActionResult> {
    switch (start.kind) {
      case 'head':
        return { arg: null, branch: false };
      case 'local': {
        const found = list.local.find((b) => b.name === start.name);
        return found
          ? { arg: `refs/heads/${found.name}`, branch: true }
          : blocked('not-found', `${start.name} isn't a branch here any more.`);
      }
      case 'remote': {
        const found = list.remote.find((b) => b.name === start.name);
        return found
          ? { arg: `refs/remotes/${found.name}`, branch: true }
          : blocked(
              'not-found',
              `${start.name} isn't here. Fetch to update the remote-tracking branches.`,
            );
      }
      case 'commit': {
        const oid = await commitOf(root, start.oid.toLowerCase());
        return oid
          ? { arg: oid, branch: false }
          : blocked(
              'not-found',
              'No commit in this repository matches that hash.',
            );
      }
    }
  }

  // merge-tree writes objects only: no index, working tree or ref changes, so it needs no lock.
  async function mergeability(input: {
    id: string;
    targetOid: string;
    sourceOid: string;
  }): Promise<MergeabilityCheck> {
    const key = `${input.id}:${input.targetOid}:${input.sourceOid}`;
    const cached = checks.get(key);
    if (cached) return cached;
    const root = ws.rootOf(input.id);
    const [target, source] = await Promise.all([
      commitOf(root, input.targetOid),
      commitOf(root, input.sourceOid),
    ]);
    if (!target || !source)
      throw new BranchError(
        'One of these commits is no longer in this repository. Refresh the comparison.',
      );
    const result = await checkMergeability(root, target, source);
    const check: MergeabilityCheck = {
      targetOid: target,
      sourceOid: source,
      mergeability:
        result.mergeability === 'needs_refresh'
          ? 'unknown'
          : result.mergeability,
      reason: result.reason,
      conflicts: result.conflicts,
      checkedAt: now(),
    };
    // A failed run is worth trying again; a real answer stays true for these two commits.
    if (check.reason !== 'failed') {
      if (checks.size >= MAX_CACHED_CHECKS)
        checks.delete(checks.keys().next().value!);
      checks.set(key, check);
    }
    return check;
  }

  return {
    overview,
    mergeability,

    // One branch at a time, so a long list never runs many merges in memory at once.
    async listMergeability(input: {
      id: string;
      targetOid: string;
      sourceOids: string[];
    }): Promise<MergeabilityCheck[]> {
      const results: MergeabilityCheck[] = [];
      for (const sourceOid of [...new Set(input.sourceOids)].slice(
        0,
        LIST_MERGEABILITY_LIMIT,
      )) {
        if (sourceOid === input.targetOid) continue;
        results.push(
          await mergeability({
            id: input.id,
            targetOid: input.targetOid,
            sourceOid,
          }),
        );
      }
      return results;
    },

    create: (input: {
      id: string;
      name: string;
      start: BranchStart;
      switchTo: boolean;
      track: 'git' | 'always' | 'never';
    }) =>
      ws.serial(input.id, async (): Promise<BranchActionResult> => {
        const root = ws.rootOf(input.id);
        if (!(await validName(root, input.name)))
          return blocked(
            'invalid-name',
            "Git can't use that as a branch name.",
          );
        const list = await ws.branches(input.id);
        if (list.local.some((b) => b.name === input.name))
          return blocked(
            'exists',
            `A branch named ${input.name} already exists. Pick another name; gitdesk never replaces a branch.`,
          );
        if (input.switchTo && (await ws.operationInProgress(input.id)))
          return blocked(
            'operation',
            'A merge, rebase or revert is in progress. Finish or abort it before switching.',
          );
        const start = await startRef(root, list, input.start);
        if ('status' in start) return start;
        if (!start.arg && !list.headOid && !input.switchTo)
          return blocked(
            'no-commit',
            'This repository has no commits yet, so a branch has nothing to point at.',
          );
        // --track only means something for a branch start point; a commit has nothing to track.
        const track =
          start.branch && input.track === 'always'
            ? ['--track']
            : input.track === 'never' || !start.branch
              ? ['--no-track']
              : [];
        const args = input.switchTo
          ? [
              'switch',
              '--create',
              input.name,
              ...track,
              ...(start.arg ? [start.arg] : []),
            ]
          : ['branch', ...track, input.name, ...(start.arg ? [start.arg] : [])];
        const result = await run(root, args);
        await deps.refresh(input.id).catch(() => undefined);
        if (result.code !== 0) {
          const files = parseBlockedFiles(result.stderr);
          if (
            files.length ||
            /would be overwritten|Please commit your changes or stash them/i.test(
              result.stderr,
            )
          )
            return blocked(
              'local-changes',
              `Git didn't switch to ${input.name}: your changes to these files would be overwritten. Nothing was created.`,
              files,
            );
          if (/already exists/i.test(result.stderr))
            return blocked(
              'exists',
              `A branch named ${input.name} already exists.`,
            );
          gitFailure(root, result.stderr, "Git didn't create the branch.");
        }
        deps.addActivity(input.id, 'branch-created', input.name);
        return {
          status: 'done',
          branch: input.name,
          switched: input.switchTo,
          upstream: null,
        };
      }),

    rename: (input: { id: string; from: string; to: string }) =>
      ws.serial(input.id, async (): Promise<BranchActionResult> => {
        const root = ws.rootOf(input.id);
        const list = await ws.branches(input.id);
        const branch = list.local.find((b) => b.name === input.from);
        if (!branch)
          return blocked(
            'not-found',
            `${input.from} isn't a branch here any more.`,
          );
        if (isProtected(branch.name, protectedPatterns(input.id)))
          return blocked(
            'protected',
            `${branch.name} is protected in this repository's Settings, so gitdesk won't rename it.`,
          );
        if (branch.otherWorktree)
          return blocked(
            'other-worktree',
            `${branch.name} is checked out in another worktree. Rename it there.`,
          );
        if (input.to === input.from)
          return {
            status: 'done',
            branch: branch.name,
            switched: branch.current,
            upstream: branch.upstream,
          };
        if (list.local.some((b) => b.name === input.to))
          return blocked(
            'exists',
            `A branch named ${input.to} already exists. Pick another name.`,
          );
        if (!(await validName(root, input.to)))
          return blocked(
            'invalid-name',
            "Git can't use that as a branch name.",
          );
        const result = await run(root, ['branch', '-m', branch.name, input.to]);
        await deps.refresh(input.id).catch(() => undefined);
        if (result.code !== 0)
          gitFailure(root, result.stderr, "Git didn't rename the branch.");
        // Compare against follows the branch it named, so a rename doesn't silently reset it.
        if (deps.store.preferences(input.id).compareAgainst === branch.name)
          ws.setPreferences({ id: input.id, compareAgainst: input.to });
        deps.addActivity(
          input.id,
          'branch-renamed',
          `${branch.name} to ${input.to}`.slice(0, 200),
        );
        return {
          status: 'done',
          branch: input.to,
          switched: branch.current,
          upstream: branch.upstream,
        };
      }),

    remove: (input: {
      id: string;
      name: string;
      force: boolean;
      typedName?: string;
    }) =>
      ws.serial(input.id, async (): Promise<BranchActionResult> => {
        const root = ws.rootOf(input.id);
        const list = await ws.branches(input.id);
        const branch = list.local.find((b) => b.name === input.name);
        if (!branch)
          return blocked(
            'not-found',
            `${input.name} isn't a branch here any more.`,
          );
        if (isProtected(branch.name, protectedPatterns(input.id)))
          return blocked(
            'protected',
            `${branch.name} is protected in this repository's Settings, so gitdesk won't delete it.`,
          );
        if (branch.current)
          return blocked(
            'current',
            `${branch.name} is the branch you're on. Switch to another one first.`,
          );
        if (branch.otherWorktree)
          return blocked(
            'other-worktree',
            `${branch.name} is checked out in another worktree, so Git won't delete it.`,
          );
        if (input.force && input.typedName !== branch.name)
          return blocked(
            'confirm-name',
            `Type ${branch.name} exactly to delete it anyway.`,
          );
        const result = await run(root, [
          'branch',
          input.force ? '-D' : '-d',
          branch.name,
        ]);
        if (result.code !== 0) {
          if (/not fully merged/i.test(result.stderr)) {
            const unmerged = await unmergedCommits(
              root,
              branch.name,
              branch.gone ? null : branch.upstream,
            );
            return {
              status: 'not-merged',
              ...unmerged,
              upstream: branch.gone ? null : branch.upstream,
            };
          }
          gitFailure(root, result.stderr, "Git didn't delete the branch.");
        }
        await deps.refresh(input.id).catch(() => undefined);
        deps.addActivity(input.id, 'branch-deleted', branch.name);
        return {
          status: 'done',
          branch: branch.name,
          switched: false,
          upstream: branch.upstream,
        };
      }),

    setUpstream: (input: {
      id: string;
      name: string;
      upstream: string | null;
    }) =>
      ws.serial(input.id, async (): Promise<BranchActionResult> => {
        const root = ws.rootOf(input.id);
        const list = await ws.branches(input.id);
        const branch = list.local.find((b) => b.name === input.name);
        if (!branch)
          return blocked(
            'not-found',
            `${input.name} isn't a branch here any more.`,
          );
        let args: string[];
        if (input.upstream === null) {
          if (!branch.upstream)
            return {
              status: 'done',
              branch: branch.name,
              switched: false,
              upstream: null,
            };
          args = ['branch', '--unset-upstream', branch.name];
        } else {
          const tracking = list.remote.find((b) => b.name === input.upstream);
          if (!tracking)
            return blocked(
              'not-found',
              `${input.upstream} isn't here yet. Fetch first, or publish the branch instead.`,
            );
          args = [
            'branch',
            `--set-upstream-to=refs/remotes/${tracking.name}`,
            branch.name,
          ];
        }
        const result = await run(root, args);
        await deps.refresh(input.id).catch(() => undefined);
        if (result.code !== 0)
          gitFailure(root, result.stderr, "Git didn't change the upstream.");
        deps.addActivity(
          input.id,
          'upstream-set',
          `${branch.name} → ${input.upstream ?? 'none'}`.slice(0, 200),
        );
        return {
          status: 'done',
          branch: branch.name,
          switched: false,
          upstream: input.upstream,
        };
      }),

    async push(input: {
      id: string;
      name: string;
      jobId: string;
    }): Promise<PushResult> {
      const list = await ws.branches(input.id);
      if (!list.local.some((b) => b.name === input.name))
        throw new BranchError(`${input.name} isn't a branch here any more.`);
      return ws.pushLocal(input);
    },

    async deleteRemote(input: {
      id: string;
      remote: string;
      branch: string;
      expectedOid: string;
      typedName: string;
      jobId: string;
    }): Promise<DeleteRemoteResult> {
      if (input.typedName !== input.branch)
        return {
          status: 'failed',
          reason: 'confirm-name',
          message: `Type ${input.branch} exactly to delete it on ${input.remote}.`,
        };
      if (isProtected(input.branch, protectedPatterns(input.id)))
        return {
          status: 'failed',
          reason: 'protected',
          message: `${input.branch} is protected in this repository's Settings, so gitdesk won't delete it anywhere.`,
        };
      const list = await ws.branches(input.id);
      const tracking = list.remote.find(
        (b) => b.remote === input.remote && b.branch === input.branch,
      );
      if (!tracking)
        return {
          status: 'failed',
          reason: 'not-found',
          message: `${input.remote}/${input.branch} isn't here. Fetch to update the list.`,
        };
      return ws.deleteRemoteBranch(input);
    },

    async checkRemote(input: {
      id: string;
      remote: string;
    }): Promise<RemoteHeadsCheck> {
      try {
        const [heads, list] = await Promise.all([
          ws.lsRemoteHeads(input.id, input.remote),
          ws.branches(input.id),
        ]);
        const tracked = list.remote.filter((b) => b.remote === input.remote);
        const known = new Set(tracked.map((b) => b.branch));
        return {
          status: 'checked',
          remote: input.remote,
          at: now(),
          moved: tracked
            .filter((b) => heads.has(b.branch) && heads.get(b.branch) !== b.oid)
            .map((b) => b.name),
          gone: tracked.filter((b) => !heads.has(b.branch)).map((b) => b.name),
          added: [...heads.keys()]
            .filter((name) => !known.has(name))
            .map((name) => `${input.remote}/${name}`)
            .slice(0, 200),
        };
      } catch (err) {
        return {
          status: 'failed',
          remote: input.remote,
          message:
            err instanceof UserError
              ? err.message
              : `Couldn't reach ${input.remote}. The list still shows what the last fetch saw.`,
        };
      }
    },

    async compare(input: {
      id: string;
      base: BranchRef;
      source: BranchRef;
    }): Promise<BranchComparison> {
      const root = ws.rootOf(input.id);
      const list = await ws.branches(input.id);
      const find = (ref: BranchRef) =>
        ref.kind === 'local'
          ? list.local.find((b) => b.name === ref.name)
          : list.remote.find((b) => b.name === ref.name);
      const problem = (
        p: Extract<BranchComparison, { status: 'problem' }>['problem'],
      ) => ({
        status: 'problem' as const,
        problem: p,
        base: input.base.name,
        source: input.source.name,
      });
      if (
        input.base.kind === input.source.kind &&
        input.base.name === input.source.name
      )
        return problem('same-branch');
      const base = find(input.base);
      const source = find(input.source);
      if (!base) return problem('target-missing');
      if (!source) return problem('source-missing');
      if (base.oid === source.oid) return problem('same-commit');
      const comparison = await compareRefs(root, base.oid, source.oid);
      if (!comparison) return problem('unrelated');
      const behind = Number(
        (
          await gitAt(root)
            .raw(['rev-list', '--count', `${source.oid}..${base.oid}`])
            .catch(() => '0')
        ).trim(),
      );
      return {
        status: 'ok',
        base: { name: input.base.name, oid: base.oid, kind: input.base.kind },
        source: {
          name: input.source.name,
          oid: source.oid,
          kind: input.source.kind,
        },
        comparison,
        behind: Number.isFinite(behind) ? behind : 0,
        capturedAt: now(),
      };
    },

    async fileDiff(input: {
      id: string;
      baseOid: string;
      sourceOid: string;
      path: string;
      oldPath: string | null;
      context: number;
      ignoreWhitespace: boolean;
      full: boolean;
    }): Promise<DiffResult> {
      const root = ws.rootOf(input.id);
      const [base, source] = await Promise.all([
        commitOf(root, input.baseOid),
        commitOf(root, input.sourceOid),
      ]);
      if (!base || !source)
        throw new BranchError(
          'One of these commits is no longer in this repository. Refresh the comparison.',
        );
      const split = await mergeBase(root, base, source);
      if (!split) throw new BranchError('These branches share no history.');
      return fileDiff(root, {
        base: split,
        source,
        path: input.path,
        oldPath: input.oldPath,
        context: input.context,
        ignoreWhitespace: input.ignoreWhitespace,
        full: input.full,
      });
    },

    async merge(input: MergeBranchesInput): Promise<BranchMergeResult> {
      const list = await ws.branches(input.id);
      const target = list.local.find((b) => b.name === input.target);
      const blockedMerge = (
        reason: Extract<BranchMergeResult, { status: 'blocked' }>['reason'],
        message: string,
      ): BranchMergeResult => ({
        status: 'blocked',
        reason,
        message,
        files: [],
      });
      if (!target)
        return blockedMerge(
          'target-missing',
          `${input.target} no longer exists here.`,
        );
      if (
        isProtected(target.name, protectedPatterns(input.id)) &&
        !input.confirmProtected
      )
        return blockedMerge(
          'protected',
          `${target.name} is protected, so gitdesk asks once more before merging into it.`,
        );
      const source =
        input.source.kind === 'local'
          ? list.local.find((b) => b.name === input.source.name)
          : list.remote.find((b) => b.name === input.source.name);
      if (!source)
        return blockedMerge(
          'source-missing',
          `${input.source.name} no longer exists here.`,
        );
      if (input.source.kind === 'local' && input.source.name === target.name)
        return blockedMerge(
          'same-branch',
          'A branch can’t be merged into itself.',
        );
      return deps.pulls.mergeBranches({
        repoId: input.id,
        target: target.name,
        sourceRef: `${input.source.kind === 'local' ? 'refs/heads' : 'refs/remotes'}/${input.source.name}`,
        sourceName: input.source.name,
        targetOid: input.targetOid,
        sourceOid: input.sourceOid,
        method: input.method,
        push: input.push,
        jobId: input.jobId,
      });
    },
  };
}

export type BranchService = ReturnType<typeof createBranchService>;
