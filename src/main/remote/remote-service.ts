import type { AuthStatus } from '../../shared/ipc';
import type {
  RemoteActivity,
  RemoteDeleteResult,
  RemoteListInput,
  RemoteOverview,
  RemotePage,
  RemoteRepository,
  RemoteUpdateInput,
} from '../../shared/repos';
import type { Settings } from '../../shared/settings';
import {
  ApiRequestError,
  NetworkError,
  type ApiClient,
} from '../auth/api-client';
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
type CachedActivity = { accountId: string; items: RemoteActivity[] };
type Usage = { day: string; count: number };

const accountIdOf = (status: AuthStatus): string | null =>
  (status.status === 'authenticated' || status.status === 'offline') &&
  status.account
    ? status.account.id
    : null;

// Server codes become sentences; anything unexpected gets the caller's fallback.
function userError(err: unknown, fallback: string): UserError {
  if (err instanceof UserError) return err;
  if (err instanceof NetworkError)
    return new UserError("Can't reach the gitdesk server.");
  if (err instanceof ApiRequestError) {
    if (err.code === 'NAME_TAKEN')
      return new UserError(
        'A remote repository with that name already exists.',
      );
    if (err.code === 'LIMIT_REACHED')
      return new UserError(
        'Your account has reached its limit of remote repositories.',
      );
    if (err.code === 'NOT_FOUND')
      return new UserError('That remote repository no longer exists.');
    if (err.code === 'INVALID_STATE')
      return new UserError(
        'That remote repository is being deleted, so it takes no changes.',
      );
    if (err.status === 429)
      return new UserError('Too many requests. Try again in a minute.');
  }
  return new UserError(fallback);
}

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
  // Bumped on sign-out: a response that started before it must not write the old account's data back.
  let epoch = 0;

  const usage = (): Usage => {
    const day = new Date(now()).toISOString().slice(0, 10);
    const stored = readState(deps.db, 'remote_usage') as Usage | undefined;
    return stored?.day === day ? stored : { day, count: 0 };
  };
  const countRequest = () => {
    const current = usage();
    writeState(deps.db, 'remote_usage', {
      ...current,
      count: current.count + 1,
    });
  };

  const cachedFor = (accountId: string): CachedOverview | null => {
    const stored = readState(deps.db, 'remote_overview') as
      | CachedOverview
      | undefined;
    return stored?.accountId === accountId ? stored : null;
  };
  const activityFor = (accountId: string): RemoteActivity[] => {
    const stored = readState(deps.db, 'remote_activity') as
      | CachedActivity
      | undefined;
    return stored?.accountId === accountId ? stored.items : [];
  };

  async function call<T>(fn: (token: string) => Promise<T>): Promise<T> {
    lastAttempt = now();
    countRequest();
    return deps.auth.authorized(fn);
  }

  // Remote calls need a signed-in, connected account and an app that isn't set to local-only.
  function signedInAccount(): string {
    if (deps.settings().localOnly)
      throw new UserError(
        'gitdesk is set to work without an account. Turn that off in Settings › General.',
      );
    const status = deps.auth.getStatus();
    const accountId = accountIdOf(status);
    if (!accountId || status.status !== 'authenticated')
      throw new UserError(
        'Sign in and connect to use your remote repositories.',
      );
    return accountId;
  }

  const errorOf = (err: unknown): RemoteOverview['error'] =>
    err instanceof NetworkError
      ? 'offline'
      : err instanceof ApiRequestError && err.status === 429
        ? 'rate-limited'
        : 'failed';

  async function fetchOverview(accountId: string): Promise<void> {
    const started = epoch;
    try {
      const result = await call((token) => deps.api.dashboardOverview(token));
      if (started !== epoch) return;
      const fetchedAt = now();
      deps.store.replaceRemote(accountId, result.recent, fetchedAt);
      writeState(deps.db, 'remote_overview', {
        accountId,
        total: result.total,
        fetchedAt,
      } satisfies CachedOverview);
      writeState(deps.db, 'remote_activity', {
        accountId,
        items: result.recentActivity,
      } satisfies CachedActivity);
      liveAt = fetchedAt;
      lastError = null;
    } catch (err) {
      if (started !== epoch) return;
      lastError = errorOf(err);
      // The last good data stays on screen, but it is no longer described as current.
      liveAt = null;
    }
  }

  function snapshot(status: AuthStatus): RemoteOverview {
    const accountId = deps.settings().localOnly ? null : accountIdOf(status);
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
        activity: [],
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
        activity: [],
        fetchedAt: null,
        error: status.status === 'offline' ? 'offline' : lastError,
      };
    return {
      ...base,
      state: liveAt === cached.fetchedAt ? 'live' : 'cached',
      total: cached.total,
      recent: deps.store.readRemote(accountId).slice(0, 5),
      activity: activityFor(accountId),
      fetchedAt: cached.fetchedAt,
      error: status.status === 'offline' ? 'offline' : lastError,
    };
  }

  // Keeps the cached list in step with a confirmed server change, without inventing a fetch time.
  function patchCache(
    accountId: string,
    change: (list: RemoteRepository[]) => RemoteRepository[],
    totalDelta: number,
  ): void {
    const cached = cachedFor(accountId);
    if (!cached) return;
    deps.store.replaceRemote(
      accountId,
      change(deps.store.readRemote(accountId)),
      cached.fetchedAt,
    );
    writeState(deps.db, 'remote_overview', {
      ...cached,
      total: Math.max(0, cached.total + totalDelta),
    } satisfies CachedOverview);
  }

  return {
    async overview(force: boolean): Promise<RemoteOverview> {
      const status = deps.auth.getStatus();
      const accountId = accountIdOf(status);
      if (
        accountId &&
        status.status === 'authenticated' &&
        !deps.settings().localOnly
      ) {
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

    // Creates remote metadata only. The local repository is never touched from here. The same
    // key on a retry returns the repository a timed-out first attempt already created.
    async create(
      input: { name: string; description: string | null },
      idempotencyKey: string,
    ): Promise<RemoteRepository> {
      const accountId = signedInAccount();
      try {
        const { repository } = await call((token) =>
          deps.api.createRepository(token, input, idempotencyKey),
        );
        patchCache(
          accountId,
          (list) => [repository, ...list.filter((r) => r.id !== repository.id)],
          deps.store.readRemote(accountId).some((r) => r.id === repository.id)
            ? 0
            : 1,
        );
        return repository;
      } catch (err) {
        throw userError(
          err,
          "The server couldn't create the remote repository.",
        );
      }
    },

    // One page straight from the server; the list is never served from cache as if it were current.
    async list(input: RemoteListInput): Promise<RemotePage> {
      signedInAccount();
      try {
        return await call((token) => deps.api.listRepositories(token, input));
      } catch (err) {
        throw userError(err, "Couldn't load your remote repositories.");
      }
    },

    async update(input: RemoteUpdateInput): Promise<RemoteRepository> {
      const accountId = signedInAccount();
      const { id, ...body } = input;
      try {
        const { repository } = await call((token) =>
          deps.api.updateRepository(token, id, body),
        );
        patchCache(
          accountId,
          (list) => list.map((r) => (r.id === id ? repository : r)),
          0,
        );
        return repository;
      } catch (err) {
        throw userError(err, "The server couldn't save those details.");
      }
    },

    async get(id: string): Promise<RemoteRepository> {
      const accountId = signedInAccount();
      try {
        const { repository } = await call((token) =>
          deps.api.getRepository(token, id),
        );
        patchCache(
          accountId,
          (list) => list.map((r) => (r.id === id ? repository : r)),
          0,
        );
        return repository;
      } catch (err) {
        throw userError(err, "Couldn't load that remote repository.");
      }
    },

    async provision(id: string): Promise<RemoteRepository> {
      const accountId = signedInAccount();
      try {
        const { repository } = await call((token) =>
          deps.api.provisionRepository(token, id),
        );
        patchCache(
          accountId,
          (list) => list.map((r) => (r.id === id ? repository : r)),
          0,
        );
        return repository;
      } catch (err) {
        throw userError(err, "The server couldn't set up storage.");
      }
    },

    async activity(id: string): Promise<RemoteActivity[]> {
      signedInAccount();
      try {
        return (await call((token) => deps.api.repositoryActivity(token, id)))
          .activity;
      } catch (err) {
        throw userError(err, "Couldn't load this repository's activity.");
      }
    },

    // Deletes the remote only. The caller unlinks local registrations; folders stay untouched.
    async remove(id: string): Promise<RemoteDeleteResult> {
      const accountId = signedInAccount();
      let result;
      try {
        result = await call((token) => deps.api.deleteRepository(token, id));
      } catch (err) {
        throw userError(
          err,
          "The server couldn't delete the remote repository.",
        );
      }
      if (result) {
        const { repository } = result;
        patchCache(
          accountId,
          (list) => list.map((r) => (r.id === id ? repository : r)),
          0,
        );
        return { status: 'incomplete', repository };
      }
      patchCache(accountId, (list) => list.filter((r) => r.id !== id), -1);
      return { status: 'deleted' };
    },

    // Signing out removes the cached remote names: they belong to the account, not the computer.
    handleAuth(status: AuthStatus): void {
      if (status.status === 'signed-out') {
        epoch++;
        deps.store.clearRemote();
        writeState(deps.db, 'remote_overview', null);
        writeState(deps.db, 'remote_activity', null);
        liveAt = null;
        lastError = null;
      }
    },
  };
}

export type RemoteService = ReturnType<typeof createRemoteService>;
