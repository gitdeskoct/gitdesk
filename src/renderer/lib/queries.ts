import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useReducedMotion } from 'framer-motion';
import type {
  AuthStatus,
  GitDefaults,
  GitIdentityInput,
} from '../../shared/ipc';
import type { CreateRepositoryInput } from '../../shared/repos';
import {
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsPatch,
} from '../../shared/settings';

// Only AuthStatus and account summaries ever reach this cache; tokens never leave the main process.
export const keys = {
  auth: ['auth'] as const,
  settings: ['settings'] as const,
  sessions: ['sessions'] as const,
  gitIdentity: ['git-identity'] as const,
  appInfo: ['app-info'] as const,
};

const desktop = () => window.desktop;

export const useAuthStatus = () =>
  useQuery({
    queryKey: keys.auth,
    queryFn: () => desktop().auth.getStatus(),
    staleTime: Infinity,
  });

export const useSettings = () =>
  useQuery({
    queryKey: keys.settings,
    queryFn: () => desktop().settings.get(),
    staleTime: Infinity,
  });

// Settings change instantly in the UI; a failed save rolls back to what main still holds.
export function useUpdateSettings() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (patch: SettingsPatch) => desktop().settings.update(patch),
    onMutate: async (patch) => {
      await qc.cancelQueries({ queryKey: keys.settings });
      const previous = qc.getQueryData<Settings>(keys.settings);
      qc.setQueryData<Settings>(keys.settings, {
        ...(previous ?? DEFAULT_SETTINGS),
        ...patch,
      });
      return { previous };
    },
    onError: (_err, _patch, context) =>
      qc.setQueryData(keys.settings, context?.previous),
    onSuccess: (saved) => qc.setQueryData(keys.settings, saved),
  });
}

export function useMotionAllowed(): boolean {
  const systemReduced = useReducedMotion();
  return useSettings().data?.motion === 'full' && !systemReduced;
}

const useAuthAction = (fn: () => Promise<AuthStatus | void>) => {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (status) => {
      if (status) qc.setQueryData(keys.auth, status);
    },
  });
};

export const useSignIn = () => useAuthAction(() => desktop().auth.signIn());
export const useCancelSignIn = () =>
  useAuthAction(() => desktop().auth.cancelSignIn());
export const useReopenBrowser = () =>
  useAuthAction(() => desktop().auth.reopenBrowser());
export const useSignOut = () => useAuthAction(() => desktop().auth.signOut());
export const useRetryConnection = () =>
  useAuthAction(() => desktop().auth.retry());

export const useSessions = (enabled: boolean) =>
  useQuery({
    queryKey: keys.sessions,
    queryFn: () => desktop().auth.listSessions(),
    enabled,
  });

export function useRevokeSession() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => desktop().auth.revokeSession(id),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.sessions }),
  });
}

export const useGitIdentity = () =>
  useQuery({
    queryKey: keys.gitIdentity,
    queryFn: () => desktop().git.getIdentity(),
  });

export function useSetGitIdentity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GitIdentityInput) => desktop().git.setIdentity(input),
    onSuccess: (identity) => qc.setQueryData(keys.gitIdentity, identity),
  });
}

export const useAppInfo = () =>
  useQuery({
    queryKey: keys.appInfo,
    queryFn: () => desktop().app.getInfo(),
    staleTime: Infinity,
  });

export function useGitDefaultsMutation() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: GitDefaults) => desktop().git.setDefaults(input),
    onSuccess: (identity) => qc.setQueryData(keys.gitIdentity, identity),
  });
}

export function useSetOpenAtLogin() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (enabled: boolean) => desktop().app.setOpenAtLogin(enabled),
    onSuccess: (info) => qc.setQueryData(keys.appInfo, info),
  });
}

// Signs out every session except this one, one request each; the list refreshes when all settle.
export function useRevokeOtherSessions() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      Promise.all(ids.map((id) => desktop().auth.revokeSession(id))),
    onSettled: () => qc.invalidateQueries({ queryKey: keys.sessions }),
  });
}

export const useOpenLogs = () =>
  useMutation({ mutationFn: () => desktop().app.openLogs() });
export const useCopyDiagnostics = () =>
  useMutation({ mutationFn: () => desktop().app.copyDiagnostics() });

// Repositories: main owns the list and pushes every change (see RepoSync), so the cache is only
// read here. Remote metadata is throttled in main as well; these hooks never poll.
export const repoKeys = {
  list: ['repos'] as const,
  activity: ['repo-activity'] as const,
  changes: (id: string, inspectedAt: number | null) =>
    ['repo-changes', id, inspectedAt] as const,
  remote: ['remote-overview'] as const,
};

const repos = () => desktop().repos;

export const useRepositories = () =>
  useQuery({
    queryKey: repoKeys.list,
    queryFn: () => repos().list(),
    staleTime: Infinity,
  });

export const useRepositoryActivity = () =>
  useQuery({
    queryKey: repoKeys.activity,
    queryFn: () => repos().activity(),
    staleTime: Infinity,
  });

export const useRepositoryChanges = (
  id: string,
  inspectedAt: number | null,
  enabled: boolean,
) =>
  useQuery({
    queryKey: repoKeys.changes(id, inspectedAt),
    queryFn: () => repos().changes(id),
    enabled,
    staleTime: Infinity,
  });

// Asking is cheap: main answers from its cache unless a refresh is due, so this can run on mount.
export const useRemoteOverview = () =>
  useQuery({
    queryKey: repoKeys.remote,
    queryFn: () => repos().remoteOverview(false),
    staleTime: 5 * 60_000,
  });

export function useRefreshRemote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => repos().remoteOverview(true),
    onSuccess: (overview) => qc.setQueryData(repoKeys.remote, overview),
  });
}

function useRepoMutation<I, R>(fn: (input: I) => Promise<R>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: repoKeys.list });
      void qc.invalidateQueries({ queryKey: repoKeys.activity });
    },
  });
}

export const useAddRepository = () => useRepoMutation(() => repos().add());
export const useInitializeRepository = () =>
  useRepoMutation((token: string) => repos().initialize(token));
export const useLocateRepository = () =>
  useRepoMutation((id: string) => repos().locate(id));
export const useRefreshRepositories = () =>
  useRepoMutation((id: string | null) => repos().refresh(id));
export const useOpenRepository = () =>
  useRepoMutation((id: string) => repos().open(id));
export const usePinRepository = () =>
  useRepoMutation((input: { id: string; pinned: boolean }) =>
    repos().pin(input.id, input.pinned),
  );
export const useRemoveRepository = () =>
  useRepoMutation((id: string) => repos().remove(id));
export const useForgetRepositories = () =>
  useRepoMutation(() => repos().forgetAll());
export const useRevealRepository = () =>
  useMutation({ mutationFn: (id: string) => repos().reveal(id) });
export const useCopyRepositoryPath = () =>
  useMutation({ mutationFn: (id: string) => repos().copyPath(id) });
export const useChooseLocation = () =>
  useMutation({ mutationFn: () => repos().chooseLocation() });

export function useCreateRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateRepositoryInput) => repos().create(input),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: repoKeys.list });
      void qc.invalidateQueries({ queryKey: repoKeys.activity });
      void qc.invalidateQueries({ queryKey: repoKeys.remote });
    },
  });
}

export function useLinkRemote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => repos().linkRemote(id),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: repoKeys.list });
      void qc.invalidateQueries({ queryKey: repoKeys.remote });
    },
  });
}
