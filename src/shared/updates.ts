import { z } from 'zod';

// How this copy was installed decides whether and how it can update itself.
//   nsis      the Windows setup program: silent install, then gitdesk reopens
//   appimage  replaces the AppImage file in place
//   deb       dpkg -i through pkexec, so Linux asks for an administrator password
//   pacman    pacman -U, the same way
//   archive   the .tar.gz or Nix: updated the way it was installed, never by gitdesk
//   dev       an unpackaged run from source
export type InstallKind =
  | 'nsis'
  | 'appimage'
  | 'deb'
  | 'pacman'
  | 'archive'
  | 'dev';

export type UpdateRelease = {
  version: string;
  date: string | null;
  // HTML from the GitHub release body. Untrusted: the renderer sanitizes it before showing it.
  notes: string | null;
  sizeBytes: number | null;
};

export type UpdatePhase =
  | { phase: 'idle' }
  | { phase: 'checking' }
  | { phase: 'up-to-date' }
  | { phase: 'available'; release: UpdateRelease }
  | {
      phase: 'downloading';
      release: UpdateRelease;
      percent: number;
      transferred: number;
      total: number;
      bytesPerSecond: number;
    }
  | { phase: 'downloaded'; release: UpdateRelease }
  // Restart was asked for while a clone, push or move was running; nothing has closed yet.
  | { phase: 'busy'; release: UpdateRelease; waiting: boolean }
  | { phase: 'restarting'; release: UpdateRelease }
  | {
      phase: 'error';
      stage: 'check' | 'download' | 'verify' | 'install';
      offline: boolean;
      message: string;
      release: UpdateRelease | null;
    };

export type UpdateStatus = UpdatePhase & {
  installKind: InstallKind;
  currentVersion: string;
  // When a check last finished, and whether it worked.
  lastCheck: { at: number; ok: boolean } | null;
  releasePage: string;
};

// now: restart unless a clone, push or move is running. anyway: restart even then.
// when-idle: restart as soon as that work finishes.
export const installModeSchema = z.enum(['now', 'anyway', 'when-idle']);
export type InstallMode = z.infer<typeof installModeSchema>;

export const UPDATES_IPC = {
  status: 'updates:status',
  check: 'updates:check',
  download: 'updates:download',
  install: 'updates:install',
  openReleasePage: 'updates:open-release-page',
  // Pushed from main on every change.
  changed: 'updates:changed',
} as const;

export interface UpdatesApi {
  status(): Promise<UpdateStatus>;
  check(): Promise<UpdateStatus>;
  download(): Promise<UpdateStatus>;
  install(mode: InstallMode): Promise<UpdateStatus>;
  openReleasePage(): Promise<void>;
  onChanged(callback: (status: UpdateStatus) => void): () => void;
}

// True while there is something for the person to act on, which is when the title bar shows it.
export const updateNeedsAttention = (status: UpdateStatus): boolean =>
  status.phase === 'available' ||
  status.phase === 'downloading' ||
  status.phase === 'downloaded' ||
  status.phase === 'busy' ||
  status.phase === 'restarting' ||
  (status.phase === 'error' && status.stage !== 'check');
