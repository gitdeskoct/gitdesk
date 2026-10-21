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
import { createHandle } from './ipc/handle';
import { registerIpc } from './ipc/register';
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

function start() {
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
  const settings = new SettingsService(db, (patch) => {
    if (
      patch.watchRepositories !== undefined ||
      patch.backgroundRefresh !== undefined
    )
      repos.applySettings();
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
    emitCloneProgress: (event) =>
      mainWindow?.webContents.send(REPOS_IPC.cloneProgress, event),
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
    },
  });
  app.on('before-quit', () => repos.dispose());

  registerIpc(
    createHandle(() => mainWindow?.webContents ?? null, origins),
    {
      app: createAppService(() => mainWindow),
      auth,
      settings,
      git: createGitIdentity(),
      repos,
      remote,
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
