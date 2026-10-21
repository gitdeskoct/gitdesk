import type { AuthStatus } from '../../shared/ipc';
import type { RemoteOverview, RemoteRepository } from '../../shared/repos';
import type { Settings } from '../../shared/settings';
import { ApiRequestError, NetworkError, type ApiClient } from '../auth/api-client';
import type { AuthService } from '../auth/auth-service';
import { readState, writeState, type AppDatabase } from '../db/database';
import { UserError } from '../errors';
import type { RepositoryStore } from '../repos/repository-store';

// The account runs on Cloudflare's free plan (100,000 Worker requests and 5M D1 row reads a day,
// shared by everything). These gaps keep one desktop far below that: an automatic refresh at most
// every 10 minutes, a manual one at most every 30 seconds, a failed one retried after 2 minutes,
// and never two requests in flight. Local Git checks never touch the network.
export const AUTO_GAP_MS = 10 * 60_000;
export const MANUAL_GAP_MS = 30_000;
export const RETRY_GAP_MS = 2 * 60_000;

type CachedOverview = { accountId: string; total: number; fetchedAt: number };
type Usage = { day: string; count: number };

const accountIdOf = (status: AuthStatus): string | null =>
  (status.status === 'authenticated' || status.status === 'offline') &&
  status.account
    ? status.account.id
    : null;

export function createRemoteService(deps: {
  db: AppDatabase;
  api: ApiClient;
  auth: Pick<AuthService, 'getStatus' | 'authorized'>;
  store: RepositoryStore;
  settings: () => Settings;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  let lastAttempt = 0;
  let lastError: RemoteOverview['error'] = null;
  let liveAt: number | null = null;
  let inflight: Promise<void> | null = null;

  const usage = (): Usage => {
    const day = new Date(now()).toISOString().slice(0, 10);
    const stored = readState(deps.db, 'remote_usage') as Usage | undefined;
    return stored?.day === day ? stored : { day, count: 0 };
  };
  const countRequest = () => {
    const current = usage();
    writeState(deps.db, 'remote_usage', { ...current, count: current.count + 1 });
  };

  const cachedFor = (accountId: string): CachedOverview | null => {
    const stored = readState(deps.db, 'remote_overview') as
      | CachedOverview
      | undefined;
    return stored?.accountId === accountId ? stored : null;
  };

  async function call<T>(fn: (token: string) => Promise<T>): Promise<T> {
    lastAttempt = now();
    countRequest();
    return deps.auth.authorized(fn);
  }

  const errorOf = (err: unknown): RemoteOverview['error'] =>
    err instanceof NetworkError
      ? 'offline'
      : err instanceof ApiRequestError && err.status === 429
        ? 'rate-limited'
        : 'failed';

  async function fetchOverview(accountId: string): Promise<void> {
    try {
      const result = await call((token) => deps.api.dashboardOverview(token));
      const fetchedAt = now();
      deps.store.replaceRemote(accountId, result.recent, fetchedAt);
      writeState(deps.db, 'remote_overview', {
        accountId,
        total: result.total,
        fetchedAt,
      } satisfies CachedOverview);
      liveAt = fetchedAt;
      lastError = null;
    } catch (err) {
      lastError = errorOf(err);
      // The last good data stays on screen, but it is no longer described as current.
      liveAt = null;
    }
  }

  function snapshot(status: AuthStatus): RemoteOverview {
    const accountId = accountIdOf(status);
    const base = {
      requestsToday: usage().count,
      nextRefreshAt: lastAttempt ? lastAttempt + MANUAL_GAP_MS : null,
    };
    if (!accountId)
      return {
        ...base,
        state: 'signed-out',
        total: null,
        recent: [],
        fetchedAt: null,
        error: null,
      };
    const cached = cachedFor(accountId);
    if (!cached)
      return {
        ...base,
        state: 'never',
        total: null,
        recent: [],
        fetchedAt: null,
        error: status.status === 'offline' ? 'offline' : lastError,
      };
    return {
      ...base,
      state: liveAt === cached.fetchedAt ? 'live' : 'cached',
      total: cached.total,
      recent: deps.store.readRemote(accountId).slice(0, 5),
      fetchedAt: cached.fetchedAt,
      error: status.status === 'offline' ? 'offline' : lastError,
    };
  }

  return {
    async overview(force: boolean): Promise<RemoteOverview> {
      const status = deps.auth.getStatus();
      const accountId = accountIdOf(status);
      if (accountId && status.status === 'authenticated') {
        const cached = cachedFor(accountId);
        const sinceAttempt = now() - lastAttempt;
        const due = force
          ? sinceAttempt >= MANUAL_GAP_MS
          : deps.settings().remoteRefresh === 'auto' &&
            sinceAttempt >= (lastError ? RETRY_GAP_MS : MANUAL_GAP_MS) &&
            (!cached || now() - cached.fetchedAt >= AUTO_GAP_MS);
        if (due) {
          inflight ??= fetchOverview(accountId).finally(() => {
            inflight = null;
          });
        }
        if (inflight) await inflight;
      }
      return snapshot(deps.auth.getStatus());
    },

    // Creates remote metadata only. The local repository is never touched from here.
    async create(input: {
      name: string;
      description: string | null;
    }): Promise<RemoteRepository> {
      const status = deps.auth.getStatus();
      const accountId = accountIdOf(status);
      if (!accountId || status.status !== 'authenticated')
        throw new UserError('Sign in and connect to create a remote repository.');
      try {
        const { repository } = await call((token) =>
          deps.api.createRepository(token, input),
        );
        // Update the cache from the server's own response instead of refetching the overview.
        const cached = cachedFor(accountId);
        const fetchedAt = cached?.fetchedAt ?? now();
        deps.store.replaceRemote(
          accountId,
          [repository, ...deps.store.readRemote(accountId)],
          fetchedAt,
        );
        writeState(deps.db, 'remote_overview', {
          accountId,
          total: (cached?.total ?? 0) + 1,
          fetchedAt,
        } satisfies CachedOverview);
        return repository;
      } catch (err) {
        if (err instanceof ApiRequestError && err.code === 'NAME_TAKEN')
          throw new UserError('A remote repository with that name already exists.');
        if (err instanceof ApiRequestError && err.status === 429)
          throw new UserError('Too many requests. Try again in a minute.');
        if (err instanceof NetworkError)
          throw new UserError("Can't reach the gitdesk server.");
        throw new UserError("The server couldn't create the remote repository.");
      }
    },

    // Signing out removes the cached remote names: they belong to the account, not the computer.
    handleAuth(status: AuthStatus): void {
      if (status.status === 'signed-out') {
        deps.store.clearRemote();
        writeState(deps.db, 'remote_overview', null);
        liveAt = null;
        lastError = null;
      }
    },
  };
}

export type RemoteService = ReturnType<typeof createRemoteService>;
