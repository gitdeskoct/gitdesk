import { Hono } from 'hono';
import { getDb } from '../../db/client';
import type { AppEnv } from '../../env';
import { ApiError } from '../../lib/errors';
import { logEvent } from '../../lib/log';
import { rateLimit } from '../../middleware/rate-limit';
import { requireAuth } from '../../middleware/require-auth';
import { validate } from '../../middleware/validate';
import { listPage as activityPage } from '../activity/activity';
import { activityQuery } from '../activity/routes';
import {
  createRepository,
  deleteRepository,
  getOwned,
  listPage,
  overview,
  provisionRepository,
  updateRepository,
} from './repositories';
import { createBody, createHeaders, listQuery, repositoryParams, updateBody } from './schemas';

// Writes spend the free plan's daily D1 row writes, so they get a tighter limit than reads.
const writeLimit = rateLimit('WRITE_LIMITER', (c) => c.get('auth').accountId);

const DELETING = 'This repository is being deleted.';

export function repositoryRoutes() {
  const app = new Hono<AppEnv>();
  app.use(requireAuth);

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
      c.env.REPO_STORAGE,
      accountId,
      c.req.valid('param').id,
      Date.now(),
    );
    if (result.status === 'not_found') throw new ApiError('NOT_FOUND', 'Not found.');
    if (result.status === 'invalid_state') throw new ApiError('INVALID_STATE', DELETING);
    return c.json({ repository: result.repository });
  });

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
              c.env.REPO_STORAGE,
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
    const result = await deleteRepository(db, c.env.REPO_STORAGE, accountId, id, Date.now());
    if (result.status === 'not_found') throw new ApiError('NOT_FOUND', 'Not found.');
    if (result.status === 'incomplete') return c.json({ repository: result.repository }, 202);
    logEvent('repository_deleted', { requestId: c.get('requestId'), accountId });
    return c.body(null, 204);
  });

  return app;
}

export function dashboardRoutes() {
  const app = new Hono<AppEnv>();
  app.use(requireAuth);
  app.get('/overview', async (c) => {
    const { accountId } = c.get('auth');
    return c.json({ ...(await overview(getDb(c.env.DB), accountId)), serverTime: Date.now() });
  });
  return app;
}
