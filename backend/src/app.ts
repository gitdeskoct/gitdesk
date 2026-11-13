import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { requestId } from 'hono/request-id';
import { secureHeaders } from 'hono/secure-headers';
import type { AppEnv } from './env';
import { ApiError } from './lib/errors';
import type { GitHost } from './lib/git-host';
import { notFound, onError } from './middleware/error-handler';
import type { GoogleProvider } from './modules/auth/google';
import { authRoutes } from './modules/auth/routes';
import { mcpAccountRoutes, mcpRoutes } from './modules/mcp/routes';
import { activityRoutes } from './modules/activity/routes';
import { pullRequestRoutes } from './modules/pull-requests/routes';
import { dashboardRoutes, repositoryRoutes } from './modules/repositories/routes';
import { syncRoutes } from './modules/sync/routes';

export type AppDeps = {
  google: GoogleProvider;
  // Production passes gitHostFor; tests leave it out (no hosting) or pass a fake.
  gitHost?: (env: CloudflareBindings) => GitHost | null;
};

export function createApp(deps: AppDeps) {
  const app = new Hono<AppEnv>();

  // An empty headerName ignores any client-sent X-Request-Id, so logs only carry ids we generated.
  app.use(requestId({ headerName: '' }));
  // Registered before secureHeaders so it runs after it: the few HTML pages (sign-in messages, the
  // MCP consent page) style themselves inline, which the API's default-src 'none' would block.
  app.use(async (c, next) => {
    await next();
    if (c.res.headers.get('content-type')?.startsWith('text/html'))
      c.header(
        'Content-Security-Policy',
        "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
      );
  });
  app.use(
    secureHeaders({
      contentSecurityPolicy: { defaultSrc: ["'none'"], frameAncestors: ["'none'"] },
      referrerPolicy: 'no-referrer',
      xFrameOptions: 'DENY',
    }),
  );
  // workers.dev also answers plain http. A token sent that way is already exposed, so the request
  // is refused rather than redirected; local development (wrangler dev, tests) stays on http.
  app.use(async (c, next) => {
    const { protocol, hostname } = new URL(c.req.url);
    if (protocol === 'http:' && hostname !== 'localhost' && hostname !== '127.0.0.1')
      throw new ApiError('HTTPS_REQUIRED', 'Use https.');
    await next();
  });
  app.use(async (c, next) => {
    await next();
    c.header('Cache-Control', 'no-store');
    c.header('X-Request-Id', c.get('requestId'));
  });
  // Pull request descriptions and comments run to 10,000 characters; everything else stays small.
  const tooLarge = () => {
    throw new ApiError('PAYLOAD_TOO_LARGE', 'The request body is too large.');
  };
  const smallBody = bodyLimit({ maxSize: 8 * 1024, onError: tooLarge });
  const pullBody = bodyLimit({ maxSize: 64 * 1024, onError: tooLarge });
  // An MCP call can carry a comment or a description, so /mcp gets the same room.
  app.use((c, next) =>
    c.req.path.includes('/pull-requests') || c.req.path === '/mcp' ? pullBody(c, next) : smallBody(c, next),
  );

  app.get('/health', (c) => c.json({ ok: true }));
  app.route('/api/v1/auth', authRoutes(deps.google));
  const gitHost = deps.gitHost ?? (() => null);
  app.route('/api/v1/dashboard', dashboardRoutes(gitHost));
  app.route('/api/v1/repositories', repositoryRoutes(gitHost));
  app.route('/api/v1/activity', activityRoutes());
  app.route('/api/v1/pull-requests', pullRequestRoutes());
  app.route('/api/v1/sync-events', syncRoutes());
  app.route('/api/v1/mcp', mcpAccountRoutes());
  // /mcp for agents, and the OAuth pages and endpoints that authorize them.
  app.route('/', mcpRoutes({ google: deps.google, gitHost }));

  app.onError(onError);
  app.notFound(notFound);
  return app;
}
