import { Hono } from 'hono';
import { getDb } from '../../db/client';
import type { AppEnv } from '../../env';
import { randomToken, safeEqual, sha256 } from '../../lib/crypto';
import { ApiError } from '../../lib/errors';
import { logEvent } from '../../lib/log';
import { clientIp, rateLimit } from '../../middleware/rate-limit';
import { requireAuth } from '../../middleware/require-auth';
import { validate } from '../../middleware/validate';
import { getAccount, toSummary, upsertGoogleAccount } from './accounts';
import { buildAuthorizeUrl, type GoogleProvider } from './google';
import { messagePage } from './pages';
import {
  callbackQuery,
  exchangeBody,
  refreshBody,
  sessionParams,
  startQuery,
} from './schemas';
import {
  createSession,
  listActiveSessions,
  revokeByRefreshToken,
  revokeOwnedSession,
  rotateRefreshToken,
} from './sessions';
import { ACCESS_TOKEN_TTL_SECONDS, signAccessToken } from './tokens';
import {
  consumeDesktopCode,
  consumeOAuthTransaction,
  createDesktopCode,
  createOAuthTransaction,
} from './transactions';

const callbackPath = '/api/v1/auth/google/callback';

// The desktop redirect is always this exact loopback shape; clients never supply a redirect URI.
const desktopRedirect = (port: number, params: Record<string, string>) =>
  `http://127.0.0.1:${port}/callback?${new URLSearchParams(params)}`;

const authLimit = rateLimit('AUTH_LIMITER', (c) => `${c.req.path}:${clientIp(c)}`);

export function authRoutes(google: GoogleProvider) {
  const app = new Hono<AppEnv>();

  app.get('/google/start', authLimit, validate('query', startQuery), async (c) => {
    const { challenge, state, port } = c.req.valid('query');
    const googleState = randomToken();
    const nonce = randomToken();
    const googleVerifier = randomToken();
    await createOAuthTransaction(
      getDb(c.env.DB),
      {
        stateHash: await sha256(googleState),
        nonce,
        googleCodeVerifier: googleVerifier,
        desktopChallenge: challenge,
        desktopState: state,
        redirectPort: port,
      },
      Date.now(),
    );
    return c.redirect(
      buildAuthorizeUrl({
        clientId: c.env.GOOGLE_CLIENT_ID,
        redirectUri: c.env.PUBLIC_ORIGIN + callbackPath,
        state: googleState,
        nonce,
        codeChallenge: await sha256(googleVerifier),
      }),
      302,
    );
  });

  app.get('/google/callback', authLimit, validate('query', callbackQuery), async (c) => {
    const { state, code, error } = c.req.valid('query');
    const expired = () =>
      messagePage(
        c,
        400,
        'This sign-in link has expired',
        'Return to gitdesk and choose Continue with Google again.',
      );
    if (!state) return expired();

    const db = getDb(c.env.DB);
    const now = Date.now();
    const tx = await consumeOAuthTransaction(db, await sha256(state), now);
    if (!tx) return expired();

    const back = (params: Record<string, string>) =>
      c.redirect(desktopRedirect(tx.redirectPort, { ...params, state: tx.desktopState }), 302);

    if (error || !code) {
      return back({ error: error === 'access_denied' ? 'access_denied' : 'provider_error' });
    }

    try {
      const idToken = await google.exchangeCode({
        code,
        codeVerifier: tx.googleCodeVerifier,
        redirectUri: c.env.PUBLIC_ORIGIN + callbackPath,
        clientId: c.env.GOOGLE_CLIENT_ID,
        clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      });
      const profile = await google.verifyIdToken(idToken, {
        clientId: c.env.GOOGLE_CLIENT_ID,
        nonce: tx.nonce,
      });
      const account = await upsertGoogleAccount(db, profile, now);
      const desktopCode = await createDesktopCode(
        db,
        { accountId: account.id, desktopChallenge: tx.desktopChallenge },
        now,
      );
      logEvent('sign_in_callback', { requestId: c.get('requestId'), accountId: account.id });
      return back({ code: desktopCode });
    } catch (err) {
      logEvent(
        'sign_in_callback_failed',
        {
          requestId: c.get('requestId'),
          code: err instanceof ApiError ? err.code : 'INTERNAL',
        },
        'warn',
      );
      return back({ error: 'provider_error' });
    }
  });

  app.post('/desktop/exchange', authLimit, validate('json', exchangeBody), async (c) => {
    const body = c.req.valid('json');
    const db = getDb(c.env.DB);
    const now = Date.now();
    const grant = await consumeDesktopCode(db, body.code, now);
    // The code is burned even when the verifier is wrong, so a stolen code can't be retried.
    if (!grant || !(await safeEqual(await sha256(body.code_verifier), grant.desktopChallenge))) {
      logEvent('desktop_exchange_rejected', { requestId: c.get('requestId') }, 'warn');
      throw new ApiError('INVALID_GRANT', 'This sign-in attempt is no longer valid.');
    }
    const account = await getAccount(db, grant.accountId);
    if (!account) throw new ApiError('INVALID_GRANT', 'This sign-in attempt is no longer valid.');

    const { sessionId, refreshToken } = await createSession(
      db,
      { accountId: account.id, deviceName: body.device_name },
      now,
    );
    logEvent('session_created', { requestId: c.get('requestId'), accountId: account.id, sessionId });
    return c.json({
      access_token: await signAccessToken(c.env, { accountId: account.id, sessionId }),
      token_type: 'Bearer',
      expires_in: ACCESS_TOKEN_TTL_SECONDS,
      refresh_token: refreshToken,
      account: toSummary(account),
    });
  });

  app.post(
    '/refresh',
    rateLimit('REFRESH_LIMITER', (c) => clientIp(c)),
    validate('json', refreshBody),
    async (c) => {
      const result = await rotateRefreshToken(
        getDb(c.env.DB),
        c.req.valid('json').refresh_token,
        Date.now(),
      );
      if (result.status === 'reused') {
        logEvent(
          'refresh_reuse_detected',
          { requestId: c.get('requestId'), accountId: result.accountId, sessionId: result.sessionId },
          'warn',
        );
        throw new ApiError('SESSION_REVOKED', 'This session was signed out for your safety.');
      }
      if (result.status === 'invalid') {
        throw new ApiError('SESSION_EXPIRED', 'Your session expired.');
      }
      return c.json({
        access_token: await signAccessToken(c.env, result),
        token_type: 'Bearer',
        expires_in: ACCESS_TOKEN_TTL_SECONDS,
        refresh_token: result.refreshToken,
      });
    },
  );

  app.post(
    '/logout',
    rateLimit('REFRESH_LIMITER', (c) => clientIp(c)),
    validate('json', refreshBody),
    async (c) => {
      const revoked = await revokeByRefreshToken(
        getDb(c.env.DB),
        c.req.valid('json').refresh_token,
        Date.now(),
      );
      if (revoked) {
        logEvent('session_revoked', {
          requestId: c.get('requestId'),
          accountId: revoked.accountId,
          sessionId: revoked.id,
        });
      }
      // Same answer either way, so the endpoint can't be used to probe tokens.
      return c.body(null, 204);
    },
  );

  app.get('/me', requireAuth, async (c) => {
    const account = await getAccount(getDb(c.env.DB), c.get('auth').accountId);
    if (!account) throw new ApiError('SESSION_REVOKED', 'This session was signed out.');
    return c.json({ account: toSummary(account) });
  });

  app.get('/sessions', requireAuth, async (c) => {
    const { accountId, sessionId } = c.get('auth');
    const rows = await listActiveSessions(getDb(c.env.DB), accountId, Date.now());
    return c.json({
      sessions: rows.map((s) => ({ ...s, current: s.id === sessionId })),
    });
  });

  app.delete('/sessions/:id', requireAuth, validate('param', sessionParams), async (c) => {
    const { accountId } = c.get('auth');
    const { id } = c.req.valid('param');
    // Scoped to the caller's account: someone else's session id looks exactly like a missing one.
    if (!(await revokeOwnedSession(getDb(c.env.DB), accountId, id, Date.now()))) {
      throw new ApiError('NOT_FOUND', 'Session not found.');
    }
    logEvent('session_revoked', { requestId: c.get('requestId'), accountId, sessionId: id });
    return c.body(null, 204);
  });

  return app;
}
