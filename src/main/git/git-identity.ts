import os from 'node:os';
import type { SimpleGit } from 'simple-git';
import type {
  GitDefaults,
  GitIdentity,
  GitIdentityInput,
} from '../../shared/ipc';
import { gitAt } from '../repos/git-inspector';

const AUTOCRLF = ['true', 'input', 'false'] as const;

// Global config only. Values go to git as argv entries (no shell), and are validated before this
// point. Runs from the home folder with the same environment allow-list and timeout as inspection.
export function createGitIdentity(git: SimpleGit = gitAt(os.homedir())) {
  async function read(key: string): Promise<string | null> {
    const { value } = await git.getConfig(key, 'global');
    return value || null;
  }

  async function get(): Promise<GitIdentity> {
    const version = await git.version().catch(() => null);
    if (!version?.installed) return { available: false };
    const autocrlf = (await read('core.autocrlf'))?.toLowerCase();
    return {
      available: true,
      name: await read('user.name'),
      email: await read('user.email'),
      defaultBranch: await read('init.defaultBranch'),
      autocrlf: AUTOCRLF.find((value) => value === autocrlf) ?? null,
    };
  }

  return {
    get,
    async set(input: GitIdentityInput): Promise<GitIdentity> {
      await git.addConfig('user.name', input.name, false, 'global');
      await git.addConfig('user.email', input.email, false, 'global');
      return get();
    },
    async setDefaults(input: GitDefaults): Promise<GitIdentity> {
      await git.addConfig(
        'init.defaultBranch',
        input.defaultBranch,
        false,
        'global',
      );
      await git.addConfig('core.autocrlf', input.autocrlf, false, 'global');
      return get();
    },
  };
}
