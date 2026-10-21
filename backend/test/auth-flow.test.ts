import { describe, expect, it, vi } from 'vitest';
import { createApp } from '../src/app';
import { randomToken } from '../src/lib/crypto';
import { browserSignIn, call, fakeGoogle, postJson, signIn } from './helpers';

const bearer = (token: string) => ({ headers: { authorization: `Bearer ${token}` } });

describe('Google sign-in through the desktop handoff', () => {
  it('signs in, refreshes, detects reuse and signs out', async () => {
    const google = await fakeGoogle();
    const app = createApp({ google: google.provider });
    const ip = '198.51.100.10';

    const { start, authorize, callback, loopback, desktopState } = await browserSignIn(app, google, ip);
    expect(start.status).toBe(302);
    expect(authorize.origin + authorize.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(authorize.searchParams.get('code_challenge_method')).toBe('S256');
    expect(authorize.searchParams.get('redirect_uri')).toBe(
      'http://localhost:8787/api/v1/auth/google/callback',
    );
    expect(callback.status).toBe(302);
    expect(loopback.origin).toBe('http://127.0.0.1:51515');
    expect(loopback.searchParams.get('state')).toBe(desktopState);
    expect(loopback.searchParams.get('code')).toMatch(/^[A-Za-z0-9_-]{43}$/);

    const session = await signIn(app, google, '198.51.100.11');
    expect(session.account.email).toBe('person@example.com');

    const me = await call(app, '/api/v1/auth/me', bearer(session.access_token));
    expect(me.status).toBe(200);
    expect(me.headers.get('cache-control')).toBe('no-store');

    const refreshed = await postJson(app, '/api/v1/auth/refresh', { refresh_token: session.refresh_token });
    expect(refreshed.status).toBe(200);
    const next = (await refreshed.json()) as { access_token: string; refresh_token: string };
    expect(next.refresh_token).not.toBe(session.refresh_token);

    // Replaying the rotated-out token revokes the whole session.
    const replay = await postJson(app, '/api/v1/auth/refresh', { refresh_token: session.refresh_token });
    expect(replay.status).toBe(401);
    expect(await replay.json()).toMatchObject({ error: { code: 'SESSION_REVOKED' } });
    const afterReuse = await call(app, '/api/v1/auth/me', bearer(next.access_token));
    expect(afterReuse.status).toBe(401);

    const fresh = await signIn(app, google, '198.51.100.12');
    const logout = await postJson(app, '/api/v1/auth/logout', { refresh_token: fresh.refresh_token });
    expect(logout.status).toBe(204);
    const afterLogout = await call(app, '/api/v1/auth/me', bearer(fresh.access_token));
    expect(await afterLogout.json()).toMatchObject({ error: { code: 'SESSION_REVOKED' } });
  });

  it('reuses the account for the same Google subject', async () => {
    const google = await fakeGoogle();
    const app = createApp({ google: google.provider });
    const a = await signIn(app, google, '198.51.100.20');
    google.state.claims = { ...google.state.claims, email: 'changed@example.com' };
    const b = await signIn(app, google, '198.51.100.21');
    expect(b.account.id).toBe(a.account.id);
    expect(b.account.email).toBe('changed@example.com');
  });

  it('rejects a wrong verifier and burns the code', async () => {
    const google = await fakeGoogle();
    const app = createApp({ google: google.provider });
    const { loopback, verifier } = await browserSignIn(app, google, '198.51.100.30');
    const code = loopback.searchParams.get('code');
    const wrong = await postJson(app, '/api/v1/auth/desktop/exchange', {
      code,
      code_verifier: randomToken(),
      device_name: 'x',
    });
    expect(wrong.status).toBe(400);
    const retry = await postJson(app, '/api/v1/auth/desktop/exchange', {
      code,
      code_verifier: verifier,
      device_name: 'x',
    });
    expect(await retry.json()).toMatchObject({ error: { code: 'INVALID_GRANT' } });
  });

  it('lets exactly one of two concurrent exchanges succeed', async () => {
    const google = await fakeGoogle();
    const app = createApp({ google: google.provider });
    const { loopback, verifier } = await browserSignIn(app, google, '198.51.100.40');
    const body = { code: loopback.searchParams.get('code'), code_verifier: verifier, device_name: 'x' };
    const results = await Promise.all([
      postJson(app, '/api/v1/auth/desktop/exchange', body, '198.51.100.41'),
      postJson(app, '/api/v1/auth/desktop/exchange', body, '198.51.100.42'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 400]);
  });

  it('lets exactly one of two concurrent refreshes succeed', async () => {
    const google = await fakeGoogle();
    const app = createApp({ google: google.provider });
    const { refresh_token } = await signIn(app, google, '198.51.100.50');
    const results = await Promise.all([
      postJson(app, '/api/v1/auth/refresh', { refresh_token }, '198.51.100.51'),
      postJson(app, '/api/v1/auth/refresh', { refresh_token }, '198.51.100.52'),
    ]);
    expect(results.map((r) => r.status).sort()).toEqual([200, 401]);
  });

  it('rejects an unknown or replayed Google state', async () => {
    const google = await fakeGoogle();
    const app = createApp({ google: google.provider });
    const unknown = await call(
      app,
      `/api/v1/auth/google/callback?state=${randomToken()}&code=abc`,
      {},
      '198.51.100.60',
    );
    expect(unknown.status).toBe(400);
    expect(unknown.headers.get('content-security-policy')).toContain("default-src 'none'");

    const { authorize } = await browserSignIn(app, google, '198.51.100.61');
    const replay = await call(
      app,
      `/api/v1/auth/google/callback?state=${authorize.searchParams.get('state')}&code=abc`,
      {},
      '198.51.100.61',
    );
    expect(replay.status).toBe(400);
  });

  it('sends the user back with access_denied when they cancel at Google', async () => {
    const google = await fakeGoogle();
    const app = createApp({ google: google.provider });
    const start = await call(
      app,
      `/api/v1/auth/google/start?challenge=${randomToken()}&state=${randomToken()}&port=50000`,
      {},
      '198.51.100.70',
    );
    const state = new URL(start.headers.get('location') ?? '').searchParams.get('state');
    const res = await call(app, `/api/v1/auth/google/callback?state=${state}&error=access_denied`, {}, '198.51.100.70');
    expect(new URL(res.headers.get('location') ?? '').searchParams.get('error')).toBe('access_denied');
  });

  it('rejects malformed start parameters instead of redirecting anywhere', async () => {
    const app = createApp({ google: (await fakeGoogle()).provider });
    const bad = await call(
      app,
      `/api/v1/auth/google/start?challenge=short&state=${randomToken()}&port=80`,
      {},
      '198.51.100.80',
    );
    expect(bad.status).toBe(400);
    expect(bad.headers.get('location')).toBeNull();
  });

  it('never logs tokens, codes or verifiers', async () => {
    const lines: string[] = [];
    const capture = (...args: unknown[]) => void lines.push(args.map(String).join(' '));
    const spies = (['log', 'warn', 'error'] as const).map((m) =>
      vi.spyOn(console, m).mockImplementation(capture),
    );
    const google = await fakeGoogle();
    const app = createApp({ google: google.provider });
    const { loopback, verifier } = await browserSignIn(app, google, '198.51.100.90');
    const code = loopback.searchParams.get('code') ?? '';
    const res = await postJson(
      app,
      '/api/v1/auth/desktop/exchange',
      { code, code_verifier: verifier, device_name: 'x' },
      '198.51.100.90',
    );
    const { access_token, refresh_token } = (await res.json()) as Record<string, string>;
    await postJson(app, '/api/v1/auth/refresh', { refresh_token }, '198.51.100.90');
    spies.forEach((s) => s.mockRestore());

    const all = lines.join('\n');
    expect(lines.length).toBeGreaterThan(0);
    for (const secret of [code, verifier, access_token, refresh_token]) {
      expect(all).not.toContain(secret);
    }
  });
});

describe('session management', () => {
  it('lists own sessions and cannot revoke another account’s session', async () => {
    const google = await fakeGoogle();
    const app = createApp({ google: google.provider });
    google.state.claims = { ...google.state.claims, sub: 'google-subject-mine' };
    const mine = await signIn(app, google, '198.51.100.100');
    google.state.claims = { ...google.state.claims, sub: 'google-subject-other', email: 'other@example.com' };
    const theirs = await signIn(app, google, '198.51.100.101');

    const list = await call(app, '/api/v1/auth/sessions', bearer(mine.access_token));
    const { sessions } = (await list.json()) as { sessions: { id: string; current: boolean }[] };
    expect(sessions).toHaveLength(1);
    expect(sessions[0]?.current).toBe(true);

    const theirList = await call(app, '/api/v1/auth/sessions', bearer(theirs.access_token));
    const theirId = ((await theirList.json()) as { sessions: { id: string }[] }).sessions[0]?.id;
    const attack = await call(app, `/api/v1/auth/sessions/${theirId}`, {
      method: 'DELETE',
      ...bearer(mine.access_token),
    });
    expect(attack.status).toBe(404);
    const stillThere = await call(app, '/api/v1/auth/me', bearer(theirs.access_token));
    expect(stillThere.status).toBe(200);
  });

  it('requires a bearer token', async () => {
    const app = createApp({ google: (await fakeGoogle()).provider });
    const res = await call(app, '/api/v1/auth/me');
    expect(await res.json()).toMatchObject({ error: { code: 'AUTH_REQUIRED' } });
  });
});

describe('rate limiting', () => {
  it('returns 429 after the auth limit is exhausted', async () => {
    const app = createApp({ google: (await fakeGoogle()).provider });
    const statuses: number[] = [];
    for (let i = 0; i < 12; i++) {
      const res = await call(
        app,
        `/api/v1/auth/google/start?challenge=${randomToken()}&state=${randomToken()}&port=50000`,
        {},
        '192.0.2.250',
      );
      statuses.push(res.status);
    }
    expect(statuses).toContain(429);
  });
});
