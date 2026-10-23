import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { PullStrategy, SyncActivityPage } from '../../shared/sync';
import { invalidateSync, repoKeys } from './queries';

// Sync reads are keyed by the status snapshot, so a change Git reports refetches them.
export const syncKeys = {
  overview: (id: string, statusAt: number | null) =>
    ['sync-overview', id, statusAt] as const,
  compare: (id: string, statusAt: number | null) =>
    ['sync-compare', id, statusAt] as const,
  activity: (filter: string, offset: number) =>
    ['sync-activity', filter, offset] as const,
  moveUndo: (id: string) => ['move-undo', id] as const,
  movePreview: (id: string, statusAt: number | null) =>
    ['move-preview', id, statusAt] as const,
};

const sync = () => window.desktop.sync;
const repos = () => window.desktop.repos;

export const useSyncOverview = (id: string, statusAt: number | null) =>
  useQuery({
    queryKey: syncKeys.overview(id, statusAt),
    queryFn: () => sync().overview(id),
    staleTime: Infinity,
  });

export const useSyncCompare = (
  id: string,
  statusAt: number | null,
  enabled: boolean,
) =>
  useQuery({
    queryKey: syncKeys.compare(id, statusAt),
    queryFn: () => sync().compare(id),
    staleTime: Infinity,
    enabled,
  });

export const useSyncFileDiff = (
  input: Parameters<typeof window.desktop.sync.fileDiff>[0] | null,
  statusAt: number | null,
) =>
  useQuery({
    queryKey: ['sync-compare', input?.id, 'diff', input, statusAt],
    queryFn: () => sync().fileDiff(input!),
    enabled: !!input,
    staleTime: Infinity,
  });

export const useSyncActivity = (
  filter: 'all' | 'failed' | 'unconfirmed',
  offset: number,
) =>
  useQuery<SyncActivityPage>({
    queryKey: syncKeys.activity(filter, offset),
    queryFn: () => sync().activity({ filter, offset }),
    placeholderData: (previous) => previous,
  });

function useSyncMutation<I, R>(
  id: string,
  fn: (input: I) => Promise<R>,
  also: string[] = [],
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      invalidateSync(qc, id);
      for (const prefix of [
        'ws-branches',
        'ws-remotes',
        'repo-history',
        'ws-log',
        ...also,
      ])
        void qc.invalidateQueries({ queryKey: [prefix, id] });
      void qc.invalidateQueries({ queryKey: repoKeys.list });
      void qc.invalidateQueries({ queryKey: repoKeys.activity });
      void qc.invalidateQueries({ queryKey: ['pull-conflicts', id] });
    },
  });
}

export const useCheckRemote = (id: string) =>
  useMutation({ mutationFn: () => sync().check(id) });
export const usePullUpstream = (id: string) =>
  useSyncMutation(id, (input: { jobId: string; strategy: PullStrategy }) =>
    sync().pull({ id, ...input }),
  );
export const useCancelSync = () =>
  useMutation({ mutationFn: (jobId: string) => sync().cancel(jobId) });
export const usePublish = (id: string) =>
  useSyncMutation(
    id,
    (input: { jobId: string; remote: string; branch: string }) =>
      sync().publish({ id, ...input }),
  );
export const useSetUpstream = (id: string) =>
  useSyncMutation(id, (input: { remote: string; branch: string }) =>
    sync().setUpstream({ id, ...input }),
  );
export const useCheckPush = (id: string) =>
  useSyncMutation(id, (operationId: string) =>
    sync().checkPush({ id, operationId }),
  );

// Moving to gitdesk and its undo, and the automatic remote's named retry.
export const useMovePreview = (
  id: string,
  statusAt: number | null,
  enabled: boolean,
) =>
  useQuery({
    queryKey: syncKeys.movePreview(id, statusAt),
    queryFn: () => repos().movePreview(id),
    enabled,
    staleTime: 30_000,
  });
export const useMoveUndo = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: syncKeys.moveUndo(id),
    queryFn: () => repos().moveUndoState(id),
    enabled,
  });
const MOVE_KEYS = ['move-undo', 'move-preview'];
export const useMove = (id: string) =>
  useSyncMutation(
    id,
    (jobId: string) => repos().move({ id, jobId }),
    MOVE_KEYS,
  );
export const useCancelMove = () =>
  useMutation({ mutationFn: (jobId: string) => repos().moveCancel(jobId) });
export const useUndoMove = (id: string) =>
  useSyncMutation(id, () => repos().undoMove(id), MOVE_KEYS);
export const useLinkNamed = (id: string) =>
  useSyncMutation(id, (name: string) => repos().linkNamed({ id, name }));
export const useLocateConfirm = (id: string) =>
  useSyncMutation(id, (token: string) => repos().locateConfirm({ id, token }));
