import { z } from 'zod';
import { gitIdentityInputSchema, IPC, type AppInfo } from '../../shared/ipc';
import { settingsPatchSchema } from '../../shared/settings';
import type { AuthService } from '../auth/auth-service';
import type { createGitIdentity } from '../git/git-identity';
import type { SettingsService } from '../settings/settings-service';
import type { Handle } from './handle';

const none = z.undefined();

export function registerIpc(
  handle: Handle,
  services: {
    auth: AuthService;
    settings: SettingsService;
    git: ReturnType<typeof createGitIdentity>;
    appInfo: AppInfo;
    openGitInstallPage(): Promise<void>;
  },
): void {
  const { auth, settings, git, appInfo } = services;
  handle(IPC.appGetInfo, none, () => appInfo);
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
  handle(IPC.gitOpenInstallPage, none, () => services.openGitInstallPage());
}
