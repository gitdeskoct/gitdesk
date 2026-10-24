import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from '@tanstack/react-query';
import { useReducedMotion } from 'framer-motion';
import { useEffect, useState } from 'react';
import type {
  AuthStatus,
  GitDefaults,
  GitIdentityInput,
} from '../../shared/ipc';
import type {
  CloneInput,
  ProgressEvent,
  CreateRepositoryInput,
  RemoteCreateInput,
  RemoteListInput,
  RemoteUpdateInput,
  RepoTrashInput,
  RepoUpdateInput,
} from '../../shared/repos';
import {
  DEFAULT_SETTINGS,
  type Settings,
  type SettingsPatch,
} from '../../shared/settings';
import type {
  AnalyticsRange,
  CommitInput,
  DiffInput,
  GitInstall,
  RepoConfigInput,
  RepoPreferencesInput,
} from '../../shared/workspace';

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
export const useTestNotification = () =>
  useMutation({ mutationFn: () => desktop().app.testNotification() });
export const useOpenGitInstallPage = () =>
  useMutation({ mutationFn: () => desktop().git.openInstallPage() });
export const useCopyDiagnostics = () =>
  useMutation({ mutationFn: () => desktop().app.copyDiagnostics() });

// Repositories: main owns the list and pushes every change (see RepoSync), so the cache is only
// read here. Remote metadata is throttled in main as well; these hooks never poll.
export const repoKeys = {
  list: ['repos'] as const,
  activity: ['repo-activity'] as const,
  changes: (id: string, statusAt: number | null) =>
    ['repo-changes', id, statusAt] as const,
  remote: ['remote-overview'] as const,
  remoteList: (sort: RemoteListInput['sort']) => ['remote-list', sort] as const,
  history: (id: string, statusAt: number | null) =>
    ['repo-history', id, statusAt] as const,
  remoteDetail: (id: string) => ['remote-repo', id] as const,
  remoteActivity: (id: string) => ['remote-activity', id] as const,
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

export function useClearActivity() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => repos().clearActivity(),
    onSettled: () => qc.invalidateQueries({ queryKey: repoKeys.activity }),
  });
}

// Keyed by the snapshot time, so a new status check fetches the file list again and nothing else does.
export const useRepositoryChanges = (
  id: string,
  statusAt: number | null,
  enabled: boolean,
) =>
  useQuery({
    queryKey: repoKeys.changes(id, statusAt),
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
    onSettled: () => invalidateRemote(qc),
  });
}

// A confirmed remote change refreshes everything that shows remote data, and nothing else.
function invalidateRemote(qc: ReturnType<typeof useQueryClient>) {
  void qc.invalidateQueries({ queryKey: repoKeys.list });
  void qc.invalidateQueries({ queryKey: repoKeys.remote });
  void qc.invalidateQueries({ queryKey: ['remote-list'] });
  void qc.invalidateQueries({ queryKey: ['remote-repo'] });
  void qc.invalidateQueries({ queryKey: ['remote-activity'] });
}

// Keyed by the status snapshot, like the change list: a new commit or checkout reads history again.
export const useRepositoryHistory = (
  id: string,
  statusAt: number | null,
  enabled: boolean,
) =>
  useQuery({
    queryKey: repoKeys.history(id, statusAt),
    queryFn: () => repos().history(id),
    enabled,
    staleTime: Infinity,
  });

// One server request per open; Refresh asks again. Provisioning finishes inside the create request,
// so nothing here polls.
export const useRemoteRepository = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: repoKeys.remoteDetail(id),
    queryFn: () => repos().remoteGet(id),
    enabled,
    staleTime: 60_000,
  });

export const useRemoteActivity = (id: string, enabled: boolean) =>
  useQuery({
    queryKey: repoKeys.remoteActivity(id),
    queryFn: () => repos().remoteActivity(id),
    enabled,
    staleTime: 60_000,
  });

export function useCreateRemote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RemoteCreateInput) => repos().remoteCreate(input),
    onSettled: () => invalidateRemote(qc),
  });
}

export function useProvisionRemote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => repos().remoteProvision(id),
    onSettled: () => invalidateRemote(qc),
  });
}

// A linked rename also changes the remote, so remote views refresh too.
export function useUpdateRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RepoUpdateInput) => repos().update(input),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: repoKeys.activity });
      invalidateRemote(qc);
    },
  });
}

export const useUnlinkRepository = () =>
  useRepoMutation((id: string) => repos().unlink(id));
export const useTrashRepository = () =>
  useRepoMutation((input: RepoTrashInput) => repos().trash(input));

// Pages come straight from the server; main spaces and counts the requests.
export const useRemoteList = (
  sort: RemoteListInput['sort'],
  enabled: boolean,
) =>
  useInfiniteQuery({
    queryKey: repoKeys.remoteList(sort),
    queryFn: ({ pageParam }) => repos().remoteList({ sort, cursor: pageParam }),
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled,
    staleTime: 60_000,
  });

export function useUpdateRemote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: RemoteUpdateInput) => repos().remoteUpdate(input),
    onSettled: () => invalidateRemote(qc),
  });
}

export function useDeleteRemote() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => repos().remoteDelete(id),
    onSettled: () => invalidateRemote(qc),
  });
}

export function useCloneRepository() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: CloneInput) => repos().clone(input),
    onSettled: () => {
      void qc.invalidateQueries({ queryKey: repoKeys.list });
      void qc.invalidateQueries({ queryKey: repoKeys.activity });
    },
  });
}

export const useCancelClone = () =>
  useMutation({ mutationFn: (jobId: string) => repos().cancelClone(jobId) });

// The local Git workspace. Reads are keyed by the status snapshot (statusAt) or a commit, so a
// change Git reports refetches them and nothing else does; mutations name what they invalidate.
export const workspaceKeys = {
  diff: (id: string, input: Omit<DiffInput, 'id'>, statusAt: number | null) =>
    ['ws-diff', id, input, statusAt] as const,
  branches: (id: string, statusAt: number | null) =>
    ['ws-branches', id, statusAt] as const,
  remotes: (id: string, statusAt: number | null) =>
    ['ws-remotes', id, statusAt] as const,
  log: (id: string, pinned: string | null) => ['ws-log', id, pinned] as const,
  commit: (id: string, oid: string) => ['ws-commit', id, oid] as const,
  analytics: (id: string, head: string | null, range: AnalyticsRange) =>
    ['ws-analytics', id, head, range] as const,
  gitConfig: (id: string) => ['ws-git-config', id] as const,
  preferences: (id: string) => ['ws-preferences', id] as const,
  editors: ['ws-editors'] as const,
  gitInstall: ['ws-git-install'] as const,
};

const workspace = () => desktop().workspace;

function invalidateRepository(
  qc: ReturnType<typeof useQueryClient>,
  id: string,
  scopes: ('changes' | 'diff' | 'history' | 'branches' | 'remotes')[],
) {
  const prefixes: Record<(typeof scopes)[number], string[]> = {
    changes: ['repo-changes'],
    diff: ['ws-diff'],
    history: ['repo-history', 'ws-log', 'ws-analytics'],
    branches: ['ws-branches'],
    remotes: ['ws-remotes'],
  };
  for (const scope of scopes)
    for (const prefix of prefixes[scope])
      void qc.invalidateQueries({ queryKey: [prefix, id] });
  void qc.invalidateQueries({ queryKey: repoKeys.activity });
  // Any Git change can move what Sync shows; it is never updated ahead of Git's answer.
  invalidateSync(qc, id);
}

export function invalidateSync(
  qc: ReturnType<typeof useQueryClient>,
  id: string,
) {
  void qc.invalidateQueries({ queryKey: ['sync-overview', id] });
  void qc.invalidateQueries({ queryKey: ['sync-compare', id] });
  void qc.invalidateQueries({ queryKey: ['sync-activity'] });
}

export const useDiff = (
  id: string,
  input: Omit<DiffInput, 'id'> | null,
  statusAt: number | null,
) =>
  useQuery({
    queryKey: workspaceKeys.diff(
      id,
      input ?? {
        path: '',
        side: 'unstaged',
        context: 3,
        ignoreWhitespace: false,
        full: false,
      },
      statusAt,
    ),
    queryFn: () => workspace().diff({ id, ...input! }),
    enabled: !!input,
    staleTime: Infinity,
    // The previous diff stays on screen while the next file's diff loads.
    placeholderData: (previous) => previous,
  });

function useWorkspaceMutation<I, R>(
  id: string,
  fn: (input: I) => Promise<R>,
  scopes: Parameters<typeof invalidateRepository>[2],
) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSettled: () => invalidateRepository(qc, id, scopes),
  });
}

export const useStage = (id: string) =>
  useWorkspaceMutation(
    id,
    (paths: string[]) => workspace().stage({ id, paths }),
    ['changes', 'diff'],
  );
export const useStageAll = (id: string) =>
  useWorkspaceMutation(id, () => workspace().stageAll(id), ['changes', 'diff']);
export const useUnstage = (id: string) =>
  useWorkspaceMutation(
    id,
    (paths: string[]) => workspace().unstage({ id, paths }),
    ['changes', 'diff'],
  );
export const useDiscard = (id: string) =>
  useWorkspaceMutation(
    id,
    (paths: string[]) => workspace().discard({ id, paths }),
    ['changes', 'diff'],
  );
export const useCommit = (id: string) =>
  useWorkspaceMutation(
    id,
    (input: Omit<CommitInput, 'id'>) => workspace().commit({ id, ...input }),
    ['changes', 'diff', 'history', 'branches'],
  );

export const useBranches = (
  id: string,
  statusAt: number | null,
  enabled = true,
) =>
  useQuery({
    queryKey: workspaceKeys.branches(id, statusAt),
    queryFn: () => workspace().branches(id),
    enabled,
    staleTime: Infinity,
  });

// A switch changes everything that depends on the branch, so all of it is read again.
export const useSwitchBranch = (id: string) =>
  useWorkspaceMutation(
    id,
    (input: { name: string; kind: 'local' | 'remote' }) =>
      workspace().switchBranch({ id, ...input }),
    ['changes', 'diff', 'history', 'branches'],
  );
export const useCreateBranch = (id: string) =>
  useWorkspaceMutation(
    id,
    (name: string) => workspace().createBranch({ id, name }),
    ['history', 'branches'],
  );
// Fetch updates remote-tracking refs only; the working tree and history of the branch stay.
export const useFetch = (id: string) =>
  useWorkspaceMutation(
    id,
    (input: { remote: string; jobId: string }) =>
      workspace().fetch({ id, ...input }),
    ['branches', 'remotes'],
  );
export const useCancelFetch = () =>
  useMutation({
    mutationFn: (jobId: string) => workspace().cancelFetch(jobId),
  });
// Push moves the remote's branch and the upstream ahead count; local files stay as they are.
export const usePush = (id: string) =>
  useWorkspaceMutation(id, (jobId: string) => workspace().push({ id, jobId }), [
    'branches',
    'remotes',
    'history',
  ]);
export const useCancelPush = () =>
  useMutation({
    mutationFn: (jobId: string) => workspace().cancelPush(jobId),
  });

// The account's Git URL as a Git remote of this repository.
export const useAddHostedRemote = (id: string) =>
  useWorkspaceMutation(id, () => repos().addHostedRemote(id), ['remotes']);
// The command and its token go straight from main to the clipboard; only the expiry comes back.
export const useCopyGitCommand = () =>
  useMutation({ mutationFn: (id: string) => repos().copyGitCommand(id) });
export const useRevokeGitTokens = () =>
  useMutation({ mutationFn: (id: string) => repos().revokeGitTokens(id) });

export const useRemotes = (id: string, statusAt: number | null) =>
  useQuery({
    queryKey: workspaceKeys.remotes(id, statusAt),
    queryFn: () => workspace().remotes(id),
    staleTime: Infinity,
  });

// Pages come from one snapshot: every page after the first asks for the head the first page read.
export const useHistoryLog = (id: string, pinned: string | null) =>
  useInfiniteQuery({
    queryKey: workspaceKeys.log(id, pinned),
    queryFn: ({ pageParam }) => workspace().log({ id, ...pageParam }),
    initialPageParam: { oid: pinned, skip: 0 } as {
      oid: string | null;
      skip: number;
    },
    getNextPageParam: (last) =>
      last.nextSkip === null || !last.snapshot
        ? undefined
        : { oid: last.snapshot, skip: last.nextSkip },
    staleTime: Infinity,
  });

export const useCommitDetail = (id: string, oid: string | null) =>
  useQuery({
    queryKey: workspaceKeys.commit(id, oid ?? ''),
    queryFn: () => workspace().commitDetail({ id, oid: oid! }),
    enabled: !!oid,
    staleTime: Infinity,
  });

export const useAnalytics = (
  id: string,
  head: string | null,
  range: AnalyticsRange,
  enabled: boolean,
) =>
  useQuery({
    queryKey: workspaceKeys.analytics(id, head, range),
    queryFn: () => workspace().analytics({ id, range }),
    enabled,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
  });

// Keyed by the status snapshot, so the numbers follow edits as they happen; main spaces the walks.
export const useRepoSize = (id: string, statusAt: number | null) =>
  useQuery({
    queryKey: ['ws-size', id, statusAt] as const,
    queryFn: () => workspace().size({ id, force: false }),
    staleTime: Infinity,
    placeholderData: (previous) => previous,
  });
export function useMeasureRepo(id: string, statusAt: number | null) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => workspace().size({ id, force: true }),
    onSuccess: (size) => qc.setQueryData(['ws-size', id, statusAt], size),
  });
}

export const useRevealFile = (id: string) =>
  useMutation({
    mutationFn: (path: string) => workspace().revealFile({ id, path }),
  });
export const useCopyFilePath = (id: string) =>
  useMutation({
    mutationFn: (path: string) => workspace().copyFilePath({ id, path }),
  });

// The open workspace's files are watched while it is on screen, and only then.
export function useWatchRepository(id: string, enabled: boolean): void {
  useEffect(() => {
    if (!enabled) return;
    void workspace()
      .watch(id)
      .catch(() => undefined);
    return () => {
      void workspace()
        .unwatch(id)
        .catch(() => undefined);
    };
  }, [id, enabled]);
}

export const useEditors = () =>
  useQuery({
    queryKey: workspaceKeys.editors,
    queryFn: () => workspace().editors(false),
    staleTime: Infinity,
  });
export function useDetectEditors() {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: () => workspace().editors(true),
    onSuccess: (list) => qc.setQueryData(workspaceKeys.editors, list),
  });
}
export const useOpenInEditor = (id: string) =>
  useMutation({
    mutationFn: (input: { path: string | null; line: number | null }) =>
      workspace().openInEditor({ id, ...input }),
  });

export const useRepoGitConfig = (id: string) =>
  useQuery({
    queryKey: workspaceKeys.gitConfig(id),
    queryFn: () => workspace().gitConfig(id),
  });
export function useSetRepoGitConfig(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<RepoConfigInput, 'id'>) =>
      workspace().setGitConfig({ id, ...input }),
    onSuccess: (config) => qc.setQueryData(workspaceKeys.gitConfig(id), config),
  });
}

export const useRepoPreferences = (id: string) =>
  useQuery({
    queryKey: workspaceKeys.preferences(id),
    queryFn: () => workspace().preferences(id),
    staleTime: Infinity,
  });
export function useSetRepoPreferences(id: string) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (input: Omit<RepoPreferencesInput, 'id'>) =>
      workspace().setPreferences({ id, ...input }),
    onSuccess: (prefs) => qc.setQueryData(workspaceKeys.preferences(id), prefs),
  });
}

export const useGitInstall = () =>
  useQuery({
    queryKey: workspaceKeys.gitInstall,
    queryFn: () => workspace().gitInstall(),
  });
function useGitInstallMutation<I>(fn: (input: I) => Promise<GitInstall>) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: fn,
    onSuccess: (install) => {
      qc.setQueryData(workspaceKeys.gitInstall, install);
      void qc.invalidateQueries({ queryKey: keys.gitIdentity });
    },
  });
}
export const useChooseGit = () =>
  useGitInstallMutation(() => workspace().chooseGit());
export const useUsePathGit = () =>
  useGitInstallMutation(() => workspace().usePathGit());
export const useSetGlobalPrune = () =>
  useGitInstallMutation((enabled: boolean) =>
    workspace().setGlobalPrune(enabled),
  );

// The latest progress main reported for one clone job.
export function useJobProgress(jobId: string | null): ProgressEvent | null {
  const [progress, setProgress] = useState<ProgressEvent | null>(null);
  useEffect(() => {
    setProgress(null);
    if (!jobId) return;
    return repos().onProgress((event) => {
      if (event.jobId === jobId) setProgress(event);
    });
  }, [jobId]);
  return progress;
}
