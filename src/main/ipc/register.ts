import { z } from 'zod';
import {
  gitDefaultsSchema,
  gitIdentityInputSchema,
  IPC,
  windowCommandSchema,
} from '../../shared/ipc';
import {
  cloneInputSchema,
  createRepositoryInputSchema,
  initializeInputSchema,
  remoteCreateInputSchema,
  pinInputSchema,
  refreshInputSchema,
  remoteListInputSchema,
  remoteOverviewInputSchema,
  remoteUpdateInputSchema,
  repoIdSchema,
  repoTrashInputSchema,
  repoUpdateInputSchema,
  REPOS_IPC,
} from '../../shared/repos';
import { settingsPatchSchema } from '../../shared/settings';
import {
  analyticsInputSchema,
  commitDetailInputSchema,
  commitInputSchema,
  createBranchInputSchema,
  diffInputSchema,
  fetchInputSchema,
  logInputSchema,
  openInEditorInputSchema,
  pathsInputSchema,
  repoConfigInputSchema,
  repoFileInputSchema,
  repoPreferencesInputSchema,
  repoSizeInputSchema,
  switchInputSchema,
  WORKSPACE_IPC,
} from '../../shared/workspace';
import type { GitInstallService } from '../git/git-install';
import type { WorkspaceService } from '../repos/workspace-service';
import log from 'electron-log/main';
import { UserError } from '../errors';
import type { RemoteService } from '../remote/remote-service';
import type { RepositoryService } from '../repos/repository-service';
import type { AppService } from '../app/app-service';
import type { AuthService } from '../auth/auth-service';
import type { createGitIdentity } from '../git/git-identity';
import type { SettingsService } from '../settings/settings-service';
import type { Notifier } from '../notifier';
import type { Handle } from './handle';

const none = z.undefined();

// Git and filesystem errors can carry paths and config, so only messages written for people cross
// IPC. The raw message stays in the local main-process log, where it is useful.
function userFacing<I, R>(fn: (input: I) => R | Promise<R>) {
  return async (input: I): Promise<R> => {
    try {
      return await fn(input);
    } catch (err) {
      if (err instanceof UserError) throw err;
      log.error(
        'operation failed',
        err instanceof Error ? err.message : String(err),
      );
      throw new Error('Something went wrong. Check the logs for details.');
    }
  };
}

export function registerIpc(
  handle: Handle,
  services: {
    app: AppService;
    auth: AuthService;
    settings: SettingsService;
    git: ReturnType<typeof createGitIdentity>;
    repos: RepositoryService;
    remote: RemoteService;
    notifier: Notifier;
    workspace: WorkspaceService;
    gitInstall: GitInstallService;
  },
): void {
  const {
    app,
    auth,
    settings,
    git,
    repos,
    remote,
    notifier,
    workspace,
    gitInstall,
  } = services;
  handle(IPC.appTestNotification, none, () => notifier.test());
  handle(IPC.appGetInfo, none, () => app.info());
  handle(IPC.appSetOpenAtLogin, z.boolean(), (enabled) =>
    app.setOpenAtLogin(enabled),
  );
  handle(IPC.appOpenLogs, none, () => app.openLogs());
  handle(IPC.appCopyDiagnostics, none, () => app.copyDiagnostics());
  handle(IPC.windowCommand, windowCommandSchema, (command) =>
    app.command(command),
  );
  handle(IPC.authGetStatus, none, () => auth.getStatus());
  handle(IPC.authRetry, none, () => auth.restore());
  handle(IPC.authSignIn, none, () => auth.signIn());
  handle(IPC.authCancelSignIn, none, () => auth.cancelSignIn());
  handle(IPC.authReopenBrowser, none, () => auth.reopenBrowser());
  handle(IPC.authSignOut, none, () => auth.signOut());
  handle(IPC.authListSessions, none, () => auth.listSessions());
  handle(IPC.authRevokeSession, z.uuid(), (id) => auth.revokeSession(id));
  handle(IPC.settingsGet, none, () => settings.get());
  handle(IPC.settingsUpdate, settingsPatchSchema, (patch) =>
    settings.update(patch),
  );
  handle(
    IPC.gitGetIdentity,
    none,
    userFacing(() => git.get()),
  );
  handle(
    IPC.gitSetIdentity,
    gitIdentityInputSchema,
    userFacing((input) => git.set(input)),
  );
  handle(
    IPC.gitSetDefaults,
    gitDefaultsSchema,
    userFacing((input) => git.setDefaults(input)),
  );
  handle(IPC.gitOpenInstallPage, none, () => app.openGitInstallPage());

  const id = repoIdSchema;
  const r = REPOS_IPC;
  handle(
    r.list,
    none,
    userFacing(() => repos.list()),
  );
  handle(
    r.add,
    none,
    userFacing(() => repos.add()),
  );
  handle(
    r.initialize,
    initializeInputSchema,
    userFacing(({ token }) => repos.initialize(token)),
  );
  handle(
    r.locate,
    id,
    userFacing((repoId) => repos.locate(repoId)),
  );
  handle(
    r.refresh,
    refreshInputSchema,
    userFacing((repoId) => repos.refresh(repoId)),
  );
  handle(
    r.open,
    id,
    userFacing((repoId) => repos.open(repoId)),
  );
  handle(
    r.pin,
    pinInputSchema,
    userFacing(({ id: repoId, pinned }) => repos.pin(repoId, pinned)),
  );
  handle(
    r.remove,
    id,
    userFacing((repoId) => repos.remove(repoId)),
  );
  handle(
    r.forgetAll,
    none,
    userFacing(() => repos.forgetAll()),
  );
  handle(
    r.reveal,
    id,
    userFacing((repoId) => repos.reveal(repoId)),
  );
  handle(
    r.copyPath,
    id,
    userFacing((repoId) => repos.copyPath(repoId)),
  );
  handle(
    r.changes,
    id,
    userFacing((repoId) => repos.changes(repoId)),
  );
  handle(
    r.chooseLocation,
    none,
    userFacing(() => repos.chooseLocation()),
  );
  handle(
    r.create,
    createRepositoryInputSchema,
    userFacing((input) => repos.create(input)),
  );
  handle(
    r.linkRemote,
    id,
    userFacing((repoId) => repos.linkRemote(repoId)),
  );
  handle(
    r.activity,
    none,
    userFacing(() => repos.activity()),
  );
  handle(
    r.clearActivity,
    none,
    userFacing(() => repos.clearActivity()),
  );
  handle(
    r.remoteOverview,
    remoteOverviewInputSchema,
    userFacing(({ force }) => remote.overview(force)),
  );
  handle(
    r.clone,
    cloneInputSchema,
    userFacing((input) => repos.clone(input)),
  );
  handle(r.cloneCancel, z.uuid(), (jobId) => repos.cancelClone(jobId));
  handle(
    r.remoteList,
    remoteListInputSchema,
    userFacing((input) => remote.list(input)),
  );
  handle(
    r.remoteUpdate,
    remoteUpdateInputSchema,
    userFacing((input) => remote.update(input)),
  );
  // A deletion that stopped partway keeps the link: the remote still exists until it finishes.
  handle(
    r.remoteDelete,
    z.uuid(),
    userFacing(async (remoteId) => {
      const result = await remote.remove(remoteId);
      if (result.status === 'deleted') repos.forgetRemote(remoteId);
      return result;
    }),
  );
  handle(
    r.remoteCreate,
    remoteCreateInputSchema,
    userFacing(({ key, ...input }) => remote.create(input, key)),
  );
  handle(
    r.remoteGet,
    z.uuid(),
    userFacing((remoteId) => remote.get(remoteId)),
  );
  handle(
    r.remoteProvision,
    z.uuid(),
    userFacing((remoteId) => remote.provision(remoteId)),
  );
  handle(
    r.remoteActivity,
    z.uuid(),
    userFacing((remoteId) => remote.activity(remoteId)),
  );
  handle(
    r.history,
    id,
    userFacing((repoId) => repos.history(repoId)),
  );
  handle(
    r.update,
    repoUpdateInputSchema,
    userFacing((input) => repos.update(input)),
  );
  handle(
    r.unlink,
    id,
    userFacing((repoId) => repos.unlink(repoId)),
  );
  handle(
    r.trash,
    repoTrashInputSchema,
    userFacing((input) => repos.trash(input)),
  );

  const w = WORKSPACE_IPC;
  handle(
    w.diff,
    diffInputSchema,
    userFacing((input) => workspace.diff(input)),
  );
  handle(
    w.stage,
    pathsInputSchema,
    userFacing((input) => workspace.stage(input)),
  );
  handle(
    w.stageAll,
    id,
    userFacing((repoId) => workspace.stageAll(repoId)),
  );
  handle(
    w.unstage,
    pathsInputSchema,
    userFacing((input) => workspace.unstage(input)),
  );
  handle(
    w.discard,
    pathsInputSchema,
    userFacing((input) => workspace.discard(input)),
  );
  handle(
    w.commit,
    commitInputSchema,
    userFacing((input) => workspace.commit(input)),
  );
  handle(
    w.branches,
    id,
    userFacing((repoId) => workspace.branches(repoId)),
  );
  handle(
    w.switchBranch,
    switchInputSchema,
    userFacing((input) => workspace.switchBranch(input)),
  );
  handle(
    w.createBranch,
    createBranchInputSchema,
    userFacing((input) => workspace.createBranch(input)),
  );
  handle(
    w.fetch,
    fetchInputSchema,
    userFacing((input) => workspace.fetch(input)),
  );
  handle(w.cancelFetch, z.uuid(), (jobId) => workspace.cancelFetch(jobId));
  handle(
    w.remotes,
    id,
    userFacing((repoId) => workspace.remotes(repoId)),
  );
  handle(
    w.log,
    logInputSchema,
    userFacing((input) => workspace.log(input)),
  );
  handle(
    w.commitDetail,
    commitDetailInputSchema,
    userFacing((input) => workspace.commitDetail(input)),
  );
  handle(
    w.analytics,
    analyticsInputSchema,
    userFacing((input) => workspace.analytics(input)),
  );
  handle(
    w.revealFile,
    repoFileInputSchema,
    userFacing((input) => workspace.revealFile(input)),
  );
  handle(
    w.copyFilePath,
    repoFileInputSchema,
    userFacing((input) => workspace.copyFilePath(input)),
  );
  handle(
    w.watch,
    id,
    userFacing((repoId) => workspace.watch(repoId)),
  );
  handle(
    w.unwatch,
    id,
    userFacing((repoId) => workspace.unwatch(repoId)),
  );
  handle(
    w.editors,
    z.boolean(),
    userFacing((refresh) => workspace.editors(refresh)),
  );
  handle(
    w.openInEditor,
    openInEditorInputSchema,
    userFacing((input) => workspace.openInEditor(input)),
  );
  handle(
    w.gitConfig,
    id,
    userFacing((repoId) => workspace.gitConfig(repoId)),
  );
  handle(
    w.setGitConfig,
    repoConfigInputSchema,
    userFacing((input) => workspace.setGitConfig(input)),
  );
  handle(
    w.preferences,
    id,
    userFacing((repoId) => workspace.preferences(repoId)),
  );
  handle(
    w.setPreferences,
    repoPreferencesInputSchema,
    userFacing((input) => workspace.setPreferences(input)),
  );
  handle(
    w.gitInstall,
    none,
    userFacing(() => gitInstall.get()),
  );
  handle(
    w.chooseGit,
    none,
    userFacing(() => gitInstall.choose()),
  );
  handle(
    w.usePathGit,
    none,
    userFacing(() => gitInstall.usePath()),
  );
  handle(
    w.setGlobalPrune,
    z.boolean(),
    userFacing((enabled) => gitInstall.setGlobalPrune(enabled)),
  );
  handle(
    w.size,
    repoSizeInputSchema,
    userFacing((input) => workspace.size(input)),
  );
}
