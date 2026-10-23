import { Hono, type Context } from 'hono';
import { getDb } from '../../db/client';
import type { AppEnv } from '../../env';
import { ApiError } from '../../lib/errors';
import type { GitHost } from '../../lib/git-host';
import { logEvent } from '../../lib/log';
import { rateLimit } from '../../middleware/rate-limit';
import { requireAuth } from '../../middleware/require-auth';
import { validate } from '../../middleware/validate';
import { listPage as activityPage } from '../activity/activity';
import { repositoryPullRoutes } from '../pull-requests/routes';
import { repositorySyncRoutes } from '../sync/routes';
import { activityQuery } from '../activity/routes';
import {
  createRepository,
  deleteRepository,
  getOwned,
  gitCredentials,
  listPage,
  overview,
  provisionRepository,
  revokeGitCredentials,
  updateRepository,
  type Storage,
} from './repositories';
import {
  createBody,
  createHeaders,
  gitCredentialsBody,
  listQuery,
  repositoryParams,
  updateBody,
} from './schemas';

// Writes spend the free plan's daily D1 row writes, so they get a tighter limit than reads.
const writeLimit = rateLimit('WRITE_LIMITER', (c) => c.get('auth').accountId);
// Every fetch and push asks for a token, so tokens get their own budget instead of spending writes.
const gitLimit = rateLimit('GIT_LIMITER', (c) => c.get('auth').accountId);

const DELETING = 'This repository is being deleted.';
const NO_HOSTING = 'Git hosting is not set up on this server.';

type GitHostFor = (env: CloudflareBindings) => GitHost | null;

// A git host failure is the host's, not the client's: report it as such and keep the detail in logs.
async function viaGitHost<T>(c: Context<AppEnv>, work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch (err) {
    if (err instanceof ApiError) throw err;
    // Artifacts errors carry a code (MEMORY_LIMIT, UPSTREAM_UNAVAILABLE…) worth grouping by.
    const code =
      typeof err === 'object' && err !== null && 'code' in err && typeof err.code === 'string'
        ? err.code
        : undefined;
    const fields = { requestId: c.get('requestId'), code, error: String(err) };
    logEvent('git_host_error', fields, 'error');
    throw new ApiError('GIT_HOST_ERROR', 'The Git host did not answer. Try again in a moment.');
  }
}

export function repositoryRoutes(gitHost: GitHostFor) {
  const app = new Hono<AppEnv>();
  app.use(requireAuth);
  const storage = (c: Context<AppEnv>): Storage => ({
    bucket: c.env.REPO_STORAGE,
    git: gitHost(c.env),
  });

  app.get('/', validate('query', listQuery), async (c) => {
    const { accountId } = c.get('auth');
    return c.json(await listPage(getDb(c.env.DB), accountId, c.req.valid('query')));
  });

  app.get('/:id', validate('param', repositoryParams), async (c) => {
    const { accountId } = c.get('auth');
    const repository = await getOwned(getDb(c.env.DB), accountId, c.req.valid('param').id);
    // Missing and not-yours answer the same, so ids can't be probed.
    if (!repository) throw new ApiError('NOT_FOUND', 'Not found.');
    return c.json({ repository });
  });

  app.get(
    '/:id/activity',
    validate('param', repositoryParams),
    validate('query', activityQuery),
    async (c) => {
      const { accountId } = c.get('auth');
      const db = getDb(c.env.DB);
      const id = c.req.valid('param').id;
      if (!(await getOwned(db, accountId, id))) throw new ApiError('NOT_FOUND', 'Not found.');
      return c.json(await activityPage(db, accountId, { ...c.req.valid('query'), repositoryId: id }));
    },
  );

  app.post('/:id/provision', writeLimit, validate('param', repositoryParams), async (c) => {
    const { accountId } = c.get('auth');
    const result = await provisionRepository(
      getDb(c.env.DB),
      storage(c),
      accountId,
      c.req.valid('param').id,
      Date.now(),
    );
    if (result.status === 'not_found') throw new ApiError('NOT_FOUND', 'Not found.');
    if (result.status === 'invalid_state') throw new ApiError('INVALID_STATE', DELETING);
    return c.json({ repository: result.repository });
  });

  // Short-lived Git credentials for the owner. The response is the only copy of the token.
  app.post(
    '/:id/git-credentials',
    gitLimit,
    validate('param', repositoryParams),
    validate('json', gitCredentialsBody),
    async (c) => {
      const { accountId } = c.get('auth');
      const body = c.req.valid('json');
      const id = c.req.valid('param').id;
      const result = await viaGitHost(c, () =>
        gitCredentials(getDb(c.env.DB), gitHost(c.env), accountId, id, body),
      );
      if (result.status === 'not_found') throw new ApiError('NOT_FOUND', 'Not found.');
      if (result.status === 'not_ready')
        throw new ApiError('INVALID_STATE', 'This repository is not ready yet.');
      if (result.status === 'unavailable')
        throw new ApiError('GIT_HOSTING_UNAVAILABLE', NO_HOSTING);
      logEvent('git_token_issued', {
        requestId: c.get('requestId'),
        accountId,
        scope: result.scope,
        lifetime: body.lifetime,
      });
      return c.json({
        remote: result.remote,
        token: result.token,
        scope: result.scope,
        expiresAt: result.expiresAt,
      });
    },
  );

  // Revokes every token for the repository, including commands copied to a terminal.
  app.delete('/:id/git-credentials', writeLimit, validate('param', repositoryParams), async (c) => {
    const { accountId } = c.get('auth');
    const id = c.req.valid('param').id;
    const result = await viaGitHost(c, () =>
      revokeGitCredentials(getDb(c.env.DB), gitHost(c.env), accountId, id),
    );
    if (result.status === 'not_found') throw new ApiError('NOT_FOUND', 'Not found.');
    if (result.status === 'unavailable') throw new ApiError('GIT_HOSTING_UNAVAILABLE', NO_HOSTING);
    logEvent('git_tokens_revoked', { requestId: c.get('requestId'), accountId });
    return c.json({ revoked: result.count });
  });

  repositoryPullRoutes(app);
  repositorySyncRoutes(app, gitHost);

  app.post(
    '/',
    writeLimit,
    validate('header', createHeaders),
    validate('json', createBody),
    async (c) => {
      const { accountId } = c.get('auth');
      const body = c.req.valid('json');
      const db = getDb(c.env.DB);
      const result = await createRepository(
        db,
        accountId,
        {
          name: body.name,
          description: body.description || null,
          idempotencyKey: c.req.valid('header')['idempotency-key'] ?? null,
        },
        Date.now(),
      );
      if (result.status === 'name_taken')
        throw new ApiError('NAME_TAKEN', 'A repository with that name already exists.');
      if (result.status === 'limit')
        throw new ApiError('LIMIT_REACHED', 'This account has reached its repository limit.');
      logEvent('repository_created', { requestId: c.get('requestId'), accountId });
      // Also finishes a retried create whose first request stopped before storage was ready.
      // A storage failure still answers 201: the repository exists, as `failed`, and can be retried.
      const provisioned =
        result.repository.status === 'provisioning'
          ? await provisionRepository(
              db,
              storage(c),
              accountId,
              result.repository.id,
              Date.now(),
            )
          : null;
      const repository =
        provisioned?.status === 'done' ? provisioned.repository : result.repository;
      return c.json({ repository }, 201);
    },
  );

  app.patch(
    '/:id',
    writeLimit,
    validate('param', repositoryParams),
    validate('json', updateBody),
    async (c) => {
      const { accountId } = c.get('auth');
      const body = c.req.valid('json');
      const result = await updateRepository(
        getDb(c.env.DB),
        accountId,
        c.req.valid('param').id,
        {
          name: body.name,
          description: body.description === undefined ? undefined : body.description || null,
        },
        Date.now(),
      );
      if (result.status === 'not_found') throw new ApiError('NOT_FOUND', 'Not found.');
      if (result.status === 'invalid_state') throw new ApiError('INVALID_STATE', DELETING);
      if (result.status === 'name_taken')
        throw new ApiError('NAME_TAKEN', 'A repository with that name already exists.');
      return c.json({ repository: result.repository });
    },
  );

  // 204 when the data and the row are gone. 202 when storage cleanup stopped partway: the row
  // stays `deleting`, and calling DELETE again (or the daily job) resumes it.
  app.delete('/:id', writeLimit, validate('param', repositoryParams), async (c) => {
    const { accountId } = c.get('auth');
    const id = c.req.valid('param').id;
    const db = getDb(c.env.DB);
    const result = await deleteRepository(db, storage(c), accountId, id, Date.now());
    if (result.status === 'not_found') throw new ApiError('NOT_FOUND', 'Not found.');
    if (result.status === 'incomplete') return c.json({ repository: result.repository }, 202);
    logEvent('repository_deleted', { requestId: c.get('requestId'), accountId });
    return c.body(null, 204);
  });

  return app;
}

export function dashboardRoutes(gitHost: GitHostFor) {
  const app = new Hono<AppEnv>();
  app.use(requireAuth);
  app.get('/overview', async (c) => {
    const { accountId } = c.get('auth');
    return c.json({
      ...(await overview(getDb(c.env.DB), accountId)),
      // Lets the desktop say whether linked repositories can have a Git URL on this server.
      gitHosting: gitHost(c.env) !== null,
      serverTime: Date.now(),
    });
  });
  return app;
}
