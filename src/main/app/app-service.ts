import os from 'node:os';
import path from 'node:path';
import { app, clipboard, shell, type BrowserWindow } from 'electron';
import log from 'electron-log/main';
import type { AppInfo, WindowCommand } from '../../shared/ipc';

const GIT_DOWNLOAD_URL = 'https://git-scm.com/downloads';
// Electron has no login-item API on Linux.
const loginItemsSupported =
  process.platform === 'win32' || process.platform === 'darwin';

// App-level actions the renderer may trigger. Every URL and path here is fixed in main;
// none comes from the renderer.
export function createAppService(getWindow: () => BrowserWindow | null) {
  const info = (): AppInfo => ({
    version: app.getVersion(),
    electron: process.versions.electron,
    platform: process.platform as AppInfo['platform'],
    openAtLogin: loginItemsSupported
      ? app.getLoginItemSettings().openAtLogin
      : null,
  });

  return {
    info,
    setOpenAtLogin(enabled: boolean): AppInfo {
      if (loginItemsSupported)
        app.setLoginItemSettings({ openAtLogin: enabled });
      return info();
    },
    async openLogs(): Promise<void> {
      const error = await shell.openPath(
        path.dirname(log.transports.file.getFile().path),
      );
      if (error) throw new Error("Couldn't open the logs folder.");
    },
    copyDiagnostics(): void {
      const { version, electron } = info();
      clipboard.writeText(
        [
          `gitdesk ${version}`,
          `Electron ${electron}`,
          `Chrome ${process.versions.chrome}`,
          `${process.platform} ${process.arch} ${os.release()}`,
        ].join('\n'),
      );
    },
    command(command: WindowCommand): void {
      if (command === 'quit') return app.quit();
      const win = getWindow();
      if (!win) return;
      if (command === 'toggleFullScreen')
        return win.setFullScreen(!win.isFullScreen());
      win.webContents[command]();
    },
    openGitInstallPage: () => shell.openExternal(GIT_DOWNLOAD_URL),
  };
}

export type AppService = ReturnType<typeof createAppService>;
