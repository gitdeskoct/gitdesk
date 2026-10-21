import { randomBytes } from 'node:crypto';
import { describe, expect, it, vi } from 'vitest';
import type { AccountSummary, AuthStatus, SessionInfo } from '../../shared/ipc';
import {
  ApiRequestError,
  NetworkError,
  type ApiClient,
  type TokenResponse,
} from './api-client';
import { AuthService, type AccountCache, type AuthDeps } from './auth-service';
import type { CredentialStore } from './credential-store';

const account: AccountSummary = {
  id: 'acc_1',
  displayName: 'Ada',
  email: 'ada@example.test',
  avatarUrl: null,
};

const tokens = (n: number): TokenResponse => ({
  access_token: `access-${n}`,
  expires_in: 3600,
  refresh_token: `refresh-${n}`,
});

// The loopback server only accepts a 43-character base64url code.
const authCode = () => randomBytes(32).toString('base64url');

function fakeStore(initial: string | null = null) {
  let token = initial;
  const store = {
    load: vi.fn(async () => token),
    save: vi.fn(async (t: string) => {
      token = t;
    }),
    clear: vi.fn(async () => {
      token = null;
    }),
    persistence: vi.fn(async () => 'secure' as const),
  };
  return Object.assign(store, { current: () => token });
}

function fakeApi() {
  return {
    exchange: vi.fn(async () => ({ ...tokens(1), account })),
    refresh: vi.fn(async () => tokens(2)),
    logout: vi.fn(async () => undefined),
    me: vi.fn(async () => ({ account })),
    sessions: vi.fn(
      async (): Promise<{ sessions: SessionInfo[] }> => ({ sessions: [] }),
    ),
    revokeSession: vi.fn(async () => undefined),
  };
}

function fakeCache(initial: AccountSummary | null = null) {
  let value = initial;
  return {
    get: vi.fn(() => value),
    set: vi.fn((a: AccountSummary) => {
      value = a;
    }),
    clear: vi.fn(() => {
      value = null;
    }),
  } satisfies AccountCache;
}

type Browser = (
  callback: (query: Record<string, string>) => Promise<Response>,
  state: string,
) => Promise<void>;

function setup(
  opts: {
    store?: string | null;
    cache?: AccountSummary | null;
    browser?: Browser;
    loopbackTimeoutMs?: number;
  } = {},
) {
  const api = fakeApi();
  const store = fakeStore(opts.store ?? null);
  const cache = fakeCache(opts.cache ?? null);
  const emitted: AuthStatus[] = [];
  const openExternal = vi.fn(async (url: string) => {
    // Play the browser: read the loopback port and state from the start URL, then hit the callback.
    const start = new URL(url);
    const port = start.searchParams.get('port')!;
    const state = start.searchParams.get('state')!;
    const callback = (query: Record<string, string>) =>
      fetch(`http://127.0.0.1:${port}/callback?${new URLSearchParams(query)}`);
    await opts.browser?.(callback, state);
  });
  const deps: AuthDeps = {
    api: api as unknown as ApiClient,
    store: store as unknown as CredentialStore,
    cache,
    openExternal,
    focusApp: vi.fn(),
    startUrl: ({ challenge, state, port }) =>
      `https://gitdesk.example.test/auth/desktop/start?${new URLSearchParams({ challenge, state, port: String(port) })}`,
    deviceName: 'test-device',
    emit: (s) => emitted.push(s),
    loopbackTimeoutMs: opts.loopbackTimeoutMs,
  };
  return {
    service: new AuthService(deps),
    api,
    store,
    cache,
    emitted,
    openExternal,
  };
}

describe('AuthService.signIn', () => {
  it('exchanges the code, stores the refresh token and emits authenticated', async () => {
    const code = authCode();
    let callbackStatus = 0;
    const { service, api, store, cache, emitted } = setup({
      browser: async (callback, state) => {
        callbackStatus = (await callback({ code, state })).status;
      },
    });

    const result = await service.signIn();

    expect(callbackStatus).toBe(200);
    expect(api.exchange).toHaveBeenCalledWith(
      expect.objectContaining({ code, device_name: 'test-device' }),
    );
    expect(store.save).toHaveBeenCalledWith('refresh-1');
    expect(store.current()).toBe('refresh-1');
    expect(cache.set).toHaveBeenCalledWith(account);
    expect(result).toEqual({
      status: 'authenticated',
      account,
      persistence: 'secure',
    });
    expect(emitted).toEqual([{ status: 'authenticating' }, result]);
  });

  it('reports cancelled_in_browser when the provider returns access_denied', async () => {
    const { service, api, store } = setup({
      browser: async (callback, state) => {
        await callback({ error: 'access_denied', state });
      },
    });

    expect(await service.signIn()).toEqual({
      status: 'signed-out',
      error: 'cancelled_in_browser',
    });
    expect(api.exchange).not.toHaveBeenCalled();
    expect(store.save).not.toHaveBeenCalled();
  });

  it('answers a wrong state with 400 and keeps waiting for the real callback', async () => {
    const code = authCode();
    const statuses: number[] = [];
    let statusAfterBadCallback: AuthStatus | undefined;
    const { service, api } = setup({
      browser: async (callback, state) => {
        statuses.push(
          (await callback({ code, state: 'not-the-state' })).status,
        );
        // Let any wrongly settled flow run before checking it did not complete.
        await new Promise((r) => setTimeout(r, 20));
        statusAfterBadCallback = service.getStatus();
        expect(api.exchange).not.toHaveBeenCalled();
        statuses.push((await callback({ code, state })).status);
      },
    });

    const result = await service.signIn();

    expect(statuses).toEqual([400, 200]);
    expect(statusAfterBadCallback).toEqual({ status: 'authenticating' });
    expect(api.exchange).toHaveBeenCalledOnce();
    expect(result.status).toBe('authenticated');
  });

  it('times out when no callback arrives', async () => {
    const { service, api } = setup({ loopbackTimeoutMs: 50 });

    expect(await service.signIn()).toEqual({
      status: 'signed-out',
      error: 'timed_out',
    });
    expect(api.exchange).not.toHaveBeenCalled();
  });
});

describe('AuthService.restore', () => {
  it('drops a revoked session and reports session_revoked', async () => {
    const { service, api, store, cache, emitted } = setup({
      store: 'refresh-0',
      cache: account,
    });
    api.me.mockRejectedValueOnce(new ApiRequestError('SESSION_REVOKED', 401));

    const result = await service.restore();

    expect(result).toEqual({ status: 'signed-out', notice: 'session_revoked' });
    expect(emitted.at(-1)).toEqual(result);
    expect(store.clear).toHaveBeenCalled();
    expect(store.current()).toBeNull();
    expect(cache.clear).toHaveBeenCalled();
  });

  it('goes offline with the cached account on a network error', async () => {
    const { service, api, store } = setup({
      store: 'refresh-0',
      cache: account,
    });
    api.me.mockRejectedValueOnce(new NetworkError());

    expect(await service.restore()).toEqual({ status: 'offline', account });
    expect(store.clear).not.toHaveBeenCalled();
    expect(store.current()).toBe('refresh-2');
  });

  it('stays signed out with no stored token', async () => {
    const { service, api } = setup();

    expect(await service.restore()).toEqual({ status: 'signed-out' });
    expect(api.refresh).not.toHaveBeenCalled();
  });
});

describe('AuthService.signOut', () => {
  it('clears local state and reports remote_signout_unconfirmed when logout fails', async () => {
    const { service, api, store, cache } = setup({
      store: 'refresh-0',
      cache: account,
    });
    api.logout.mockRejectedValueOnce(new NetworkError());

    const result = await service.signOut();

    expect(result).toEqual({
      status: 'signed-out',
      notice: 'remote_signout_unconfirmed',
    });
    expect(api.logout).toHaveBeenCalledWith('refresh-0');
    expect(store.clear).toHaveBeenCalled();
    expect(store.current()).toBeNull();
    expect(cache.clear).toHaveBeenCalled();
  });
});

describe('AuthService.listSessions', () => {
  it('refreshes once for parallel calls without an access token', async () => {
    const { service, api } = setup({ store: 'refresh-0' });
    api.refresh.mockImplementation(async () => {
      await new Promise((r) => setTimeout(r, 10));
      return tokens(2);
    });

    await Promise.all([service.listSessions(), service.listSessions()]);

    expect(api.refresh).toHaveBeenCalledOnce();
    expect(api.refresh).toHaveBeenCalledWith('refresh-0');
    expect(api.sessions).toHaveBeenCalledTimes(2);
    expect(api.sessions).toHaveBeenNthCalledWith(1, 'access-2');
    expect(api.sessions).toHaveBeenNthCalledWith(2, 'access-2');
  });
});
