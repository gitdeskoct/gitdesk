import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import type {
  AddCommentInput,
  MergeInput,
  PullFileDiffInput,
  PullStatRange,
  PullStatus,
  SubmitReviewInput,
  UpdatePullInput,
} from '../../shared/pulls';

// Pull request queries. Records (list, comments, reviews, activity) and Git facts (the live
// comparison, diffs, conflicts) live under separate keys, and each write invalidates only what
// it changed.

const pulls = () => window.desktop.pulls;

export const pullKeys = {
  repo: (repoId: string) => ['pulls', repoId] as const,
  list: (repoId: string, status: PullStatus, q: string) =>
    ['pulls', repoId, 'list', status, q] as const,
  stats: (repoId: string, range: PullStatRange) =>
    ['pulls', repoId, 'stats', range] as const,
  overview: ['pulls-overview'] as const,
  pull: (repoId: string, id: string) => ['pull', repoId, id] as const,
  // The live comparison changes when a branch moves, which the repository's status records.
  detail: (repoId: string, id: string, statusAt: number | null) =>
    ['pull', repoId, id, 'detail', statusAt] as const,
  // Line positions are worked out against the latest snapshot, so a new one refetches them.
  comments: (repoId: string, id: string, version: number) =>
    ['pull', repoId, id, 'comments', version] as const,
  reviews: (repoId: string, id: string) =>
    ['pull', repoId, id, 'reviews'] as const,
  activity: (repoId: string, id: string) =>
    ['pull', repoId, id, 'activity'] as const,
  viewed: (repoId: string, id: string, version: number) =>
    ['pull', repoId, id, 'viewed', version] as const,
  diff: (input: PullFileDiffInput) =>
    ['pull', input.repoId, input.id, 'diff', input] as const,
  revert: (repoId: string, id: string) =>
    ['pull', repoId, id, 'revert'] as const,
  compare: (
    repoId: string,
    source: string,
    target: string,
    statusAt: number | null,
  ) => ['pulls', repoId, 'compare', source, target, statusAt] as const,
  conflicts: (repoId: string, statusAt: number | null) =>
    ['pull-conflicts', repoId, statusAt] as const,
  sides: (repoId: string, path: string, statusAt: number | null) =>
    ['pull-conflicts', repoId, 'sides', path, statusAt] as const,
};

type Client = ReturnType<typeof useQueryClient>;

function invalidatePull(qc: Client, repoId: string, id: string) {
  void qc.invalidateQueries({ queryKey: pullKeys.pull(repoId, id) });
  void qc.invalidateQueries({ queryKey: pullKeys.repo(repoId) });
  void qc.invalidateQueries({ queryKey: pullKeys.overview });
}

// A merge, revert or conflict step moved refs and files: the repository's own views refresh too.
function invalidateGit(qc: Client, repoId: string) {
  void qc.invalidateQueries({ queryKey: ['pull', repoId] });
  void qc.invalidateQueries({ queryKey: pullKeys.repo(repoId) });
  void qc.invalidateQueries({ queryKey: pullKeys.overview });
  void qc.invalidateQueries({ queryKey: ['pull-conflicts', repoId] });
  for (const prefix of [
    'repo-changes',
    'ws-branches',
    'ws-log',
    'repo-history',
    'ws-analytics',
    'ws-diff',
  ])
    void qc.invalidateQueries({ queryKey: [prefix, repoId] });
  void qc.invalidateQueries({ queryKey: ['repo-activity'] });
}

export const usePullList = (
  repoId: string,
  status: PullStatus,
  q: string,
  enabled = true,
) =>
  useInfiniteQuery({
    queryKey: pullKeys.list(repoId, status, q),
    queryFn: ({ pageParam }) =>
      pulls().list({ repoId, status, q, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 30_000,
    placeholderData: (previous) => previous,
    enabled,
  });

export const usePullOverview = () =>
  useQuery({
    queryKey: pullKeys.overview,
    queryFn: () => pulls().overview(),
    staleTime: 30_000,
  });

export const usePullStats = (
  repoId: string,
  range: PullStatRange,
  enabled = true,
) =>
  useQuery({
    queryKey: pullKeys.stats(repoId, range),
    queryFn: () => pulls().stats({ repoId, range }),
    staleTime: 60_000,
    placeholderData: (previous) => previous,
    enabled,
  });

export const useComparePreview = (
  repoId: string,
  source: string | null,
  target: string | null,
  statusAt: number | null,
) =>
  useQuery({
    queryKey: pullKeys.compare(repoId, source ?? '', target ?? '', statusAt),
    queryFn: () =>
      pulls().compare({ repoId, source: source!, target: target! }),
    enabled: !!source && !!target,
    staleTime: Infinity,
  });

export const usePullDetail = (
  repoId: string,
  id: string,
  statusAt: number | null,
) =>
  useQuery({
    queryKey: pullKeys.detail(repoId, id, statusAt),
    queryFn: () => pulls().get({ repoId, id }),
    staleTime: 30_000,
    placeholderData: (previous) => previous,
  });

export const usePullComments = (
  repoId: string,
  id: string,
  version: number,
  enabled = true,
) =>
  useQuery({
    queryKey: pullKeys.comments(repoId, id, version),
    queryFn: () => pulls().comments({ repoId, id }),
    staleTime: 30_000,
    enabled,
  });

export const usePullReviews = (repoId: string, id: string) =>
  useQuery({
    queryKey: pullKeys.reviews(repoId, id),
    queryFn: () => pulls().reviews({ repoId, id }),
    staleTime: 30_000,
  });

export const usePullActivity = (repoId: string, id: string) =>
  useInfiniteQuery({
    queryKey: pullKeys.activity(repoId, id),
    queryFn: ({ pageParam }) =>
      pulls().activity({ repoId, id, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    staleTime: 30_000,
  });

export const useViewedFiles = (
  repoId: string,
  id: string,
  version: number | null,
) =>
  useQuery({
    queryKey: pullKeys.viewed(repoId, id, version ?? 0),
    queryFn: () => pulls().viewed({ repoId, id, version: version! }),
    enabled: version !== null,
    staleTime: Infinity,
  });

export const usePullFileDiff = (input: PullFileDiffInput | null) =>
  useQuery({
    queryKey: input ? pullKeys.diff(input) : ['pull', 'none'],
    queryFn: () => pulls().fileDiff(input!),
    enabled: !!input,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
  });

export const useRevertInfo = (repoId: string, id: string, enabled: boolean) =>
  useQuery({
    queryKey: pullKeys.revert(repoId, id),
    queryFn: () => pulls().revertInfo({ repoId, id }),
    enabled,
    staleTime: Infinity,
  });

export const useConflicts = (
  repoId: string,
  statusAt: number | null,
  enabled = true,
) =>
  useQuery({
    queryKey: pullKeys.conflicts(repoId, statusAt),
    queryFn: () => pulls().conflicts(repoId),
    // Resolving happens in an editor too, and editing a conflicted file changes no status: read
    // again whenever the window comes back.
    staleTime: 0,
    enabled,
  });

export const useConflictSides = (
  repoId: string,
  path: string | null,
  statusAt: number | null,
) =>
  useQuery({
    queryKey: pullKeys.sides(repoId, path ?? '', statusAt),
    queryFn: () => pulls().conflictSides({ repoId, path: path! }),
    enabled: !!path,
    staleTime: 0,
  });

export function useCreatePull(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (
      input: Omit<Parameters<typeof window.desktop.pulls.create>[0], 'repoId'>,
    ) => pulls().create({ repoId, ...input }),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: pullKeys.repo(repoId) });
      void qc.invalidateQueries({ queryKey: pullKeys.overview });
    },
  });
}

export function useUpdatePull(repoId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: Omit<UpdatePullInput, 'repoId' | 'id'>) =>
      pulls().update({ repoId, id, ...patch }),
    onSettled: () => invalidatePull(qc, repoId, id),
  });
}

export function useSetPullStatus(repoId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (status: 'open' | 'closed') =>
      pulls().setStatus({ repoId, id, status }),
    onSettled: () => invalidatePull(qc, repoId, id),
  });
}

export function useCheckMergeability(repoId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => pulls().checkMergeability({ repoId, id }),
    onSettled: () => invalidatePull(qc, repoId, id),
  });
}

export function useAddComment(repoId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<AddCommentInput, 'repoId' | 'id'>) =>
      pulls().addComment({ repoId, id, ...input }),
    onSettled: () => invalidatePull(qc, repoId, id),
  });
}

export function useEditComment(repoId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      commentId: string;
      body?: string;
      resolved?: boolean;
    }) => pulls().editComment({ repoId, id, ...input }),
    onSettled: () => invalidatePull(qc, repoId, id),
  });
}

export function useDeleteComment(repoId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (commentId: string) =>
      pulls().deleteComment({ repoId, id, commentId }),
    onSettled: () => invalidatePull(qc, repoId, id),
  });
}

export function useSubmitReview(repoId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<SubmitReviewInput, 'repoId' | 'id'>) =>
      pulls().submitReview({ repoId, id, ...input }),
    onSettled: () => invalidatePull(qc, repoId, id),
  });
}

export function useSetViewed(repoId: string, id: string, version: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { path: string; viewed: boolean }) =>
      pulls().setViewed({ repoId, id, version, ...input }),
    onSuccess: (paths) =>
      qc.setQueryData(pullKeys.viewed(repoId, id, version), paths),
  });
}

export function useMergePull(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<MergeInput, 'repoId'>) =>
      pulls().merge({ repoId, ...input }),
    onSettled: () => invalidateGit(qc, repoId),
  });
}

export function useResolveConflict(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: {
      path: string;
      take: 'target' | 'source' | 'working';
    }) => pulls().resolveConflict({ repoId, ...input }),
    onSettled: () => invalidateGit(qc, repoId),
  });
}

export function useContinueMerge(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => pulls().continueMerge(repoId),
    onSettled: () => invalidateGit(qc, repoId),
  });
}

export function useAbortMerge(repoId: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => pulls().abortMerge(repoId),
    onSettled: () => invalidateGit(qc, repoId),
  });
}

export function useRevertPull(repoId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: { mainline: 1 | 2 | null; branch: string | null }) =>
      pulls().revert({ repoId, id, ...input }),
    onSettled: () => invalidateGit(qc, repoId),
  });
}

export function useDeletePullBranch(repoId: string, id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => pulls().deleteBranch({ repoId, id }),
    onSettled: () => invalidateGit(qc, repoId),
  });
}
