import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { BranchRef, MergeBranchesInput } from '../../shared/branches';
import { invalidateSync, repoKeys } from './queries';

// Branch Management. Every read lives under ws-branches, so the workspace's own invalidations
// (a commit, a switch, a fetch) refresh it too. Mutations wait for the refetch they cause, so a
// button's spinner lasts until Git's new answer is on screen; nothing is updated ahead of Git.

const branches = () => window.desktop.branches;

export const branchKeys = {
  overview: (id: string, statusAt: number | null) =>
    ['ws-branches', id, 'overview', statusAt] as const,
  // Keyed by the tips, so a comparison is a snapshot of two commits and moves only when they do.
  compare: (
    id: string,
    base: BranchRef,
    source: BranchRef,
    tips: [string | null, string | null],
  ) => ['ws-branches', id, 'compare', base, source, tips] as const,
  diff: (input: Parameters<ReturnType<typeof branches>['fileDiff']>[0]) =>
    ['ws-branches', input.id, 'diff', input] as const,
  // A check names its two commits; main caches the answer for exactly that pair.
  mergeability: (id: string, targetOid: string, sourceOid: string) =>
    ['branch-mergeability', id, targetOid, sourceOid] as const,
  list: (id: string, targetOid: string, sourceOids: string[]) =>
    ['branch-mergeability', id, 'list', targetOid, sourceOids] as const,
};

type Client = ReturnType<typeof useQueryClient>;

// A branch change can move the history, the status, the header and Sync, so all of it refreshes.
async function refreshGit(qc: Client, id: string): Promise<void> {
  invalidateSync(qc, id);
  await Promise.all(
    [
      'ws-branches',
      'repo-changes',
      'ws-log',
      'repo-history',
      'ws-analytics',
      'ws-diff',
      'ws-remotes',
      'pull-conflicts',
    ].map((prefix) => qc.invalidateQueries({ queryKey: [prefix, id] })),
  );
  void qc.invalidateQueries({ queryKey: repoKeys.activity });
  void qc.invalidateQueries({ queryKey: repoKeys.list });
}

export const useBranchOverview = (id: string, statusAt: number | null) =>
  useQuery({
    queryKey: branchKeys.overview(id, statusAt),
    queryFn: () => branches().overview(id),
    staleTime: Infinity,
    placeholderData: (previous) => previous,
  });

export const useCompareBranches = (
  id: string,
  base: BranchRef | null,
  source: BranchRef | null,
  tips: [string | null, string | null],
) =>
  useQuery({
    queryKey: branchKeys.compare(
      id,
      base ?? { kind: 'local', name: '' },
      source ?? { kind: 'local', name: '' },
      tips,
    ),
    queryFn: () => branches().compare({ id, base: base!, source: source! }),
    enabled: !!base && !!source,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
  });

export const useBranchFileDiff = (
  input: Parameters<ReturnType<typeof branches>['fileDiff']>[0] | null,
) =>
  useQuery({
    queryKey: branchKeys.diff(
      input ?? {
        id: '',
        baseOid: '',
        sourceOid: '',
        path: '',
        oldPath: null,
        context: 3,
        ignoreWhitespace: false,
        full: false,
      },
    ),
    queryFn: () => branches().fileDiff(input!),
    enabled: !!input,
    staleTime: Infinity,
  });

// Automatic when `enabled`: the check runs on its own for each new pair of commits.
export const useMergeability = (
  id: string,
  targetOid: string | null,
  sourceOid: string | null,
  enabled: boolean,
) =>
  useQuery({
    queryKey: branchKeys.mergeability(id, targetOid ?? '', sourceOid ?? ''),
    queryFn: () =>
      branches().mergeability({
        id,
        targetOid: targetOid!,
        sourceOid: sourceOid!,
      }),
    enabled: enabled && !!targetOid && !!sourceOid,
    staleTime: Infinity,
    retry: false,
  });

export const useListMergeability = (
  id: string,
  targetOid: string | null,
  sourceOids: string[],
  enabled: boolean,
) =>
  useQuery({
    queryKey: branchKeys.list(id, targetOid ?? '', sourceOids),
    queryFn: () =>
      branches().listMergeability({ id, targetOid: targetOid!, sourceOids }),
    enabled: enabled && !!targetOid && sourceOids.length > 0,
    staleTime: Infinity,
    retry: false,
    placeholderData: (previous) => previous,
  });

function useBranchMutation<I, R>(id: string, fn: (input: I) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    // Returned, so isPending covers the refetch as well as Git's own work.
    onSettled: () => refreshGit(qc, id),
  });
}

type Input<K extends keyof ReturnType<typeof branches>> = Omit<
  Parameters<ReturnType<typeof branches>[K]>[0],
  'id'
>;

export const useCreateBranch = (id: string) =>
  useBranchMutation(id, (input: Input<'create'>) =>
    branches().create({ id, ...input }),
  );
export const useRenameBranch = (id: string) =>
  useBranchMutation(id, (input: Input<'rename'>) =>
    branches().rename({ id, ...input }),
  );
export const useDeleteBranch = (id: string) =>
  useBranchMutation(id, (input: Input<'remove'>) =>
    branches().remove({ id, ...input }),
  );
export const useSetBranchUpstream = (id: string) =>
  useBranchMutation(id, (input: Input<'setUpstream'>) =>
    branches().setUpstream({ id, ...input }),
  );
export const usePushBranch = (id: string) =>
  useBranchMutation(id, (input: Input<'push'>) =>
    branches().push({ id, ...input }),
  );
export const useDeleteRemoteBranch = (id: string) =>
  useBranchMutation(id, (input: Input<'deleteRemote'>) =>
    branches().deleteRemote({ id, ...input }),
  );
export const useMergeBranches = (id: string) =>
  useBranchMutation(id, (input: Omit<MergeBranchesInput, 'id'>) =>
    branches().merge({ id, ...input }),
  );
// Reads the remote without downloading: nothing local changes, so nothing is invalidated.
export const useCheckRemote = (id: string) =>
  useMutation({
    mutationFn: (remote: string) => branches().checkRemote({ id, remote }),
  });
