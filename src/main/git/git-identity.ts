import { simpleGit, type SimpleGit } from 'simple-git';
import type { GitIdentity, GitIdentityInput } from '../../shared/ipc';

// Global identity only; repository-level overrides arrive with the repositories feature.
// Values go to git as argv entries (no shell), and are validated before this point.
export function createGitIdentity(git: SimpleGit = simpleGit()) {
  async function read(key: string): Promise<string | null> {
    const { value } = await git.getConfig(key, 'global');
    return value || null;
  }

  return {
    async get(): Promise<GitIdentity> {
      const version = await git.version().catch(() => null);
      if (!version?.installed) return { available: false };
      return {
        available: true,
        name: await read('user.name'),
        email: await read('user.email'),
      };
    },
    async set(input: GitIdentityInput): Promise<GitIdentity> {
      await git.addConfig('user.name', input.name, false, 'global');
      await git.addConfig('user.email', input.email, false, 'global');
      return { available: true, name: input.name, email: input.email };
    },
  };
}
