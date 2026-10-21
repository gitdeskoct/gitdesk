import { simpleGit, type SimpleGit } from 'simple-git';
import type {
  GitDefaults,
  GitIdentity,
  GitIdentityInput,
} from '../../shared/ipc';

const AUTOCRLF = ['true', 'input', 'false'] as const;

// Global config only; repository-level overrides arrive with the repositories feature.
// Values go to git as argv entries (no shell), and are validated before this point.
export function createGitIdentity(git: SimpleGit = simpleGit()) {
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
