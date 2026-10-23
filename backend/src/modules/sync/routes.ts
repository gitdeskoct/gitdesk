import type { Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db/client';
import type { AppEnv } from '../../env';
import { ApiError } from '../../lib/errors';
import type { GitHost } from '../../lib/git-host';
import { rateLimit } from '../../middleware/rate-limit';
import { validate } from '../../middleware/validate';
import { branchName } from '../pull-requests/schemas';
import { repositoryParams } from '../repositories/schemas';
import { recordPush } from './sync';

const oid = z.string().regex(/^[0-9a-f]{40,64}$/);
const syncLimit = rateLimit('SYNC_LIMITER', (c) => c.get('auth').accountId);

export const syncEventBody = z
  .object({
    operationId: z.uuid(),
    kind: z.literal('push'),
    ref: z
      .string()
      .max(300)
      .refine(
        (ref) => ref.startsWith('refs/heads/') && branchName.safeParse(ref.slice(11)).success,
      ),
    oldOid: oid.nullable(),
    newOid: oid,
  })
  .strict();

// Mounted inside the repository routes, behind their requireAuth.
export function repositorySyncRoutes(
  app: Hono<AppEnv>,
  gitHost: (env: CloudflareBindings) => GitHost | null,
) {
  app.post(
    '/:id/sync-events',
    syncLimit,
    validate('param', repositoryParams),
    validate('json', syncEventBody),
    async (c) => {
      const { accountId } = c.get('auth');
      const result = await recordPush(
        getDb(c.env.DB),
        gitHost(c.env),
        accountId,
        c.req.valid('param').id,
        c.req.valid('json'),
        Date.now(),
      );
      if (result.status === 'not_found') throw new ApiError('NOT_FOUND', 'Not found.');
      if (result.status === 'conflict')
        throw new ApiError('INVALID_STATE', 'That operation was recorded for another repository.');
      return c.json({ event: { result: result.result, tip: result.tip } });
    },
  );
}
