import { z } from 'zod';
import { accountSummarySchema, sessionInfoSchema } from '../../shared/ipc';
import { PULL_EVENTS } from '../../shared/pulls';
import {
  gitUrlSchema,
  remoteActivitySchema,
  remoteRepositorySchema,
} from '../../shared/repos';

export class ApiRequestError extends Error {
  constructor(
    readonly code: string,
    readonly status: number,
  ) {
    super(code);
  }
}

export class NetworkError extends Error {}

const tokenResponse = z.object({
  access_token: z.string(),
  expires_in: z.number().int().positive(),
  refresh_token: z.string(),
});
const exchangeResponse = tokenResponse.extend({
  account: accountSummarySchema,
});
const meResponse = z.object({ account: accountSummarySchema });
const sessionsResponse = z.object({ sessions: z.array(sessionInfoSchema) });
const errorBody = z.object({ error: z.object({ code: z.string() }) });
const overviewResponse = z.object({
  total: z.number().int().nonnegative(),
  recent: z.array(remoteRepositorySchema).max(20),
  // Older Workers don't send it; an empty list is the honest reading.
  recentActivity: z.array(remoteActivitySchema).max(20).default([]),
  // Older Workers don't say; null means unknown, not off.
  gitHosting: z.boolean().nullable().default(null),
  serverTime: z.number(),
});
// The token is opaque to gitdesk: bounded in size and free of anything that could end a header.
const syncEventResponse = z.object({
  event: z.object({
    result: z.enum(['confirmed', 'unverified', 'rejected', 'failed']),
    tip: z
      .string()
      .regex(/^[0-9a-f]{40,64}$/)
      .nullable(),
  }),
});
const credentialsResponse = z.object({
  remote: gitUrlSchema,
  token: z
    .string()
    .min(8)
    .max(512)
    .regex(/^[\x21-\x7e]+$/),
  scope: z.enum(['read', 'write']),
  expiresAt: z.number(),
});
const revokeResponse = z.object({ revoked: z.number().int().nonnegative() });

// Pull request records from the Worker, validated like any other server input. OIDs and paths are
// checked to their shapes so nothing odd reaches Git or the screen.
const oid = z.string().regex(/^[0-9a-f]{40,64}$/);
const text = (max: number) => z.string().max(max);
const author = z.object({
  accountId: z.string().min(1).max(64),
  name: text(200),
  avatarUrl: z.string().url().startsWith('https://').max(2048).nullable(),
});
const snapshot = z.object({
  version: z.number().int().min(1),
  sourceOid: oid,
  targetOid: oid,
  mergeBaseOid: oid.nullable(),
  mergeability: z.enum([
    'unknown',
    'mergeable',
    'conflicts',
    'needs_refresh',
    'unavailable',
  ]),
  reason: z
    .enum([
      'source-missing',
      'target-missing',
      'unrelated',
      'git-too-old',
      'failed',
    ])
    .nullable(),
  conflicts: z.array(text(4096)).max(200),
  checkedAt: z.number().nullable(),
});
export const accountPullSchema = z.object({
  id: z.uuid(),
  number: z.number().int().min(1),
  title: text(200),
  description: text(10_000),
  sourceRef: text(255),
  targetRef: text(255),
  status: z.enum(['open', 'closed', 'merged']),
  isDraft: z.boolean(),
  author,
  createdAt: z.number(),
  updatedAt: z.number(),
  closedAt: z.number().nullable(),
  mergedAt: z.number().nullable(),
  mergeCommitOid: oid.nullable(),
  latest: snapshot.nullable(),
  comments: z.number().int().nonnegative(),
  unresolved: z.number().int().nonnegative(),
  review: z
    .object({
      decision: z.enum(['approved', 'changes_requested', 'commented']),
      version: z.number().int(),
      stale: z.boolean(),
    })
    .nullable(),
});
const pullResponse = z.object({ pullRequest: accountPullSchema });
const counts = z.object({
  open: z.number().int(),
  merged: z.number().int(),
  closed: z.number().int(),
});
const pullListResponse = z.object({
  pullRequests: z.array(accountPullSchema).max(50),
  nextCursor: z.string().max(400).nullable(),
  counts,
});
const anchor = z.object({
  comparisonVersion: z.number().int().min(1),
  sourceOid: oid,
  targetOid: oid,
  path: text(4096),
  side: z.enum(['old', 'new']),
  oldLine: z.number().int().nullable(),
  newLine: z.number().int().nullable(),
  contextHash: z.string().regex(/^[0-9a-f]{40}$/),
});
const comment = z.object({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  author,
  body: text(10_000),
  createdAt: z.number(),
  updatedAt: z.number(),
  deleted: z.boolean(),
  resolved: z.boolean(),
  anchor: anchor.nullable(),
});
const review = z.object({
  id: z.uuid(),
  decision: z.enum(['approved', 'changes_requested', 'commented']),
  body: text(10_000),
  version: z.number().int().min(1),
  sourceOid: oid,
  targetOid: oid,
  author,
  submittedAt: z.number(),
});
const pullEvent = z.object({
  id: z.string().min(1).max(64),
  type: z.enum(PULL_EVENTS),
  actor: author,
  detail: text(300).nullable(),
  createdAt: z.number(),
});
const statsResponse = z.object({
  months: z
    .array(
      z.object({
        month: z.string().regex(/^\d{4}-\d{2}$/),
        opened: z.number().int(),
        merged: z.number().int(),
      }),
    )
    .max(13),
  counts,
  medianMergeMs: z.number().nullable(),
  merges: z.number().int(),
  openWithConflicts: z.number().int(),
});
export type AccountPull = z.infer<typeof accountPullSchema>;
const repositoryResponse = z.object({ repository: remoteRepositorySchema });
// 204 has no body; 202 carries the repository that is still being deleted.
const deleteResponse = repositoryResponse.nullable();
const activityResponse = z.object({
  activity: z.array(remoteActivitySchema).max(50),
});
const listResponse = z.object({
  repositories: z.array(remoteRepositorySchema).max(50),
  nextCursor: z.string().max(400).nullable(),
});

export type TokenResponse = z.infer<typeof tokenResponse>;
type Fetch = (url: string, init: RequestInit) => Promise<Response>;

export function createApiClient(origin: string, fetchImpl: Fetch) {
  async function request<T>(
    path: string,
    schema: z.ZodType<T> | null,
    init: {
      method?: string;
      body?: unknown;
      token?: string;
      headers?: Record<string, string>;
    } = {},
  ): Promise<T> {
    let res: Response;
    try {
      res = await fetchImpl(origin + path, {
        method: init.method ?? 'GET',
        headers: {
          accept: 'application/json',
          ...(init.body ? { 'content-type': 'application/json' } : {}),
          ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
          ...init.headers,
        },
        body: init.body ? JSON.stringify(init.body) : undefined,
        signal: AbortSignal.timeout(15_000),
      });
    } catch {
      throw new NetworkError();
    }
    const json: unknown =
      res.status === 204 ? null : await res.json().catch(() => null);
    if (!res.ok) {
      const parsed = errorBody.safeParse(json);
      throw new ApiRequestError(
        parsed.success ? parsed.data.error.code : 'UNKNOWN',
        res.status,
      );
    }
    // Responses are validated too: a compromised or misconfigured server is still untrusted input.
    return (schema ? schema.parse(json) : undefined) as T;
  }

  return {
    exchange: (body: {
      code: string;
      code_verifier: string;
      device_name: string;
    }) =>
      request('/api/v1/auth/desktop/exchange', exchangeResponse, {
        method: 'POST',
        body,
      }),
    refresh: (refreshToken: string) =>
      request('/api/v1/auth/refresh', tokenResponse, {
        method: 'POST',
        body: { refresh_token: refreshToken },
      }),
    logout: (refreshToken: string) =>
      request('/api/v1/auth/logout', null, {
        method: 'POST',
        body: { refresh_token: refreshToken },
      }),
    me: (token: string) => request('/api/v1/auth/me', meResponse, { token }),
    sessions: (token: string) =>
      request('/api/v1/auth/sessions', sessionsResponse, { token }),
    dashboardOverview: (token: string) =>
      request('/api/v1/dashboard/overview', overviewResponse, { token }),
    // The key makes a retry after a timeout return the repository the first attempt created.
    createRepository: (
      token: string,
      body: { name: string; description: string | null },
      idempotencyKey: string,
    ) =>
      request('/api/v1/repositories', repositoryResponse, {
        method: 'POST',
        body,
        token,
        headers: { 'idempotency-key': idempotencyKey },
      }),
    listRepositories: (
      token: string,
      query: { sort: 'updated' | 'name'; cursor: string | null },
    ) => {
      const params = new URLSearchParams({ sort: query.sort, limit: '20' });
      if (query.cursor) params.set('cursor', query.cursor);
      return request(`/api/v1/repositories?${params}`, listResponse, { token });
    },
    updateRepository: (
      token: string,
      id: string,
      body: { name?: string; description?: string | null },
    ) =>
      request(
        `/api/v1/repositories/${encodeURIComponent(id)}`,
        repositoryResponse,
        {
          method: 'PATCH',
          body,
          token,
        },
      ),
    getRepository: (token: string, id: string) =>
      request(
        `/api/v1/repositories/${encodeURIComponent(id)}`,
        repositoryResponse,
        { token },
      ),
    provisionRepository: (token: string, id: string) =>
      request(
        `/api/v1/repositories/${encodeURIComponent(id)}/provision`,
        repositoryResponse,
        { method: 'POST', token },
      ),
    repositoryActivity: (token: string, id: string) =>
      request(
        `/api/v1/repositories/${encodeURIComponent(id)}/activity?limit=20`,
        activityResponse,
        { token },
      ),
    deleteRepository: (token: string, id: string) =>
      request(
        `/api/v1/repositories/${encodeURIComponent(id)}`,
        deleteResponse,
        {
          method: 'DELETE',
          token,
        },
      ),
    gitCredentials: (
      token: string,
      id: string,
      body: { scope: 'read' | 'write'; lifetime: 900 | 3600 | 28_800 },
    ) =>
      request(
        `/api/v1/repositories/${encodeURIComponent(id)}/git-credentials`,
        credentialsResponse,
        { method: 'POST', body, token },
      ),
    // Tells the account about a push to its Git URL; the server checks Artifacts for the commit.
    reportSync: (
      token: string,
      id: string,
      body: {
        operationId: string;
        kind: 'push';
        ref: string;
        oldOid: string | null;
        newOid: string;
      },
    ) =>
      request(
        `/api/v1/repositories/${encodeURIComponent(id)}/sync-events`,
        syncEventResponse,
        { method: 'POST', body, token },
      ),
    revokeGitCredentials: (token: string, id: string) =>
      request(
        `/api/v1/repositories/${encodeURIComponent(id)}/git-credentials`,
        revokeResponse,
        { method: 'DELETE', token },
      ),
    listPullRequests: (
      token: string,
      repositoryId: string,
      query: { status: string; q: string; cursor: string | null },
    ) => {
      const params = new URLSearchParams({ status: query.status, limit: '25' });
      if (query.q) params.set('q', query.q);
      if (query.cursor) params.set('cursor', query.cursor);
      return request(
        `/api/v1/repositories/${encodeURIComponent(repositoryId)}/pull-requests?${params}`,
        pullListResponse,
        { token },
      );
    },
    pullRequestStats: (token: string, repositoryId: string, range: string) =>
      request(
        `/api/v1/repositories/${encodeURIComponent(repositoryId)}/pull-requests/stats?range=${encodeURIComponent(range)}`,
        statsResponse,
        { token },
      ),
    createPullRequest: (
      token: string,
      repositoryId: string,
      body: {
        title: string;
        description: string;
        sourceRef: string;
        targetRef: string;
        isDraft: boolean;
      },
      idempotencyKey: string,
    ) =>
      request(
        `/api/v1/repositories/${encodeURIComponent(repositoryId)}/pull-requests`,
        pullResponse,
        {
          method: 'POST',
          body,
          token,
          headers: { 'idempotency-key': idempotencyKey },
        },
      ),
    // One call shape for every pull request route: the path after /api/v1/pull-requests/:id.
    pullRequest: <T>(
      token: string,
      id: string,
      rest: string,
      schema:
        | 'pull'
        | 'comments'
        | 'comment'
        | 'reviews'
        | 'review'
        | 'activity'
        | 'none',
      init: { method?: string; body?: unknown } = {},
    ) =>
      request(
        `/api/v1/pull-requests/${encodeURIComponent(id)}${rest}`,
        (schema === 'pull'
          ? pullResponse
          : schema === 'comments'
            ? z.object({ comments: z.array(comment).max(1000) })
            : schema === 'comment'
              ? z.object({ comment })
              : schema === 'reviews'
                ? z.object({ reviews: z.array(review).max(100) })
                : schema === 'review'
                  ? z.object({ review })
                  : schema === 'activity'
                    ? z.object({
                        events: z.array(pullEvent).max(50),
                        nextCursor: z.string().max(400).nullable(),
                      })
                    : null) as z.ZodType<T> | null,
        { ...init, token },
      ),
    revokeSession: (token: string, id: string) =>
      request(`/api/v1/auth/sessions/${encodeURIComponent(id)}`, null, {
        method: 'DELETE',
        token,
      }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
