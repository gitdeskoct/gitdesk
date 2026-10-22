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
import { accountSummarySchema, IPC } from '../shared/ipc';
import { REPOS_IPC } from '../shared/repos';
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
  createWorkspaceService,
  type WorkspaceService,
} from './repos/workspace-service';
import { createHandle } from './ipc/handle';
import { registerIpc } from './ipc/register';
import { createNotifier } from './notifier';
import { registerAppScheme, serveRendererFrom } from './protocol';
import {
  createRemoteService,
  type RemoteService,
} from './remote/remote-service';
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
  remote = createRemoteService({
    db,
    api,
    auth,
    store,
    settings: () => settings.get(),
  });
  const repos = createRepositoryService({
    store,
    remote,
    settings: () => settings.get(),
    emit: (list) => mainWindow?.webContents.send(REPOS_IPC.changed, list),
    emitProgress: (event) =>
      mainWindow?.webContents.send(REPOS_IPC.progress, event),
    onProblem: (repo, kind) =>
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
  const ws = createWorkspaceService({
    store,
    refresh: (id) => repos.refresh(id),
    addActivity: (id, type, detail) =>
      store.addActivity(id, type, detail, Date.now()),
    settings: () => settings.get(),
    watcher: createTreeWatcher({
      onChange: (id) => void repos.refresh(id).catch(() => undefined),
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
    },
  });
  workspace = ws;
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
    ws.dispose();
    repos.dispose();
  });

  registerIpc(
    createHandle(() => mainWindow?.webContents ?? null, origins),
    {
      app: createAppService(() => mainWindow),
      auth,
      settings,
      git: createGitIdentity(),
      repos,
      remote,
      notifier,
      workspace: ws,
      gitInstall,
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
