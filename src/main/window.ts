import path from 'node:path';
import { app, BrowserWindow, nativeTheme } from 'electron';
import log from 'electron-log/main';
import { APP_ORIGIN } from './config';

const TITLE_BAR_HEIGHT = 44;

// Matches --canvas / --ink in globals.css so no differently colored frame flashes on load.
export const chromeColors = () =>
  nativeTheme.shouldUseDarkColors
    ? { background: '#0b0b0d', symbol: '#f1f1f3' }
    : { background: '#eef0f3', symbol: '#14161a' };

export function applyChromeColors(win: BrowserWindow): void {
  const { background, symbol } = chromeColors();
  win.setBackgroundColor(background);
  if (process.platform !== 'darwin') {
    win.setTitleBarOverlay({
      color: background,
      symbolColor: symbol,
      height: TITLE_BAR_HEIGHT,
    });
  }
}

export function createMainWindow(
  devServerUrl: string | undefined,
): BrowserWindow {
  const { background, symbol } = chromeColors();
  const win = new BrowserWindow({
    width: 1200,
    height: 800,
    minWidth: 720,
    minHeight: 520,
    show: false,
    title: 'gitdesk',
    backgroundColor: background,
    titleBarStyle: 'hidden',
    titleBarOverlay:
      process.platform === 'darwin'
        ? undefined
        : { color: background, symbolColor: symbol, height: TITLE_BAR_HEIGHT },
    trafficLightPosition: { x: 16, y: 15 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      spellcheck: false,
    },
  });

  win.once('ready-to-show', () => win.show());
  // Packaged builds have no DevTools; this is where CSP violations and renderer errors surface.
  win.webContents.on(
    'console-message',
    ({ level, message, sourceId, lineNumber }) => {
      if (level === 'warning' || level === 'error') {
        log[level === 'error' ? 'error' : 'warn'](
          'renderer',
          message,
          `${sourceId}:${lineNumber}`,
        );
      }
    },
  );
  void win.loadURL(devServerUrl ?? `${APP_ORIGIN}/index.html`);
  if (!app.isPackaged) win.webContents.openDevTools({ mode: 'detach' });
  return win;
}
