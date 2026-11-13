import {
  AuthorizationError,
  CimdFetchError,
  OAuthResourceServer,
  authorizationErrorRedirect,
  insufficientScope,
} from '@cloudflare/workers-oauth-provider';
import { createMcpHandler } from 'agents/mcp/server';
import { Hono, type Context } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db/client';
import type { AppEnv } from '../../env';
import { randomToken, sha256 } from '../../lib/crypto';
import { cursor } from '../../lib/cursor';
import { ApiError } from '../../lib/errors';
import type { GitHost } from '../../lib/git-host';
import { logEvent } from '../../lib/log';
import { clientIp, rateLimit } from '../../middleware/rate-limit';
import { requireAuth } from '../../middleware/require-auth';
import { validate } from '../../middleware/validate';
import { findByIdentity, getAccount } from '../auth/accounts';
import { buildAuthorizeUrl, type GoogleProvider } from '../auth/google';
import { listAudit, listGrants, revokeGrant, touchGrant } from './grants';
import {
  MCP_SCOPES,
  REGISTER_PATH,
  REQUIRED_SCOPE,
  authorizationServer,
  mcpResource,
  oauthApi,
  publicOrigin,
  type GrantMetadata,
  type McpProps,
  type McpScope,
} from './oauth';
import { consentPage, noticePage } from './pages';
import { buildServer } from './tools';

export const GOOGLE_CALLBACK_PATH = '/oauth/google/callback';

type Deps = { google: GoogleProvider; gitHost: (env: CloudflareBindings) => GitHost | null };

// Tests call the app without an execution context; deferred work then just runs.
function executionContext(c: Context<AppEnv>): ExecutionContext {
  try {
    return c.executionCtx as ExecutionContext;
  } catch {
    return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  }
}

const html = (body: string, status = 200, headers = new Headers()) => {
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(body, { status, headers });
};

const startAgain = (message: string) =>
  html(noticePage("This page can't be used any more", `${message} Go back to the app you were connecting and start again.`), 400);

// Which failures go back to the client and which stay on this page: only a request whose client
// and exact redirect URI were validated may be redirected.
function authorizeFailure(c: Context<AppEnv>, error: unknown): Response {
  if (error instanceof AuthorizationError && error.redirectTo) return c.redirect(error.redirectTo, 302);
  if (error instanceof AuthorizationError) return startAgain(error.description);
  if (error instanceof CimdFetchError) {
    logEvent('mcp_client_metadata_failed', { requestId: c.get('requestId'), code: error.reason }, 'warn');
    return html(noticePage("This app couldn't be verified", 'gitdesk could not read the app’s published details, so nothing was shared.'), 400);
  }
  throw error;
}

const isScope = (scope: string): scope is McpScope => (MCP_SCOPES as readonly string[]).includes(scope);

// What the consent page offers for a client's request. A client that names no scopes is offered
// every one; the person still chooses.
export function offeredScopes(requested: readonly string[]): McpScope[] {
  const asked = new Set(requested.filter(isScope));
  if (asked.has('pr:write')) asked.add('pr:read');
  return MCP_SCOPES.filter((scope) => scope === REQUIRED_SCOPE || !asked.size || asked.has(scope));
}

// What a consent form grants: the ticked scopes the page offered, always the required one, and
// pr:read with pr:write, since every pull request change answers with the pull request itself.
export function grantedScopes(offered: readonly McpScope[], ticked: readonly string[]): McpScope[] {
  const chosen = new Set<McpScope>([REQUIRED_SCOPE]);
  for (const scope of ticked) if (isScope(scope) && offered.includes(scope)) chosen.add(scope);
  if (chosen.has('pr:write')) chosen.add('pr:read');
  return MCP_SCOPES.filter((scope) => chosen.has(scope));
}

export function mcpRoutes(deps: Deps) {
  const app = new Hono<AppEnv>();
  const byIp = (limiter: 'AUTH_LIMITER' | 'REFRESH_LIMITER') =>
    rateLimit(limiter, (c) => `${c.req.path}:${clientIp(c)}`);

  // One resource server per origin; the handler closes over nothing request-specific.
  let resource: { origin: string; server: OAuthResourceServer<CloudflareBindings, McpProps> } | null = null;
  function resourceServer(env: CloudflareBindings) {
    const origin = publicOrigin(env);
    if (resource?.origin === origin) return resource.server;
    const server = new OAuthResourceServer<CloudflareBindings, McpProps>({
      resourceMetadata: {
        resource: mcpResource(env),
        authorization_servers: [origin],
        resource_name: 'gitdesk',
      },
      // Advertised so clients ask for it first; enforced in the handler below.
      requiredScopes: [REQUIRED_SCOPE],
      validateToken: (bindings) => (target, token) => authorizationServer(bindings).validateToken<McpProps>(target, token, bindings),
      handler: {
        async fetch(request, bindings, ctx) {
          if (!ctx.auth.scope.includes(REQUIRED_SCOPE)) return insufficientScope(ctx.auth, [REQUIRED_SCOPE]);
          const props = ctx.props;
          const db = getDb(bindings.DB);
          const requestId = crypto.randomUUID();
          const { success } = await bindings.MCP_LIMITER.limit({ key: props.grantKey });
          if (!success) {
            // Logged, not audited: a runaway agent must not turn its refusals into D1 writes.
            logEvent('mcp_rate_limited', { requestId, accountId: props.accountId }, 'warn');
            return Response.json(
              { error: { code: 'RATE_LIMITED', message: 'Too many requests. Try again in a minute.' } },
              { status: 429, headers: { 'Retry-After': '60' } },
            );
          }
          // A grant outlives nothing: once the account is gone its tokens open no door.
          if (!(await getAccount(db, props.accountId))) return new Response(null, { status: 401 });
          ctx.waitUntil(touchGrant(db, props, Date.now()).catch(() => undefined));
          const handler = createMcpHandler(
            () =>
              buildServer({
                env: bindings,
                db,
                git: deps.gitHost(bindings),
                props,
                scopes: new Set(ctx.auth.scope),
                requestId,
                defer: (work) => ctx.waitUntil(work),
              }),
            { route: '/mcp', allowedHostnames: [new URL(origin).hostname] },
          );
          return handler(request, bindings, ctx);
        },
      },
    });
    resource = { origin, server };
    return server;
  }

  // Counted per address before any token is looked up, so made-up tokens cost no KV reads.
  const mcpByIp = rateLimit('MCP_IP_LIMITER', (c) => `mcp:${clientIp(c)}`);
  const protectedResource = (c: Context<AppEnv>) => resourceServer(c.env).fetch(c.req.raw, c.env, executionContext(c));
  app.all('/mcp', mcpByIp, protectedResource);
  app.get('/.well-known/oauth-protected-resource/*', mcpByIp, protectedResource);
  app.get('/.well-known/oauth-protected-resource', mcpByIp, protectedResource);

  const authServer = (c: Context<AppEnv>) => authorizationServer(c.env).fetch(c.req.raw, c.env, executionContext(c));
  app.get('/.well-known/oauth-authorization-server', mcpByIp, authServer);
  app.all('/oauth/token', byIp('REFRESH_LIMITER'), authServer);
  // Anyone can register a client: 10 registrations a minute per address.
  app.all(REGISTER_PATH, byIp('AUTH_LIMITER'), authServer);

  app.get('/authorize', byIp('AUTH_LIMITER'), async (c) => {
    const oauth = oauthApi(c.env);
    try {
      const request = await oauth.parseAuthRequest(c.req.raw);
      const details = await oauth.describeConsent(request);
      const offered = offeredScopes(request.scope);
      const consent = await oauth.beginConsent(request);
      return html(consentPage(details, offered, consent.handle), 200, consent.headers);
    } catch (error) {
      return authorizeFailure(c, error);
    }
  });

  app.post('/authorize', byIp('AUTH_LIMITER'), async (c) => {
    const oauth = oauthApi(c.env);
    try {
      const form = await c.req.raw.formData();
      const handle = String(form.get('handle') ?? '');
      if (form.get('decision') !== 'approve') {
        const denied = await oauth.denyConsent(c.req.raw, handle);
        return new Response(null, { status: 302, headers: denied.headers });
      }
      const consent = await oauth.approveConsent(c.req.raw, handle);
      // Only what the page offered for this client counts; a hand-edited form adds nothing.
      const scope = grantedScopes(offeredScopes(consent.request.scope), form.getAll('scope').map(String));
      // Narrowed, never widened: the validated request with fewer scopes.
      const approved = { ...consent.request, scope };
      // Only now, after this person said yes to this client, does Google hear about it.
      const verifier = randomToken();
      const nonce = randomToken();
      const upstream = await oauth.beginUpstream(approved, { data: { verifier, nonce }, headers: consent.headers });
      upstream.headers.set(
        'Location',
        buildAuthorizeUrl({
          clientId: c.env.GOOGLE_CLIENT_ID,
          redirectUri: publicOrigin(c.env) + GOOGLE_CALLBACK_PATH,
          state: upstream.state,
          nonce,
          codeChallenge: await sha256(verifier),
        }),
      );
      return new Response(null, { status: 302, headers: upstream.headers });
    } catch (error) {
      return authorizeFailure(c, error);
    }
  });

  app.get(GOOGLE_CALLBACK_PATH, byIp('AUTH_LIMITER'), async (c) => {
    const oauth = oauthApi(c.env);
    let resumed;
    try {
      resumed = await oauth.finishUpstream<{ verifier: string; nonce: string }>(c.req.raw);
    } catch (error) {
      return authorizeFailure(c, error);
    }
    const { request: original, data, headers } = resumed;
    const back = (location: string) => {
      headers.set('Location', location);
      return new Response(null, { status: 302, headers });
    };
    const code = c.req.query('code');
    if (c.req.query('error') || !code) return back(authorizationErrorRedirect(original, 'access_denied'));

    const db = getDb(c.env.DB);
    let account;
    try {
      const idToken = await deps.google.exchangeCode({
        code,
        codeVerifier: data.verifier,
        redirectUri: publicOrigin(c.env) + GOOGLE_CALLBACK_PATH,
        clientId: c.env.GOOGLE_CLIENT_ID,
        clientSecret: c.env.GOOGLE_CLIENT_SECRET,
      });
      const profile = await deps.google.verifyIdToken(idToken, { clientId: c.env.GOOGLE_CLIENT_ID, nonce: data.nonce });
      account = await findByIdentity(db, 'google', profile.subject);
    } catch (err) {
      logEvent(
        'mcp_sign_in_failed',
        { requestId: c.get('requestId'), code: err instanceof ApiError ? err.code : 'INTERNAL' },
        'warn',
      );
      return back(authorizationErrorRedirect(original, 'server_error'));
    }
    // An agent connects to an account that exists; it never creates one. The agent hears why, so it
    // stops waiting and can tell the person.
    if (!account) {
      logEvent('mcp_sign_in_no_account', { requestId: c.get('requestId') }, 'warn');
      return back(
        authorizationErrorRedirect(
          original,
          'access_denied',
          'No gitdesk account uses this Google account. Sign in to the gitdesk desktop app with it first.',
        ),
      );
    }

    let details;
    try {
      details = await oauth.describeConsent(original);
    } catch (err) {
      logEvent('mcp_client_metadata_failed', { requestId: c.get('requestId'), code: err instanceof CimdFetchError ? err.reason : 'INTERNAL' }, 'warn');
      return back(authorizationErrorRedirect(original, 'server_error', 'The app could not be verified. Try connecting again.'));
    }
    const grantKey = crypto.randomUUID();
    const clientName = details.clientName.slice(0, 200);
    const props: McpProps = { accountId: account.id, grantKey, clientName, authorizedAt: Date.now() };
    const metadata: GrantMetadata = {
      grantKey,
      clientName,
      clientDomain: details.clientDomain ?? null,
      redirectHost: details.redirectHost,
    };
    const { redirectTo } = await oauth.completeAuthorization({
      request: original,
      userId: account.id,
      metadata,
      scope: original.scope.filter(isScope),
      props,
    });
    logEvent('mcp_grant_created', { requestId: c.get('requestId'), accountId: account.id });
    return back(redirectTo);
  });

  return app;
}

const auditQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: cursor(z.tuple([z.number().int().nonnegative(), z.uuid()])).optional(),
});
// Grant ids are the library's: "<user>:<random>" shaped, so only their length and characters are checked.
const grantParams = z.object({ grantId: z.string().min(1).max(300).regex(/^[A-Za-z0-9._:~-]+$/) });

// Under /api/v1/mcp: what Settings › MCP shows. Desktop session tokens only; an MCP token is
// issued for /mcp and is refused here like any other unknown bearer.
export function mcpAccountRoutes() {
  const app = new Hono<AppEnv>();
  app.use(requireAuth);

  app.get('/status', (c) =>
    c.json({ endpoint: mcpResource(c.env), scopes: MCP_SCOPES.filter((scope) => scope !== 'offline_access') }),
  );

  app.get('/grants', async (c) =>
    c.json(await listGrants(getDb(c.env.DB), oauthApi(c.env), c.get('auth').accountId)),
  );

  app.post(
    '/grants/:grantId/revoke',
    rateLimit('WRITE_LIMITER', (c) => c.get('auth').accountId),
    validate('param', grantParams),
    async (c) => {
      const { accountId } = c.get('auth');
      if (!(await revokeGrant(getDb(c.env.DB), oauthApi(c.env), accountId, c.req.valid('param').grantId)))
        throw new ApiError('NOT_FOUND', 'Not found.');
      logEvent('mcp_grant_revoked', { requestId: c.get('requestId'), accountId });
      return c.body(null, 204);
    },
  );

  app.get('/audit', validate('query', auditQuery), async (c) =>
    c.json(await listAudit(getDb(c.env.DB), c.get('auth').accountId, c.req.valid('query'))),
  );

  return app;
}
