import { z } from 'zod';
import { accountSummarySchema, sessionInfoSchema } from '../../shared/ipc';
import {
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
  serverTime: z.number(),
});
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
    revokeSession: (token: string, id: string) =>
      request(`/api/v1/auth/sessions/${encodeURIComponent(id)}`, null, {
        method: 'DELETE',
        token,
      }),
  };
}

export type ApiClient = ReturnType<typeof createApiClient>;
