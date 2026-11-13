import {
  OAuthAuthorizationServer,
  OAuthError,
  type OAuthHelpers,
} from '@cloudflare/workers-oauth-provider';

// Everything an agent can be granted. A scope is listed only when a tool enforces it.
export const MCP_SCOPES = ['repo:read', 'pr:read', 'pr:write', 'offline_access'] as const;
export type McpScope = (typeof MCP_SCOPES)[number];
// No tool works without it, so the consent page never offers to leave it out.
export const REQUIRED_SCOPE: McpScope = 'repo:read';

export const SCOPE_TEXT: Record<McpScope, { label: string; detail: string }> = {
  'repo:read': {
    label: 'Read your repositories',
    detail: 'Names, branches, files, commits, pushes and activity of the repositories in your account.',
  },
  'pr:read': {
    label: 'Read pull requests',
    detail: 'Pull requests with their reviews, comments and history.',
  },
  'pr:write': {
    label: 'Change pull requests',
    detail: 'Comment, review, edit, close and reopen pull requests as you. It cannot merge or push.',
  },
  offline_access: {
    label: 'Stay connected',
    detail: 'Keep access without asking again, until 30 days pass without use or you revoke it.',
  },
};

// What a grant carries, encrypted by the library and handed to every MCP request.
export type McpProps = {
  accountId: string;
  // Random id shared by the grant's metadata and its usage and audit rows.
  grantKey: string;
  clientName: string;
  authorizedAt: number;
};

export type GrantMetadata = { grantKey: string; clientName: string; clientDomain: string | null; redirectHost: string };

const HOUR = 3600;
const DAY = 24 * HOUR;
export const ACCESS_TOKEN_TTL = HOUR;
export const GRANT_IDLE_TTL = 30 * DAY;
// However often it is refreshed, a grant ends here and the agent asks again.
export const GRANT_MAX_AGE = 90 * DAY;

export const publicOrigin = (env: Pick<CloudflareBindings, 'PUBLIC_ORIGIN'>) =>
  env.PUBLIC_ORIGIN.trim().replace(/\/+$/, '');
export const mcpResource = (env: Pick<CloudflareBindings, 'PUBLIC_ORIGIN'>) => `${publicOrigin(env)}/mcp`;

export const REGISTER_PATH = '/oauth/register';

// PUBLIC_ORIGIN is a secret, known only at request time, so the server is built on first use and
// kept for the isolate.
let built: { origin: string; server: OAuthAuthorizationServer<CloudflareBindings> } | null = null;

export function authorizationServer(env: CloudflareBindings): OAuthAuthorizationServer<CloudflareBindings> {
  const origin = publicOrigin(env);
  if (built?.origin === origin) return built.server;
  const server = new OAuthAuthorizationServer<CloudflareBindings>({
    issuer: origin,
    resources: [`${origin}/mcp`],
    scopesSupported: [...MCP_SCOPES],
    clientIdMetadataDocumentEnabled: true,
    // Older MCP clients register themselves; newer ones publish a metadata document instead.
    clientRegistrationEndpoint: REGISTER_PATH,
    accessTokenTTL: ACCESS_TOKEN_TTL,
    refreshTokenTTL: GRANT_IDLE_TTL,
    refreshTokenIdleTTL: GRANT_IDLE_TTL,
    tokenExchangeCallback: ({ grantType, props, scope }) => {
      // Without "Stay connected" the agent gets an access token and nothing to renew it with: the
      // grant ends with that token, an hour later.
      if (grantType === 'authorization_code') return scope.includes('offline_access') ? undefined : { refreshTokenTTL: 0 };
      if (grantType !== 'refresh_token') return;
      const left = (props as McpProps).authorizedAt / 1000 + GRANT_MAX_AGE - Date.now() / 1000;
      // invalid_grant also revokes the grant, so the agent starts a new authorization.
      if (left < 60) throw new OAuthError('invalid_grant', { description: 'This authorization has ended.' });
      return { refreshTokenIdleTTL: Math.floor(Math.min(GRANT_IDLE_TTL, left)) };
    },
  });
  built = { origin, server };
  return server;
}

export const oauthApi = (env: CloudflareBindings): OAuthHelpers => authorizationServer(env).getOAuthApi(env);
