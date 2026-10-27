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
  // Read-only checks of what a push left on the server.
  hasCommit(name: string, oid: string): Promise<boolean>;
  // The commit a branch points at now, or null when there is no such branch.
  tip(name: string, ref: string): Promise<string | null>;
  // Read-only object access for browsing files: one object by id, null when it isn't there or
  // isn't that kind. A blob larger than `max` comes back with its size and no bytes; size is null
  // when the host stopped reading before it knew.
  readCommit(name: string, oid: string): Promise<HostCommit | null>;
  readTree(name: string, oid: string): Promise<HostTreeEntry[] | null>;
  readBlob(name: string, oid: string, max: number): Promise<HostBlob | null>;
};

export type HostCommit = { oid: string; treeOid: string; author: string; committedAt: number; message: string };
export type HostTreeEntry = {
  name: string;
  mode: string;
  oid: string;
  type: 'tree' | 'blob' | 'symlink' | 'gitlink' | 'exec';
};
export type HostBlob = { size: number | null; bytes: Uint8Array | null };

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
    hasCommit(name, oid) {
      return withRepo(artifacts, name, async (repo) => (await repo.readCommit(oid)) !== null);
    },
    tip(name, ref) {
      // log() follows first parents from the ref and returns nothing for a ref it can't resolve.
      // It resolves short branch names only: "refs/heads/main" finds nothing (checked 27 Oct 2026).
      const branch = ref.startsWith('refs/heads/') ? ref.slice('refs/heads/'.length) : ref;
      return withRepo(artifacts, name, async (repo) => (await repo.log({ ref: branch, limit: 1 }))[0]?.hash ?? null);
    },
    revokeAll(name) {
      return withRepo(artifacts, name, async (repo) => {
        const { tokens } = await repo.listTokens();
        let revoked = 0;
        for (const { id } of tokens) if (await repo.revokeToken(id)) revoked++;
        return revoked;
      });
    },
    readCommit(name, oid) {
      return withRepo(artifacts, name, async (repo) => {
        const commit = await repo.readCommit(oid);
        return commit
          ? {
              oid: commit.hash,
              treeOid: commit.treeHash,
              author: commit.author.name,
              committedAt: commit.committedAt,
              message: commit.message,
            }
          : null;
      });
    },
    readTree(name, oid) {
      return withRepo(artifacts, name, async (repo) => {
        const entries = await repo.readTree(oid);
        return entries?.map((e) => ({ name: e.name, mode: e.mode, oid: e.hash, type: e.type })) ?? null;
      });
    },
    readBlob(name, oid, max) {
      return withRepo(artifacts, name, async (repo) => {
        let blob: Blob | null;
        try {
          blob = await repo.readBlob(oid);
        } catch (err) {
          // Artifacts refuses to buffer a blob it can't hold; that is a size answer, not a failure.
          if (isCode(err, 'MEMORY_LIMIT')) return { size: null, bytes: null };
          throw err;
        }
        if (!blob) return null;
        if (blob.size > max) return { size: blob.size, bytes: null };
        return { size: blob.size, bytes: new Uint8Array(await blob.arrayBuffer()) };
      });
    },
  };
}

// Development only: scripts/local-git-host.mjs on this machine, which serves real Git smart HTTP in
// place of Artifacts (Artifacts has no local simulator). Its admin API answers only on loopback and
// with the shared secret from .dev.vars.
export function localGitHost(admin: string, secret: string): GitHost {
  const call = async <T>(method: string, path: string, body?: unknown): Promise<T> => {
    const res = await fetch(new URL(path, admin), {
      method,
      headers: { 'x-local-git-secret': secret, 'content-type': 'application/json' },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new Error(`local git host answered ${res.status}`);
    return res.json<T>();
  };
  const repo = (name: string) => `/repos/${encodeURIComponent(name)}`;
  return {
    async ensure(name, defaultBranch) {
      return assertRemote((await call<{ remote: string }>('POST', '/repos', { name, defaultBranch })).remote);
    },
    async remove(name) {
      await call('DELETE', repo(name));
    },
    token: (name, scope, ttlSeconds) =>
      call<{ token: string; expiresAt: number }>('POST', `${repo(name)}/tokens`, { scope, ttlSeconds }),
    revokeAll: async (name) => (await call<{ revoked: number }>('DELETE', `${repo(name)}/tokens`)).revoked,
    hasCommit: async (name, oid) =>
      (await call<{ exists: boolean }>('GET', `${repo(name)}/commits/${encodeURIComponent(oid)}`)).exists,
    tip: async (name, ref) =>
      (await call<{ oid: string | null }>('GET', `${repo(name)}/tip?ref=${encodeURIComponent(ref)}`)).oid,
    readCommit: async (name, oid) =>
      (await call<{ commit: HostCommit | null }>('GET', `${repo(name)}/objects/${oid}/commit`)).commit,
    // The script answers in Artifacts' own shape (hash), mapped here the same way artifactsHost does.
    readTree: async (name, oid) => {
      const { entries } = await call<{
        entries: { name: string; mode: string; hash: string; type: HostTreeEntry['type'] }[] | null;
      }>('GET', `${repo(name)}/objects/${oid}/tree`);
      return entries?.map((e) => ({ name: e.name, mode: e.mode, oid: e.hash, type: e.type })) ?? null;
    },
    readBlob: async (name, oid, max) => {
      const { blob } = await call<{ blob: { size: number; base64: string | null } | null }>(
        'GET',
        `${repo(name)}/objects/${oid}/blob?max=${max}`,
      );
      if (!blob) return null;
      return {
        size: blob.size,
        bytes: blob.base64 === null ? null : Uint8Array.from(atob(blob.base64), (c) => c.charCodeAt(0)),
      };
    },
  };
}

const isLoopback = (url: string): boolean => {
  try {
    const { protocol, hostname } = new URL(url);
    return protocol === 'http:' && (hostname === '127.0.0.1' || hostname === 'localhost');
  } catch {
    return false;
  }
};

type HostingEnv = Omit<CloudflareBindings, 'ARTIFACTS'> & {
  // Bound in both deployed environments (Workers Paid only); absent where wrangler.jsonc omits it.
  ARTIFACTS?: Artifacts;
  // .dev.vars only, for GIT_HOSTING=local.
  LOCAL_GIT_HOST?: string;
  LOCAL_GIT_SECRET?: string;
};

// Off unless the deployment opts in. "artifacts" is the real service; "local" is the development
// stand-in and refuses any admin URL that isn't on this machine. Tests run with neither.
export function gitHostFor(env: HostingEnv): GitHost | null {
  if (env.GIT_HOSTING === 'artifacts' && env.ARTIFACTS) return artifactsHost(env.ARTIFACTS);
  if (
    env.GIT_HOSTING === 'local' &&
    env.LOCAL_GIT_HOST &&
    isLoopback(env.LOCAL_GIT_HOST) &&
    (env.LOCAL_GIT_SECRET?.length ?? 0) >= 16
  )
    return localGitHost(env.LOCAL_GIT_HOST, env.LOCAL_GIT_SECRET!);
  return null;
}
