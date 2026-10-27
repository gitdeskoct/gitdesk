import { readFileSync } from 'node:fs';
import path from 'node:path';
import type {
  InstallKind,
  InstallMode,
  UpdatePhase,
  UpdateRelease,
  UpdateStatus,
} from '../../shared/updates';

export const RELEASE_REPOSITORIES = {
  stable: 'gitdeskoct/gitdesk',
  beta: 'BotCoder254/gitdesk-releases',
} as const;
export type UpdateChannel = keyof typeof RELEASE_REPOSITORIES;

const STARTUP_DELAY_MS = 10_000;
const CHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const IDLE_POLL_MS = 2_000;
// If gitdesk is still running this long after quitAndInstall, the installer never took over.
const INSTALL_WATCHDOG_MS = 30_000;

// The part of electron-updater's AppUpdater this service uses, so tests can pass a fake.
export type Updater = {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  setFeedURL(options: {
    provider: 'github';
    owner: string;
    repo: string;
    releaseType: 'release' | 'prerelease';
  }): void;
  // Matches EventEmitter's own signature, which electron-updater's events go through.
  on(event: string, listener: (...args: any[]) => void): unknown;
  checkForUpdates(): Promise<unknown>;
  downloadUpdate(): Promise<unknown>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
};

type UpdateInfo = {
  version: string;
  releaseDate?: string | null;
  releaseNotes?: unknown;
  files?: { size?: number }[];
};

export function detectInstallKind(env: {
  packaged: boolean;
  platform: NodeJS.Platform;
  appImage: string | undefined;
  resourcesPath: string;
}): InstallKind {
  if (!env.packaged) return 'dev';
  if (env.platform === 'win32') return 'nsis';
  if (env.platform !== 'linux') return 'archive';
  if (env.appImage) return 'appimage';
  // electron-builder writes this file into deb and pacman packages; the tar.gz has none.
  try {
    const type = readFileSync(
      path.join(env.resourcesPath, 'package-type'),
      'utf8',
    ).trim();
    if (type === 'deb' || type === 'pacman') return type;
  } catch {
    // No file: the archive.
  }
  return 'archive';
}

const releaseOf = (info: UpdateInfo): UpdateRelease => ({
  version: info.version,
  date: info.releaseDate ?? null,
  notes: typeof info.releaseNotes === 'string' ? info.releaseNotes : null,
  sizeBytes: info.files?.[0]?.size ?? null,
});

// electron-updater reports a failed SHA-512 or signature check as a download error; these are the
// strings it uses, so the screen can say the file was rejected rather than cut off.
const VERIFY_FAILURE =
  /sha512 checksum mismatch|ERR_UPDATER_INVALID_SIGNATURE|not signed by the application owner|ERR_CHECKSUM_MISMATCH/i;

const MESSAGES = {
  offline: "This computer is offline, so gitdesk couldn't reach GitHub.",
  check:
    "Couldn't check for updates. GitHub didn't answer, or sent something gitdesk couldn't read.",
  download: 'The download stopped before it finished. Nothing was installed.',
  verify:
    "The download didn't match the release's SHA-512, so gitdesk discarded it. Nothing was installed.",
  install:
    "The installer didn't take over, so nothing changed. Restart gitdesk to try again, or install the new version from the release page.",
};

export function createUpdateService(deps: {
  // null when this copy can't update itself (a dev run, the archive or Nix).
  updater: Updater | null;
  installKind: InstallKind;
  currentVersion: string;
  autoCheck: () => boolean;
  updateChannel: () => UpdateChannel;
  isOnline: () => boolean;
  // A clone, push or move is running, which a restart would stop.
  busy: () => boolean;
  lastCheck: {
    get(): { at: number; ok: boolean } | null;
    set(value: { at: number; ok: boolean }): void;
  };
  emit: (status: UpdateStatus) => void;
  // The download finished: tell the person, as a toast or a system notification.
  downloaded: (release: UpdateRelease) => void;
  openExternal: (url: string) => Promise<void>;
  log: { info(...args: unknown[]): void; warn(...args: unknown[]): void };
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const updater = deps.updater;
  let current: UpdatePhase = { phase: 'idle' };
  let release: UpdateRelease | null = null;
  const timers: ReturnType<typeof setTimeout>[] = [];
  let idlePoll: ReturnType<typeof setInterval> | null = null;

  const status = (): UpdateStatus => ({
    ...current,
    installKind: deps.installKind,
    currentVersion: deps.currentVersion,
    lastCheck: deps.lastCheck.get(),
    releasePage: release
      ? `${releaseUrl(deps.updateChannel())}/releases/tag/v${release.version}`
      : `${releaseUrl(deps.updateChannel())}/releases`,
  });

  function releaseUrl(channel: UpdateChannel) {
    return `https://github.com/${RELEASE_REPOSITORIES[channel]}`;
  }

  function set(phase: UpdatePhase): UpdateStatus {
    current = phase;
    const next = status();
    deps.emit(next);
    return next;
  }

  function fail(
    stage: 'check' | 'download' | 'verify' | 'install',
    err: unknown,
  ) {
    const offline = stage === 'check' && !deps.isOnline();
    deps.log.warn('update', stage, err instanceof Error ? err.message : err);
    if (stage === 'check') deps.lastCheck.set({ at: now(), ok: false });
    return set({
      phase: 'error',
      stage,
      offline,
      message: offline ? MESSAGES.offline : MESSAGES[stage],
      release,
    });
  }

  if (updater) {
    updater.autoDownload = false;
    // Only installs that don't ask for a password finish on quit; deb and pacman wait for Restart.
    updater.autoInstallOnAppQuit =
      deps.installKind === 'nsis' || deps.installKind === 'appimage';
    updater.allowPrerelease = false;
    updater.allowDowngrade = false;

    updater.on('update-available', (info: UpdateInfo) => {
      release = releaseOf(info);
      deps.lastCheck.set({ at: now(), ok: true });
      set({ phase: 'available', release });
    });
    updater.on('update-not-available', () => {
      deps.lastCheck.set({ at: now(), ok: true });
      set({ phase: 'up-to-date' });
    });
    updater.on(
      'download-progress',
      (progress: {
        percent: number;
        transferred: number;
        total: number;
        bytesPerSecond: number;
      }) => {
        if (!release) return;
        set({
          phase: 'downloading',
          release,
          percent: Math.max(0, Math.min(100, progress.percent)),
          transferred: progress.transferred,
          total: progress.total,
          bytesPerSecond: progress.bytesPerSecond,
        });
      },
    );
    // Sent only after electron-updater has checked the file against the release's SHA-512.
    updater.on('update-downloaded', (info: UpdateInfo) => {
      release = releaseOf(info);
      set({ phase: 'downloaded', release });
      deps.downloaded(release);
    });
    updater.on('error', (err: Error) => {
      const phase = current.phase;
      if (phase === 'checking') fail('check', err);
      else if (phase === 'downloading' || phase === 'available')
        fail(
          VERIFY_FAILURE.test(err?.message ?? '') ? 'verify' : 'download',
          err,
        );
      else if (phase === 'restarting') fail('install', err);
    });
  }

  async function check(): Promise<UpdateStatus> {
    // Never interrupt a download or a finished one: a new check would only find the same version.
    if (
      !updater ||
      !['idle', 'up-to-date', 'error', 'available'].includes(current.phase)
    )
      return status();
    if (current.phase === 'error' && current.stage !== 'check') return status();
    set({ phase: 'checking' });
    try {
      const [owner, repo] =
        RELEASE_REPOSITORIES[deps.updateChannel()].split('/');
      if (!owner || !repo) throw new Error('Invalid update repository');
      updater.setFeedURL({
        provider: 'github',
        owner,
        repo,
        releaseType: deps.updateChannel() === 'beta' ? 'prerelease' : 'release',
      });
      updater.allowPrerelease = deps.updateChannel() === 'beta';
      await updater.checkForUpdates();
    } catch (err) {
      // The 'error' event usually got here first; this covers a rejection without one.
      if (current.phase === 'checking') fail('check', err);
    }
    return status();
  }

  async function download(): Promise<UpdateStatus> {
    const canStart =
      current.phase === 'available' ||
      (current.phase === 'error' &&
        (current.stage === 'download' || current.stage === 'verify'));
    if (!updater || !release || !canStart) return status();
    set({
      phase: 'downloading',
      release,
      percent: 0,
      transferred: 0,
      total: release.sizeBytes ?? 0,
      bytesPerSecond: 0,
    });
    try {
      await updater.downloadUpdate();
    } catch (err) {
      if (current.phase === 'downloading')
        fail(
          VERIFY_FAILURE.test(err instanceof Error ? err.message : '')
            ? 'verify'
            : 'download',
          err,
        );
    }
    return status();
  }

  function stopIdlePoll() {
    if (idlePoll) clearInterval(idlePoll);
    idlePoll = null;
  }

  function restart(): UpdateStatus {
    stopIdlePoll();
    if (!updater || !release) return status();
    const next = set({ phase: 'restarting', release });
    deps.log.info('update', 'restarting to install', release.version);
    // A moment for the spinner to paint, then electron-updater closes every window, runs the
    // installer silently and starts the new version (isForceRunAfter).
    timers.push(
      setTimeout(() => {
        try {
          updater.quitAndInstall(true, true);
        } catch (err) {
          fail('install', err);
        }
      }, 300),
    );
    timers.push(
      setTimeout(() => {
        if (current.phase === 'restarting')
          fail('install', new Error('still running after quitAndInstall'));
      }, INSTALL_WATCHDOG_MS),
    );
    return next;
  }

  function install(mode: InstallMode): UpdateStatus {
    const ready =
      current.phase === 'downloaded' ||
      current.phase === 'busy' ||
      (current.phase === 'error' && current.stage === 'install');
    if (!updater || !release || !ready) return status();
    if (mode === 'anyway' || !deps.busy()) return restart();
    if (mode === 'now') return set({ phase: 'busy', release, waiting: false });
    stopIdlePoll();
    idlePoll = setInterval(() => {
      if (!deps.busy()) restart();
    }, IDLE_POLL_MS);
    return set({ phase: 'busy', release, waiting: true });
  }

  return {
    status,
    check,
    download,
    install,
    async openReleasePage(): Promise<void> {
      // Built here from a fixed origin; the renderer never passes a URL.
      await deps.openExternal(status().releasePage);
    },
    // Checks once shortly after start and every 6 hours while automatic checks are on.
    start(): void {
      if (!updater) return;
      timers.push(
        setTimeout(() => {
          if (deps.autoCheck()) void check();
        }, STARTUP_DELAY_MS),
      );
      timers.push(
        setInterval(() => {
          if (deps.autoCheck()) void check();
        }, CHECK_EVERY_MS),
      );
    },
    dispose(): void {
      stopIdlePoll();
      for (const timer of timers) clearTimeout(timer);
    },
  };
}

export type UpdateService = ReturnType<typeof createUpdateService>;
