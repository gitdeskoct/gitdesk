import { EventEmitter } from 'node:events';
import { mkdtempSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { UpdateStatus } from '../../shared/updates';
import {
  createUpdateService,
  detectInstallKind,
  type Updater,
} from './update-service';

const INFO = {
  version: '1.1.0',
  releaseDate: '2026-11-03T10:00:00.000Z',
  releaseNotes: '<h2>What’s new</h2><ul><li>Updates</li></ul>',
  files: [{ size: 96_400_000 }],
};

class FakeUpdater extends EventEmitter implements Updater {
  autoDownload = true;
  autoInstallOnAppQuit = true;
  allowPrerelease = true;
  allowDowngrade = true;
  check = vi.fn(async () => {});
  download = vi.fn(async () => {});
  quitAndInstall = vi.fn();
  checkForUpdates() {
    return this.check();
  }
  downloadUpdate() {
    return this.download();
  }
}

let updater: FakeUpdater;
let emitted: UpdateStatus[];
let busy: boolean;
let online: boolean;
let lastCheck: { at: number; ok: boolean } | null;
const downloaded = vi.fn();
const openExternal = vi.fn(async () => {});

const setup = (installKind: UpdateStatus['installKind'] = 'nsis') =>
  createUpdateService({
    updater,
    installKind,
    currentVersion: '1.0.0',
    autoCheck: () => true,
    isOnline: () => online,
    busy: () => busy,
    lastCheck: {
      get: () => lastCheck,
      set: (value) => {
        lastCheck = value;
      },
    },
    emit: (status) => emitted.push(status),
    downloaded,
    openExternal,
    log: { info() {}, warn() {} },
    now: () => 1_000,
  });

beforeEach(() => {
  vi.useFakeTimers();
  updater = new FakeUpdater();
  emitted = [];
  busy = false;
  online = true;
  lastCheck = null;
  downloaded.mockReset();
  openExternal.mockClear();
});
afterEach(() => vi.useRealTimers());

describe('settings it forces on electron-updater', () => {
  it('never downloads or allows prereleases or downgrades by itself', () => {
    setup('nsis');
    expect(updater.autoDownload).toBe(false);
    expect(updater.allowPrerelease).toBe(false);
    expect(updater.allowDowngrade).toBe(false);
    expect(updater.autoInstallOnAppQuit).toBe(true);
  });

  it('never installs a deb or pacman package on quit, since that asks for a password', () => {
    setup('deb');
    expect(updater.autoInstallOnAppQuit).toBe(false);
  });
});

describe('checking', () => {
  it('goes checking, then available with the release, and records the check', async () => {
    const service = setup();
    updater.check.mockImplementation(async () => {
      expect(service.status().phase).toBe('checking');
      updater.emit('update-available', INFO);
    });
    const status = await service.check();
    expect(status.phase).toBe('available');
    expect(status).toMatchObject({
      release: { version: '1.1.0', sizeBytes: 96_400_000 },
      releasePage:
        'https://github.com/BotCoder254/gitdesk-releases/releases/tag/v1.1.0',
    });
    expect(lastCheck).toEqual({ at: 1_000, ok: true });
  });

  it('says up to date', async () => {
    const service = setup();
    updater.check.mockImplementation(async () => {
      updater.emit('update-not-available', {});
    });
    expect((await service.check()).phase).toBe('up-to-date');
  });

  it('names an offline failure as offline and keeps the last good check apart', async () => {
    const service = setup();
    online = false;
    updater.check.mockRejectedValue(
      new Error('net::ERR_INTERNET_DISCONNECTED'),
    );
    const status = await service.check();
    expect(status).toMatchObject({
      phase: 'error',
      stage: 'check',
      offline: true,
    });
    expect(lastCheck).toEqual({ at: 1_000, ok: false });
  });

  it('does nothing in a copy that can’t update itself', async () => {
    updater = null as unknown as FakeUpdater;
    const service = setup('archive');
    expect((await service.check()).phase).toBe('idle');
  });
});

describe('downloading', () => {
  async function available() {
    const service = setup();
    updater.check.mockImplementation(async () => {
      updater.emit('update-available', INFO);
    });
    await service.check();
    return service;
  }

  it('reports progress, then downloaded, and tells the person once', async () => {
    const service = await available();
    updater.download.mockImplementation(async () => {
      updater.emit('download-progress', {
        percent: 46,
        transferred: 44,
        total: 96,
        bytesPerSecond: 2,
      });
      expect(service.status()).toMatchObject({
        phase: 'downloading',
        percent: 46,
      });
      updater.emit('update-downloaded', INFO);
    });
    expect((await service.download()).phase).toBe('downloaded');
    expect(downloaded).toHaveBeenCalledTimes(1);
  });

  it('calls a SHA-512 mismatch a failed check, not a cut-off download', async () => {
    const service = await available();
    updater.download.mockImplementation(async () => {
      updater.emit(
        'error',
        new Error('sha512 checksum mismatch, expected abc, got def'),
      );
    });
    expect(await service.download()).toMatchObject({
      phase: 'error',
      stage: 'verify',
    });
  });

  it('can download again after a failure', async () => {
    const service = await available();
    updater.download.mockRejectedValueOnce(new Error('socket hang up'));
    expect(await service.download()).toMatchObject({ stage: 'download' });
    updater.download.mockImplementation(async () => {
      updater.emit('update-downloaded', INFO);
    });
    expect((await service.download()).phase).toBe('downloaded');
  });
});

describe('restarting to install', () => {
  async function downloadedService() {
    const service = setup();
    updater.check.mockImplementation(async () => {
      updater.emit('update-available', INFO);
    });
    await service.check();
    updater.download.mockImplementation(async () => {
      updater.emit('update-downloaded', INFO);
    });
    await service.download();
    return service;
  }

  it('installs silently and asks the installer to reopen gitdesk', async () => {
    const service = await downloadedService();
    expect(service.install('now').phase).toBe('restarting');
    vi.advanceTimersByTime(300);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('asks first while a clone or push is running, and can restart anyway', async () => {
    const service = await downloadedService();
    busy = true;
    expect(service.install('now')).toMatchObject({
      phase: 'busy',
      waiting: false,
    });
    expect(updater.quitAndInstall).not.toHaveBeenCalled();
    expect(service.install('anyway').phase).toBe('restarting');
  });

  it('waits for the work to finish when asked', async () => {
    const service = await downloadedService();
    busy = true;
    expect(service.install('when-idle')).toMatchObject({
      phase: 'busy',
      waiting: true,
    });
    vi.advanceTimersByTime(4_000);
    expect(service.status().phase).toBe('busy');
    busy = false;
    vi.advanceTimersByTime(2_000 + 300);
    expect(updater.quitAndInstall).toHaveBeenCalledWith(true, true);
  });

  it('says so if gitdesk is still running long after the installer should have taken over', async () => {
    const service = await downloadedService();
    service.install('now');
    vi.advanceTimersByTime(30_000);
    expect(service.status()).toMatchObject({
      phase: 'error',
      stage: 'install',
    });
    // The download is still good, so Restart can try again.
    expect(service.install('now').phase).toBe('restarting');
  });

  it('opens only the fixed release page', async () => {
    const service = await downloadedService();
    await service.openReleasePage();
    expect(openExternal).toHaveBeenCalledWith(
      'https://github.com/BotCoder254/gitdesk-releases/releases/tag/v1.1.0',
    );
  });
});

describe('detectInstallKind', () => {
  const base = {
    packaged: true,
    platform: 'linux' as NodeJS.Platform,
    appImage: undefined,
  };
  const resources = (type?: string) => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'gitdesk-res-'));
    if (type) writeFileSync(path.join(dir, 'package-type'), `${type}\n`);
    return dir;
  };

  it('tells every install type apart', () => {
    expect(
      detectInstallKind({
        ...base,
        packaged: false,
        resourcesPath: resources(),
      }),
    ).toBe('dev');
    expect(
      detectInstallKind({
        ...base,
        platform: 'win32',
        resourcesPath: resources(),
      }),
    ).toBe('nsis');
    expect(
      detectInstallKind({
        ...base,
        appImage: '/tmp/gitdesk.AppImage',
        resourcesPath: resources(),
      }),
    ).toBe('appimage');
    expect(
      detectInstallKind({ ...base, resourcesPath: resources('deb') }),
    ).toBe('deb');
    expect(
      detectInstallKind({ ...base, resourcesPath: resources('pacman') }),
    ).toBe('pacman');
    expect(detectInstallKind({ ...base, resourcesPath: resources() })).toBe(
      'archive',
    );
  });
});
