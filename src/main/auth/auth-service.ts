import type {
  AccountSummary,
  AuthErrorCode,
  AuthStatus,
  SessionInfo,
} from '../../shared/ipc';
import {
  ApiRequestError,
  NetworkError,
  type ApiClient,
  type TokenResponse,
} from './api-client';
import type { CredentialStore } from './credential-store';
import {
  SignInCancelled,
  SignInTimedOut,
  startLoopback,
} from './loopback-server';
import { challengeFor, randomToken } from './pkce';

export type AccountCache = {
  get(): AccountSummary | null;
  set(account: AccountSummary): void;
  clear(): void;
};

export type AuthDeps = {
  api: ApiClient;
  store: CredentialStore;
  cache: AccountCache;
  openExternal(url: string): Promise<void>;
  focusApp(): void;
  startUrl(params: { challenge: string; state: string; port: number }): string;
  deviceName: string;
  emit(status: AuthStatus): void;
  loopbackTimeoutMs?: number;
  now?: () => number;
};

const REFRESH_MARGIN_MS = 30_000;
const OFFLINE_RETRY_MS = 15_000;

function errorCode(err: unknown): AuthErrorCode {
  if (err instanceof SignInTimedOut) return 'timed_out';
  if (err instanceof NetworkError) return 'unreachable';
  if (err instanceof ApiRequestError) {
    if (err.code === 'RATE_LIMITED') return 'rate_limited';
    if (err.code === 'INVALID_GRANT') return 'invalid_grant';
    if (err.code === 'AUTH_PROVIDER_ERROR') return 'provider_error';
  }
  return 'unknown';
}

const isSessionGone = (err: unknown): err is ApiRequestError =>
  err instanceof ApiRequestError && err.status === 401;

// The access token lives only in this object's memory; the renderer only ever sees AuthStatus.
export class AuthService {
  private status: AuthStatus = { status: 'signed-out' };
  private access: { token: string; expiresAt: number } | null = null;
  private refreshing: Promise<string> | null = null;
  private signInAbort: AbortController | null = null;
  private startUrl: string | null = null;
  private lastRestore = 0;
  private readonly now: () => number;

  constructor(private readonly deps: AuthDeps) {
    this.now = deps.now ?? Date.now;
  }

  getStatus(): AuthStatus {
    if (
      this.status.status === 'offline' &&
      this.now() - this.lastRestore > OFFLINE_RETRY_MS
    ) {
      void this.restore();
    }
    return this.status;
  }

  async restore(): Promise<AuthStatus> {
    this.lastRestore = this.now();
    if (!(await this.deps.store.load()))
      return this.set({ status: 'signed-out' });
    try {
      const { account } = await this.deps.api.me(await this.accessToken(true));
      this.deps.cache.set(account);
      return this.set({
        status: 'authenticated',
        account,
        persistence: await this.deps.store.persistence(),
      });
    } catch (err) {
      if (isSessionGone(err)) return this.dropSession(err);
      return this.set({ status: 'offline', account: this.deps.cache.get() });
    }
  }

  async signIn(): Promise<AuthStatus> {
    this.signInAbort?.abort();
    const abort = new AbortController();
    this.signInAbort = abort;
    const verifier = randomToken();
    const state = randomToken();
    try {
      const loopback = await startLoopback({
        state,
        signal: abort.signal,
        timeoutMs: this.deps.loopbackTimeoutMs,
      });
      this.startUrl = this.deps.startUrl({
        challenge: challengeFor(verifier),
        state,
        port: loopback.port,
      });
      this.set({ status: 'authenticating' });
      await this.deps.openExternal(this.startUrl);

      const result = await loopback.result;
      this.deps.focusApp();
      if (result.kind === 'error') {
        return this.set({
          status: 'signed-out',
          error:
            result.error === 'access_denied'
              ? 'cancelled_in_browser'
              : 'provider_error',
        });
      }
      const tokens = await this.deps.api.exchange({
        code: result.code,
        code_verifier: verifier,
        device_name: this.deps.deviceName,
      });
      await this.acceptTokens(tokens);
      this.deps.cache.set(tokens.account);
      return this.set({
        status: 'authenticated',
        account: tokens.account,
        persistence: await this.deps.store.persistence(),
      });
    } catch (err) {
      if (err instanceof SignInCancelled) {
        // A newer signIn() aborted this one; that call owns the status now.
        return abort === this.signInAbort
          ? this.set({ status: 'signed-out' })
          : this.status;
      }
      return this.set({ status: 'signed-out', error: errorCode(err) });
    } finally {
      if (this.signInAbort === abort) {
        this.signInAbort = null;
        this.startUrl = null;
      }
    }
  }

  cancelSignIn(): void {
    this.signInAbort?.abort();
  }

  async reopenBrowser(): Promise<void> {
    if (this.status.status === 'authenticating' && this.startUrl) {
      await this.deps.openExternal(this.startUrl);
    }
  }

  // Local sign-out always succeeds; remote revocation is best effort and reported if unconfirmed.
  async signOut(): Promise<AuthStatus> {
    const refreshToken = await this.deps.store.load();
    await this.clearLocal();
    if (!refreshToken) return this.set({ status: 'signed-out' });
    try {
      await this.deps.api.logout(refreshToken);
      return this.set({ status: 'signed-out' });
    } catch {
      return this.set({
        status: 'signed-out',
        notice: 'remote_signout_unconfirmed',
      });
    }
  }

  async listSessions(): Promise<SessionInfo[]> {
    return (await this.authorized((token) => this.deps.api.sessions(token)))
      .sessions;
  }

  async revokeSession(id: string): Promise<void> {
    await this.authorized((token) => this.deps.api.revokeSession(token, id));
  }

  // Runs one authenticated API call, refreshing once on expiry. Other main-process services use
  // this so the access token never leaves AuthService.
  async authorized<T>(call: (token: string) => Promise<T>): Promise<T> {
    try {
      try {
        return await call(await this.accessToken());
      } catch (err) {
        if (!(err instanceof ApiRequestError && err.code === 'SESSION_EXPIRED'))
          throw err;
        return await call(await this.accessToken(true));
      }
    } catch (err) {
      if (isSessionGone(err)) await this.dropSession(err);
      throw err;
    }
  }

  private async accessToken(force = false): Promise<string> {
    if (
      !force &&
      this.access &&
      this.access.expiresAt - REFRESH_MARGIN_MS > this.now()
    ) {
      return this.access.token;
    }
    // Single flight: rotation invalidates the old refresh token, so two parallel refreshes
    // would look like token reuse to the server and revoke the session.
    this.refreshing ??= (async () => {
      const refreshToken = await this.deps.store.load();
      if (!refreshToken) throw new ApiRequestError('SESSION_EXPIRED', 401);
      await this.acceptTokens(await this.deps.api.refresh(refreshToken));
      return this.access!.token;
    })().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  private async acceptTokens(tokens: TokenResponse): Promise<void> {
    await this.deps.store.save(tokens.refresh_token);
    this.access = {
      token: tokens.access_token,
      expiresAt: this.now() + tokens.expires_in * 1000,
    };
  }

  private async clearLocal(): Promise<void> {
    this.access = null;
    await this.deps.store.clear();
    this.deps.cache.clear();
  }

  private async dropSession(err: ApiRequestError): Promise<AuthStatus> {
    await this.clearLocal();
    return this.set({
      status: 'signed-out',
      notice:
        err.code === 'SESSION_REVOKED' ? 'session_revoked' : 'session_expired',
    });
  }

  private set(status: AuthStatus): AuthStatus {
    this.status = status;
    this.deps.emit(status);
    return status;
  }
}
