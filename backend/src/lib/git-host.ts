// Git hosting for account repositories. Cloudflare Artifacts serves Git smart HTTP; the Worker only
// creates and deletes the repository and mints short-lived tokens. Git traffic never passes through here.
export type GitScope = 'read' | 'write';

export type GitHost = {
  // Idempotent: creates the repository, or returns the remote of the one already there.
  ensure(name: string, defaultBranch: string): Promise<string>;
  // Idempotent: true once nothing is left under that name.
  remove(name: string): Promise<void>;
  token(name: string, scope: GitScope, ttlSeconds: number): Promise<{ token: string; expiresAt: number }>;
  revokeAll(name: string): Promise<number>;
};

const isCode = (err: unknown, code: string): boolean =>
  typeof err === 'object' && err !== null && 'code' in err && err.code === code;

// A remote is only stored or handed out when it is plain https with no credentials in it.
export function assertRemote(url: string): string {
  const parsed = new URL(url);
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || parsed.search || parsed.hash)
    throw new Error('git host returned an unexpected remote');
  return parsed.toString();
}

// Repository handles are RPC stubs; disposing releases them before the request ends.
async function withRepo<T>(artifacts: Artifacts, name: string, fn: (repo: ArtifactsRepo) => Promise<T>) {
  const repo = await artifacts.get(name);
  try {
    return await fn(repo);
  } finally {
    repo[Symbol.dispose]();
  }
}

export function artifactsHost(artifacts: Artifacts): GitHost {
  return {
    async ensure(name, defaultBranch) {
      try {
        const created = await artifacts.create(name, {
          setDefaultBranch: defaultBranch,
          description: 'gitdesk repository',
        });
        return assertRemote(created.remote);
      } catch (err) {
        // A provision retried after the create succeeded: read the remote it already has.
        if (!isCode(err, 'ALREADY_EXISTS')) throw err;
        return withRepo(artifacts, name, async (repo) => assertRemote((await repo.info()).remote));
      }
    },
    async remove(name) {
      // false means it was already gone, which is the outcome we want.
      await artifacts.delete(name);
    },
    token(name, scope, ttlSeconds) {
      return withRepo(artifacts, name, async (repo) => {
        const created = await repo.createToken(scope, ttlSeconds);
        return { token: created.plaintext, expiresAt: Date.parse(created.expiresAt) };
      });
    },
    revokeAll(name) {
      return withRepo(artifacts, name, async (repo) => {
        const { tokens } = await repo.listTokens();
        let revoked = 0;
        for (const { id } of tokens) if (await repo.revokeToken(id)) revoked++;
        return revoked;
      });
    },
  };
}

// Off unless the deployment opts in: Artifacts has no local simulator, so `wrangler dev --local`
// and tests run without it.
export const gitHostFor = (env: CloudflareBindings): GitHost | null =>
  env.GIT_HOSTING === 'artifacts' && env.ARTIFACTS ? artifactsHost(env.ARTIFACTS) : null;
