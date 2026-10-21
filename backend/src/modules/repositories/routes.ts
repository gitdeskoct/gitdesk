import { Hono } from 'hono';
import { getDb } from '../../db/client';
import type { AppEnv } from '../../env';
import { ApiError } from '../../lib/errors';
import { logEvent } from '../../lib/log';
import { rateLimit } from '../../middleware/rate-limit';
import { requireAuth } from '../../middleware/require-auth';
import { validate } from '../../middleware/validate';
import { createRepository, getOwned, listPage, overview } from './repositories';
import { createBody, listQuery, repositoryParams } from './schemas';

// Writes spend the free plan's daily D1 row writes, so they get a tighter limit than reads.
const writeLimit = rateLimit('WRITE_LIMITER', (c) => c.get('auth').accountId);

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

  app.post('/', writeLimit, validate('json', createBody), async (c) => {
    const { accountId } = c.get('auth');
    const body = c.req.valid('json');
    const result = await createRepository(
      getDb(c.env.DB),
      accountId,
      { name: body.name, description: body.description || null },
      Date.now(),
    );
    if (result.status === 'name_taken')
      throw new ApiError('NAME_TAKEN', 'A repository with that name already exists.');
    if (result.status === 'limit')
      throw new ApiError('LIMIT_REACHED', 'This account has reached its repository limit.');
    logEvent('repository_created', { requestId: c.get('requestId'), accountId });
    return c.json({ repository: result.repository }, 201);
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
