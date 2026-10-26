import path from 'node:path';
import { app, Menu, nativeImage, Tray } from 'electron';
import type { UpdateStatus } from '../shared/updates';

// The tray icon while gitdesk runs. Closing the window still quits, as it always has; the tray is
// a shortcut back to the window and to updates, not a way to keep gitdesk alive in the background.
export function createTray(actions: {
  open: () => void;
  check: () => void;
  install: () => void;
  quit: () => void;
}) {
  // Packaged builds carry the icons in resources/tray (extraResources); a dev run reads assets/.
  const dir = app.isPackaged
    ? path.join(process.resourcesPath, 'tray')
    : path.join(app.getAppPath(), 'assets', 'tray');
  const icon = nativeImage.createFromPath(
    path.join(dir, process.platform === 'win32' ? 'tray.ico' : 'tray.png'),
  );
  const tray = new Tray(icon);
  tray.on('click', actions.open);

  function update(status: UpdateStatus | null): void {
    const ready =
      status?.phase === 'downloaded' ||
      status?.phase === 'busy' ||
      (status?.phase === 'error' && status.stage === 'install');
    const version =
      status && 'release' in status ? status.release?.version : null;
    const checkable =
      status !== null &&
      ['idle', 'up-to-date', 'error', 'available'].includes(status.phase) &&
      status.installKind !== 'dev' &&
      status.installKind !== 'archive';
    tray.setToolTip(
      ready && version ? `gitdesk · ${version} ready to install` : 'gitdesk',
    );
    // Linux needs the menu set again after any change.
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: 'Open gitdesk', click: actions.open },
        { type: 'separator' },
        ...(ready && version
          ? [{ label: `Restart to install ${version}`, click: actions.install }]
          : []),
        {
          label: 'Check for updates',
          enabled: checkable,
          click: actions.check,
        },
        { type: 'separator' },
        { label: 'Quit gitdesk', click: actions.quit },
      ]),
    );
  }

  update(null);
  return { update, destroy: () => tray.destroy() };
}
