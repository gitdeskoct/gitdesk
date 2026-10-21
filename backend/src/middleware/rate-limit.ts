import type { Context, MiddlewareHandler } from 'hono';
import type { AppEnv } from '../env';
import { ApiError } from '../lib/errors';

type Limiter = 'AUTH_LIMITER' | 'REFRESH_LIMITER' | 'API_LIMITER';

export const clientIp = (c: Context<AppEnv>): string =>
  c.req.header('cf-connecting-ip') ?? 'unknown';

export const rateLimit =
  (
    limiter: Limiter,
    key: (c: Context<AppEnv>) => string,
  ): MiddlewareHandler<AppEnv> =>
  async (c, next) => {
    const { success } = await c.env[limiter].limit({ key: key(c) });
    if (!success) {
      throw new ApiError('RATE_LIMITED', 'Too many requests. Try again in a minute.');
    }
    await next();
  };
