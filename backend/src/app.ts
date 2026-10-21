import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './env';
import { ApiError } from './lib/errors';
import { notFound, onError } from './middleware/error-handler';
import type { GoogleProvider } from './modules/auth/google';
import { authRoutes } from './modules/auth/routes';
import { dashboardRoutes, repositoryRoutes } from './modules/repositories/routes';

export type AppDeps = { google: GoogleProvider };

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  app.use(requestId());
  app.use(
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      referrerPolicy: 'no-referrer',
    }),
  );
  app.use(async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
  });
  app.use(
    bodyLimit({
      maxSize: 8 * 1024,
      onError: () => {
        throw new ApiError('VALIDATION_FAILED', 'The request body is too large.');
      },
    }),
  );

  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/api/v1/auth', authRoutes(deps.google));
  app.route('/api/v1/dashboard', dashboardRoutes());
  app.route('/api/v1/repositories', repositoryRoutes());

  app.onError(onError);
  app.notFound(notFound);
  return app;
}
