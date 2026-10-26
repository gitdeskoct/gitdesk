import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { GitInstall } from '../../shared/workspace';
import {
  readState,
  writeState,
  deleteState,
  type AppDatabase,
} from '../db/database';
import { UserError } from '../errors';
import {
  customGitBinary,
  gitAt,
  MIN_GIT_VERSION,
  useGitBinary,
  versionAtLeast,
} from '../repos/git-inspector';

const KEY = 'git_binary';

// Runs the candidate directly, no shell, and only accepts it if it answers as Git.
function versionOf(binary: string): Promise<string | null> {
  return new Promise((resolve) =>
    execFile(
      binary,
      ['--version'],
      {
        timeout: 5000,
        windowsHide: true,
        env: {
          PATH: process.env.PATH ?? '',
          SystemRoot: process.env.SystemRoot ?? '',
          LC_ALL: 'C',
        },
      },
      (err, stdout) => {
        const match = /^git version (\d+\.\d+[^\s]*)/.exec(
          String(stdout).trim(),
        );
        resolve(err || !match ? null : match[1]!);
      },
    ),
  );
}

function onPath(): string | null {
  const names = process.platform === 'win32' ? ['git.exe'] : ['git'];
  for (const dir of (process.env.PATH ?? '').split(path.delimiter)) {
    for (const name of names) {
      const file = path.join(dir, name);
      if (dir && existsSync(file)) return file;
    }
  }
  return null;
}

export function createGitInstall(deps: {
  db: AppDatabase;
  pickFile: () => Promise<string | null>;
}) {
  async function read(key: string): Promise<string | null> {
    const value = (
      await gitAt(os.homedir())
        .raw(['config', '--get', key])
        .catch(() => '')
    ).trim();
    return value || null;
  }

  async function get(): Promise<GitInstall> {
    const custom = customGitBinary() !== null;
    const version = (
      await gitAt(os.homedir())
        .raw(['--version'])
        .catch(() => '')
    ).trim();
    const match = /^git version (\S+)/.exec(version);
    if (!match) return { available: false, custom };
    const [prune, signing, helper] = await Promise.all([
      read('fetch.prune'),
      read('commit.gpgsign'),
      read('credential.helper'),
    ]);
    return {
      available: true,
      version: match[1]!,
      tooOld: !versionAtLeast(match[1]!, MIN_GIT_VERSION),
      minimum: MIN_GIT_VERSION,
      location: customGitBinary() ?? onPath(),
      custom,
      prune: prune === null ? null : /^(true|yes|on|1)$/i.test(prune),
      signing: !!signing && /^(true|yes|on|1)$/i.test(signing),
      credentialHelper: helper ? helper.slice(0, 200) : null,
    };
  }

  return {
    // A saved custom Git that is gone or no longer answers falls back to the one on PATH.
    async restore(): Promise<void> {
      const saved = readState(deps.db, KEY);
      if (typeof saved !== 'string' || !path.isAbsolute(saved)) return;
      if (existsSync(saved) && (await versionOf(saved))) useGitBinary(saved);
      else deleteState(deps.db, KEY);
    },
    get,
    async choose(): Promise<GitInstall> {
      const file = await deps.pickFile();
      if (!file) return get();
      // On Windows only an .exe runs without a shell, so a .cmd or .bat is refused outright.
      const runnable =
        path.isAbsolute(file) &&
        (process.platform !== 'win32' || file.toLowerCase().endsWith('.exe'));
      if (!runnable || !(await versionOf(file)))
        throw new UserError(
          "That program didn't answer as Git, so gitdesk kept the one it had.",
        );
      useGitBinary(file);
      writeState(deps.db, KEY, file);
      return get();
    },
    async usePath(): Promise<GitInstall> {
      useGitBinary(null);
      deleteState(deps.db, KEY);
      return get();
    },
    async setGlobalPrune(enabled: boolean): Promise<GitInstall> {
      try {
        await gitAt(os.homedir()).raw([
          'config',
          '--global',
          'fetch.prune',
          enabled ? 'true' : 'false',
        ]);
      } catch {
        throw new UserError(
          "Git couldn't save fetch.prune to your global config.",
        );
      }
      return get();
    },
  };
}

export type GitInstallService = ReturnType<typeof createGitInstall>;
