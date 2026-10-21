import { z } from 'zod';
import {
  gitDefaultsSchema,
  gitIdentityInputSchema,
  IPC,
  windowCommandSchema,
} from '../../shared/ipc';
import {
  createRepositoryInputSchema,
  initializeInputSchema,
  pinInputSchema,
  refreshInputSchema,
  remoteOverviewInputSchema,
  repoIdSchema,
  REPOS_IPC,
} from '../../shared/repos';
import { settingsPatchSchema } from '../../shared/settings';
import log from 'electron-log/main';
import { UserError } from '../errors';
import type { RemoteService } from '../remote/remote-service';
import type { RepositoryService } from '../repos/repository-service';
import type { AppService } from '../app/app-service';
import type { AuthService } from '../auth/auth-service';
import type { createGitIdentity } from '../git/git-identity';
import type { SettingsService } from '../settings/settings-service';
import type { Handle } from './handle';

const none = z.undefined();

// Repository work touches the filesystem, so only messages written for people cross IPC.
function userFacing<I, R>(fn: (input: I) => R | Promise<R>) {
  return async (input: I): Promise<R> => {
    try {
      return await fn(input);
    } catch (err) {
      if (err instanceof UserError) throw err;
      log.error('repository operation failed', err instanceof Error ? err.name : 'unknown');
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
  },
): void {
  const { app, auth, settings, git, repos, remote } = services;
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
  handle(IPC.gitGetIdentity, none, () => git.get());
  handle(IPC.gitSetIdentity, gitIdentityInputSchema, (input) => git.set(input));
  handle(IPC.gitSetDefaults, gitDefaultsSchema, (input) =>
    git.setDefaults(input),
  );
  handle(IPC.gitOpenInstallPage, none, () => app.openGitInstallPage());

  const id = repoIdSchema;
  const r = REPOS_IPC;
  handle(r.list, none, () => repos.list());
  handle(r.add, none, userFacing(() => repos.add()));
  handle(r.initialize, initializeInputSchema, userFacing(({ token }) => repos.initialize(token)));
  handle(r.locate, id, userFacing((repoId) => repos.locate(repoId)));
  handle(r.refresh, refreshInputSchema, userFacing((repoId) => repos.refresh(repoId)));
  handle(r.open, id, userFacing((repoId) => repos.open(repoId)));
  handle(r.pin, pinInputSchema, userFacing(({ id: repoId, pinned }) => repos.pin(repoId, pinned)));
  handle(r.remove, id, userFacing((repoId) => repos.remove(repoId)));
  handle(r.forgetAll, none, userFacing(() => repos.forgetAll()));
  handle(r.reveal, id, userFacing((repoId) => repos.reveal(repoId)));
  handle(r.copyPath, id, userFacing((repoId) => repos.copyPath(repoId)));
  handle(r.changes, id, userFacing((repoId) => repos.changes(repoId)));
  handle(r.chooseLocation, none, userFacing(() => repos.chooseLocation()));
  handle(r.create, createRepositoryInputSchema, userFacing((input) => repos.create(input)));
  handle(r.linkRemote, id, userFacing((repoId) => repos.linkRemote(repoId)));
  handle(r.activity, none, () => repos.activity());
  handle(r.remoteOverview, remoteOverviewInputSchema, ({ force }) => remote.overview(force));
}
