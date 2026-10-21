import type { MiddlewareHandler } from 'hono';
import { errors } from 'jose';
import { getDb } from '../db/client';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';
import { getActiveSession } from '../modules/auth/sessions';
import { verifyAccessToken } from '../modules/auth/tokens';

export const requireAuth: MiddlewareHandler<AppEnv> = async (c, next) => {
  const header = c.req.header('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token) throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');

  let auth;
  try {
    auth = await verifyAccessToken(c.env, token);
  } catch (err) {
    if (err instanceof errors.JWTExpired) {
      throw new ApiError('SESSION_EXPIRED', 'Your session expired.');
    }
    throw new ApiError('AUTH_REQUIRED', 'Sign in to continue.');
  }

  // The JWT alone can't express revocation, so the session row is the source of truth.
  const session = await getActiveSession(getDb(c.env.DB), auth.sessionId, Date.now());
  if (!session || session.accountId !== auth.accountId) {
    throw new ApiError('SESSION_REVOKED', 'This session was signed out.');
  }

  const { success } = await c.env.API_LIMITER.limit({ key: auth.accountId });
  if (!success) {
    throw new ApiError('RATE_LIMITED', 'Too many requests. Try again in a minute.');
  }

  c.set('auth', auth);
  await next();
};
