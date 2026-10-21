import { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db/client';
import type { AppEnv } from '../../env';
import { cursor } from '../../lib/cursor';
import { requireAuth } from '../../middleware/require-auth';
import { validate } from '../../middleware/validate';
import { listPage } from './activity';

const listQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: cursor(z.tuple([z.number().int().nonnegative(), z.uuid()])).optional(),
});

export function activityRoutes() {
  const app = new Hono<AppEnv>();
  app.use(requireAuth);
  app.get('/', validate('query', listQuery), async (c) => {
    const { accountId } = c.get('auth');
    return c.json(await listPage(getDb(c.env.DB), accountId, c.req.valid('query')));
  });
  return app;
}
