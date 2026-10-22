import { gitAuthEnv } from '../repos/git-inspector';
import type { GitCredentials, RemoteService } from './remote-service';

// gitdesk's own commands use 15-minute tokens, reused until a minute before they expire so a
// burst of fetches asks the server once. Tokens live in this map only, never on disk.
const OWN_LIFETIME = 900;
const MARGIN_MS = 60_000;

// The same remote however Git or the server spelled it: URL parsing lowercases the host and
// drops a default port; a trailing slash is ignored.
function sameUrl(a: string, b: string): boolean {
  try {
    const clean = (value: string) => new URL(value).href.replace(/\/+$/, '');
    return clean(a) === clean(b);
  } catch {
    return false;
  }
}

export function createGitAuth(deps: {
  remote: Pick<RemoteService, 'hostedUrl' | 'gitCredentials'>;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const held = new Map<string, GitCredentials>();

  async function credentials(
    remoteId: string,
    scope: 'read' | 'write',
  ): Promise<GitCredentials> {
    const current = held.get(remoteId);
    // A write token also reads; a read token never pushes.
    if (
      current &&
      current.expiresAt - now() > MARGIN_MS &&
      (scope === 'read' || current.scope === 'write')
    )
      return current;
    const fresh = await deps.remote.gitCredentials(
      remoteId,
      scope,
      OWN_LIFETIME,
    );
    held.set(remoteId, fresh);
    return fresh;
  }

  return {
    // Environment for one Git command against `url`, or null when `url` isn't the hosted remote
    // of this repository's account link. Other remotes keep using the person's own credentials.
    async envFor(
      remoteId: string | null,
      url: string,
      scope: 'read' | 'write',
    ): Promise<Record<string, string> | null> {
      if (!remoteId) return null;
      const hosted = await deps.remote.hostedUrl(remoteId).catch(() => null);
      if (!hosted || !sameUrl(hosted, url)) return null;
      const { token } = await credentials(remoteId, scope);
      return gitAuthEnv(url, token);
    },

    // After a revoke, an unlink or a sign-out the held tokens are dropped.
    forget(remoteId?: string): void {
      if (remoteId) held.delete(remoteId);
      else held.clear();
    },
  };
}

export type GitAuth = ReturnType<typeof createGitAuth>;
export { sameUrl };
