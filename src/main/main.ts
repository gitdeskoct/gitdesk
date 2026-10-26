import { writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  app,
  BrowserWindow,
  clipboard,
  dialog,
  Menu,
  nativeTheme,
  net,
  Notification,
  safeStorage,
  shell,
} from 'electron';
import log from 'electron-log/main';
import started from 'electron-squirrel-startup';
import { accountSummarySchema, IPC, type AuthStatus } from '../shared/ipc';
import { REPOS_IPC } from '../shared/repos';
import { SOURCE_IPC } from '../shared/source';
import { createAppService } from './app/app-service';
import { createApiClient } from './auth/api-client';
import { AuthService } from './auth/auth-service';
import { CredentialStore } from './auth/credential-store';
import { allowedRendererOrigins, resolveApiOrigin } from './config';
import {
  deleteState,
  openDatabase,
  readState,
  writeState,
} from './db/database';
import { createGitIdentity } from './git/git-identity';
import { createGitInstall } from './git/git-install';
import { createTreeWatcher } from './repos/tree-watcher';
import {
  createSourceService,
  type SourceService,
} from './repos/source-service';
import { createRemoteSource } from './remote/source-remote';
import {
  createWorkspaceService,
  type WorkspaceService,
} from './repos/workspace-service';
import { createHandle } from './ipc/handle';
import { registerIpc } from './ipc/register';
import { createNotifier } from './notifier';
import { registerAppScheme, serveRendererFrom } from './protocol';
import {
  createRemoteService,
  userError,
  type RemoteService,
} from './remote/remote-service';
import { createGitAuth, type GitAuth } from './remote/git-auth';
import { createAccountRecords } from './pulls/account-records';
import { createLocalRecords, createViewedStore } from './pulls/local-records';
import { createBranchService } from './branches/branch-service';
import { createPullService } from './pulls/pull-service';
import { createMoveService } from './sync/move-service';
import { createJournal } from './sync/journal';
import { createSyncService, type SyncService } from './sync/sync-service';
import { UserError } from './errors';
import { createRepositoryService } from './repos/repository-service';
import { createRepositoryStore } from './repos/repository-store';
import { hardenApp } from './security';
import { SettingsService } from './settings/settings-service';
import { applyChromeColors, createMainWindow } from './window';

const PLATFORM_NAMES: Partial<Record<NodeJS.Platform, string>> = {
  win32: 'Windows',
  darwin: 'macOS',
  linux: 'Linux',
};
const devServerUrl = MAIN_WINDOW_VITE_DEV_SERVER_URL || undefined;
const origins = allowedRendererOrigins(devServerUrl);
let mainWindow: BrowserWindow | null = null;

function focusMainWindow() {
  if (!mainWindow) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

// Dev only: a separate profile so a second copy can run beside the one you use (screenshots, tests).
// Must run before the single-instance lock, which is keyed to the profile folder.
if (!app.isPackaged && process.env.GITDESK_USER_DATA)
  app.setPath('userData', process.env.GITDESK_USER_DATA);

// Windows shows notifications only for an app with an AppUserModelID. The Squirrel installer sets
// it for packaged builds; a development run uses the Electron binary's path.
if (process.platform === 'win32' && !app.isPackaged)
  app.setAppUserModelId(process.execPath);

const formatBytes = (bytes: number) =>
  bytes >= 1024 ** 2
    ? `${(bytes / 1024 ** 2).toFixed(1)} MB`
    : `${Math.max(1, Math.round(bytes / 1024))} KB`;

if (started) {
  app.quit();
} else if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  // Sandbox every renderer, including any future window, not only the ones that opt in.
  app.enableSandbox();
  registerAppScheme();
  app.on('second-instance', focusMainWindow);
  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
  app
    .whenReady()
    .then(start)
    .catch((err: unknown) => {
      log.error('startup failed', err);
      app.quit();
    });
}

async function start() {
  // Needs the ready app (session.defaultSession); still runs before any window or webContents exists.
  hardenApp(origins, devServerUrl);
  const apiOrigin = resolveApiOrigin(
    import.meta.env.VITE_API_ORIGIN,
    app.isPackaged,
  );
  const userData = app.getPath('userData');
  if (!devServerUrl)
    serveRendererFrom(
      path.join(__dirname, `../renderer/${MAIN_WINDOW_VITE_NAME}`),
    );

  const db = openDatabase(path.join(userData, 'gitdesk.db'));
  // Assigned once the repository service exists; settings changes before that have nothing to apply to.
  let workspace: WorkspaceService | null = null;
  const settings = new SettingsService(db, (patch) => {
    if (
      patch.watchRepositories !== undefined ||
      patch.backgroundRefresh !== undefined
    )
      repos.applySettings();
    if (patch.watchRepositories !== undefined || patch.autoFetch !== undefined)
      workspace?.applySettings();
    if (!mainWindow) return;
    if (patch.theme) applyChromeColors(mainWindow);
    if (patch.zoomLevel !== undefined)
      mainWindow.webContents.setZoomLevel(patch.zoomLevel);
  });
  // The in-window menu bar replaces the default menu, whose Reload and DevTools accelerators would
  // otherwise stay live in production. macOS keeps a minimal native menu for its app and edit roles.
  Menu.setApplicationMenu(
    process.platform === 'darwin'
      ? Menu.buildFromTemplate([
          { role: 'appMenu' },
          { role: 'editMenu' },
          { role: 'windowMenu' },
        ])
      : null,
  );
  nativeTheme.on('updated', () => {
    if (mainWindow) applyChromeColors(mainWindow);
  });

  const api = createApiClient(apiOrigin, (url, init) => net.fetch(url, init));
  // Assigned right after auth exists; auth's emit only fires after start-up.
  let remote: RemoteService | null = null;
  // Held Git tokens; dropped on sign-out so the next account never reuses them.
  let gitAuth: GitAuth | null = null;
  // Set once the repository service exists: sign-in makes the remotes that waited for it.
  let reposAuth: ((status: AuthStatus) => void) | null = null;
  const auth = new AuthService({
    api,
    store: new CredentialStore(path.join(userData, 'session.bin'), safeStorage),
    cache: {
      get: () => {
        const parsed = accountSummarySchema.safeParse(readState(db, 'account'));
        return parsed.success ? parsed.data : null;
      },
      set: (account) => writeState(db, 'account', account),
      clear: () => deleteState(db, 'account'),
    },
    async openExternal(url) {
      // Only ever our own Worker's sign-in start URL, never a URL supplied by the renderer.
      if (new URL(url).origin !== apiOrigin)
        throw new Error('Refusing to open an unexpected URL');
      await shell.openExternal(url);
    },
    focusApp: focusMainWindow,
    startUrl: (params) =>
      `${apiOrigin}/api/v1/auth/google/start?${new URLSearchParams({
        challenge: params.challenge,
        state: params.state,
        port: String(params.port),
      })}`,
    deviceName:
      `${PLATFORM_NAMES[process.platform] ?? process.platform} · ${os.hostname()}`.slice(
        0,
        100,
      ),
    emit: (status) => {
      remote?.handleAuth(status);
      if (status.status === 'signed-out') gitAuth?.forget();
      reposAuth?.(status);
      mainWindow?.webContents.send(IPC.authStatusChanged, status);
    },
  });

  // Held until closed: a notification that is garbage-collected stops delivering its click.
  const shown = new Set<Notification>();
  const notifier = createNotifier({
    settings: () => settings.get(),
    isFocused: () => !!mainWindow?.isVisible() && mainWindow.isFocused(),
    sink: {
      isSupported: () => Notification.isSupported(),
      show(notice, onClick) {
        const note = new Notification({
          title: notice.title,
          body: notice.body,
        });
        shown.add(note);
        note.on('click', onClick);
        note.on('close', () => shown.delete(note));
        note.on('failed', (_event, error) => {
          shown.delete(note);
          log.warn('notification failed', error);
        });
        note.show();
      },
    },
    toWindow: (notice) => mainWindow?.webContents.send(IPC.appNotice, notice),
    onClick: (repositoryId) => {
      focusMainWindow();
      if (repositoryId)
        mainWindow?.webContents.send(IPC.appOpenRepository, repositoryId);
    },
  });

  const store = createRepositoryStore(db);
  const journal = createJournal(db);
  remote = createRemoteService({
    db,
    api,
    auth,
    store,
    settings: () => settings.get(),
  });
  const account = remote;
  gitAuth = createGitAuth({ remote: account });
  const tokens = gitAuth;
  const repos = createRepositoryService({
    store,
    remote,
    hosting: {
      hostedUrl: (remoteId) => account.hostedUrl(remoteId),
      provision: (remoteId) => account.provision(remoteId),
      envFor: (remoteId, url, scope) => tokens.envFor(remoteId, url, scope),
      terminalToken: (remoteId, lifetime) =>
        account.gitCredentials(remoteId, 'write', lifetime),
      async revoke(remoteId) {
        tokens.forget(remoteId);
        return account.revokeGitCredentials(remoteId);
      },
    },
    settings: () => settings.get(),
    signedIn: () => auth.getStatus().status === 'authenticated',
    emit: (list) => mainWindow?.webContents.send(REPOS_IPC.changed, list),
    emitProgress: (event) =>
      mainWindow?.webContents.send(REPOS_IPC.progress, event),
    // A conflict gitdesk's own pull just stopped on is already on screen, so it isn't news.
    onProblem: (repo, kind) =>
      !(kind === 'conflict' && journal.pending(repo.id)?.kind === 'pull') &&
      notifier.notify('problem', {
        title:
          kind === 'conflict'
            ? `${repo.name} has unresolved conflicts`
            : `${repo.name}'s folder can't be found`,
        body:
          kind === 'conflict'
            ? 'Found by a background check. Resolve them before you commit.'
            : 'It was moved or deleted. Locate it again from gitdesk.',
        tone: 'danger',
        repositoryId: repo.id,
      }),
    onCloneDone: (outcome) =>
      notifier.notify(
        'clone',
        outcome.ok
          ? {
              title: `${outcome.repository.name} cloned`,
              body: `${outcome.bytes ? `${formatBytes(outcome.bytes)} in ` : 'Done in '}${Math.max(1, Math.round(outcome.ms / 1000))} s. Click to open it.`,
              tone: 'success',
              repositoryId: outcome.repository.id,
            }
          : {
              title: `${outcome.name} wasn't cloned`,
              body: outcome.message,
              tone: 'danger',
              repositoryId: null,
            },
      ),
    log,
    desktop: {
      async pickDirectory({ title, create }) {
        const options: Electron.OpenDialogOptions = {
          title,
          properties: create
            ? ['openDirectory', 'createDirectory', 'dontAddToRecent']
            : ['openDirectory', 'dontAddToRecent'],
        };
        const result = mainWindow
          ? await dialog.showOpenDialog(mainWindow, options)
          : await dialog.showOpenDialog(options);
        return result.canceled ? null : (result.filePaths[0] ?? null);
      },
      // Paths come from gitdesk's own registry, never from the renderer.
      openPath: (target) => shell.openPath(target),
      copyText: (text) => clipboard.writeText(text),
      trashItem: (target) => shell.trashItem(target),
      protectedPaths: () => [
        os.homedir(),
        app.getPath('userData'),
        app.getPath('desktop'),
        app.getPath('documents'),
        app.getPath('downloads'),
      ],
    },
  });
  reposAuth = (status) => repos.handleAuth(status);
  // Set right after the sync service exists; a push only finishes after both are made.
  let sync: SyncService | null = null;
  // Set right after the workspace service, whose registry it reads roots from.
  let source: SourceService | null = null;
  const ws = createWorkspaceService({
    journal,
    discardDir: path.join(userData, 'Discarded changes'),
    forgetAuth: (remoteId) => tokens.forget(remoteId),
    onPushed: (op) => sync?.pushed(op),
    store,
    gitAuth: (remoteId, url, scope) => tokens.envFor(remoteId, url, scope),
    refresh: (id) => repos.refresh(id),
    addActivity: (id, type, detail) =>
      store.addActivity(id, type, detail, Date.now()),
    settings: () => settings.get(),
    watcher: createTreeWatcher({
      onChange: (id, dirs) => {
        void repos.refresh(id).catch(() => undefined);
        source?.invalidate(id);
        mainWindow?.webContents.send(SOURCE_IPC.changed, { id, dirs });
      },
      onGone: (id) => void repos.refresh(id).catch(() => undefined),
    }),
    emitProgress: (event) =>
      mainWindow?.webContents.send(REPOS_IPC.progress, event),
    log,
    desktop: {
      trashItem: (target) => shell.trashItem(target),
      // Paths here were checked to be inside a registered repository.
      showItemInFolder: (target) => shell.showItemInFolder(target),
      openPath: (target) => shell.openPath(target),
      copyText: (text) => clipboard.writeText(text),
      isOnline: () => net.isOnline(),
      // The path is one main found itself while detecting editors, never a renderer value.
      fileIcon: async (target) => {
        const icon = await app.getFileIcon(target, { size: 'normal' });
        return icon.isEmpty() ? null : icon.toDataURL();
      },
    },
  });
  workspace = ws;
  const localSource = createSourceService({
    rootOf: (id) => ws.rootOf(id),
    // Paths here were checked to be inside a registered repository; nothing is opened or run.
    showItemInFolder: (target) => shell.showItemInFolder(target),
  });
  source = localSource;
  const remoteSource = createRemoteSource({
    api,
    auth,
    settings: () => settings.get(),
    log,
    // The renderer never names the destination: the person picks it in the system dialog.
    async saveFile(suggestedName, bytes) {
      const options: Electron.SaveDialogOptions = {
        title: 'Save a copy',
        defaultPath: path.join(
          app.getPath('downloads'),
          suggestedName.replace(/[<>:"/\\|?*]|\p{Cc}/gu, '_') || 'file',
        ),
        properties: ['showOverwriteConfirmation', 'dontAddToRecent'],
      };
      const result = mainWindow
        ? await dialog.showSaveDialog(mainWindow, options)
        : await dialog.showSaveDialog(options);
      if (result.canceled || !result.filePath) return false;
      await writeFile(result.filePath, bytes);
      return true;
    },
  });
  const gitInstall = createGitInstall({
    db,
    async pickFile() {
      const options: Electron.OpenDialogOptions = {
        title: 'Choose the Git program',
        properties: ['openFile', 'dontAddToRecent'],
        filters:
          process.platform === 'win32'
            ? [{ name: 'Git', extensions: ['exe'] }]
            : undefined,
      };
      const result = mainWindow
        ? await dialog.showOpenDialog(mainWindow, options)
        : await dialog.showOpenDialog(options);
      return result.canceled ? null : (result.filePaths[0] ?? null);
    },
  });
  await gitInstall.restore();
  app.on('before-quit', () => {
    move.dispose();
    ws.dispose();
    repos.dispose();
  });

  const move = createMoveService({
    db,
    store,
    workspace: ws,
    hostedUrl: (remoteId) => account.hostedUrl(remoteId),
    gitAuth: (remoteId, url, scope) => tokens.envFor(remoteId, url, scope),
    emitProgress: (event) =>
      mainWindow?.webContents.send(REPOS_IPC.progress, event),
    addActivity: (id, type, detail) =>
      store.addActivity(id, type, detail, Date.now()),
    refresh: (id) => repos.refresh(id),
  });
  move.recover();
  // Account reads for Sync activity: signed in and not local-only, with server errors in words.
  async function accountCall<T>(fn: (token: string) => Promise<T>): Promise<T> {
    if (settings.get().localOnly || auth.getStatus().status !== 'authenticated')
      throw new UserError('Sign in to see the pushes your account recorded.');
    try {
      return await auth.authorized(fn);
    } catch (err) {
      throw userError(err, "Couldn't load your account's pushes.");
    }
  }
  const syncService = createSyncService({
    store,
    journal,
    workspace: ws,
    hostedUrl: (remoteId) => account.hostedUrl(remoteId),
    async report(remoteId, body) {
      if (
        settings.get().localOnly ||
        auth.getStatus().status !== 'authenticated'
      )
        throw new UserError('Not signed in.');
      const { event } = await auth.authorized((token) =>
        api.reportSync(token, remoteId, body),
      );
      return event.result;
    },
    account: {
      list: (input) => accountCall((token) => api.listSyncEvents(token, input)),
      stats: () => accountCall((token) => api.syncStats(token)),
    },
    addActivity: (id, type, detail) =>
      store.addActivity(id, type, detail, Date.now()),
    refresh: (id) => repos.refresh(id),
    log,
  });
  sync = syncService;
  void syncService.recover();

  const gitIdentity = createGitIdentity();
  // A linked repository keeps its pull requests in the account; any other one, in local SQLite.
  const pulls = createPullService({
    db,
    store,
    workspace: ws,
    recordsFor(repoId) {
      const row = store.get(repoId);
      if (!row) throw new UserError('That repository is no longer in gitdesk.');
      if (!row.remoteId) return createLocalRecords(db, repoId);
      const status = auth.getStatus();
      if (settings.get().localOnly || status.status !== 'authenticated')
        throw new UserError(
          "This repository's pull requests are stored in your account. Sign in and connect to see them.",
        );
      return createAccountRecords({
        api,
        call: (fn) => auth.authorized(fn),
        repositoryId: row.remoteId,
        localRepositoryId: repoId,
      });
    },
    async author() {
      const status = auth.getStatus();
      if (status.status === 'authenticated' && status.account)
        return {
          accountId: status.account.id,
          name: status.account.displayName,
          avatarUrl: status.account.avatarUrl,
        };
      const identity = await gitIdentity.get().catch(() => null);
      return {
        accountId: null,
        name: (identity?.available && identity.name) || 'You',
        avatarUrl: null,
      };
    },
    viewed: createViewedStore(db),
    addActivity: (id, type, detail) =>
      store.addActivity(id, type, detail, Date.now()),
    refresh: (id) => repos.refresh(id),
    log,
  });

  const branches = createBranchService({
    store,
    workspace: ws,
    pulls,
    addActivity: (id, type, detail) =>
      store.addActivity(id, type, detail, Date.now()),
    refresh: (id) => repos.refresh(id),
  });

  registerIpc(
    createHandle(() => mainWindow?.webContents ?? null, origins),
    {
      app: createAppService(() => mainWindow),
      auth,
      settings,
      git: gitIdentity,
      repos,
      remote,
      notifier,
      workspace: ws,
      gitInstall,
      pulls,
      move,
      sync: syncService,
      source: localSource,
      remoteSource,
      branches,
    },
  );

  const openWindow = () => {
    mainWindow = createMainWindow(devServerUrl, () => settings.get().zoomLevel);
    mainWindow.on('focus', () => repos.windowFocused());
    mainWindow.on('closed', () => {
      mainWindow = null;
    });
  };
  openWindow();
  void auth.restore();
  repos.start();

  app.on('activate', () => {
    if (!mainWindow) openWindow();
  });
}
