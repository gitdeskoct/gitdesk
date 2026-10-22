import { Hono, type Context } from 'hono';
import { getDb } from '../../db/client';
import type { AppEnv } from '../../env';
import { ApiError } from '../../lib/errors';
import { logEvent } from '../../lib/log';
import { rateLimit } from '../../middleware/rate-limit';
import { requireAuth } from '../../middleware/require-auth';
import { validate } from '../../middleware/validate';
import {
  addComment,
  addReview,
  createPull,
  deleteComment,
  editComment,
  listActivity,
  listComments,
  listPulls,
  listReviews,
  mergeState,
  pullOwned,
  pullStats,
  recordComparison,
  recordEvent,
  recordMerge,
  repositoryOwned,
  setStatus,
  showPull,
  updatePull,
  type CommentResult,
} from './pull-requests';
import {
  activityQuery,
  commentBody,
  commentParams,
  commentPatch,
  comparisonBody,
  createBody,
  createHeaders,
  eventBody,
  listQuery,
  mergeResultBody,
  pullParams,
  repositoryParams,
  reviewBody,
  statsQuery,
  updateBody,
} from './schemas';

// Pull request writes get their own budget: a review session writes comments and snapshots in
// bursts that would starve repository edits under WRITE_LIMITER.
const pullLimit = rateLimit('PULL_LIMITER', (c) => c.get('auth').accountId);

const NOT_FOUND = () => new ApiError('NOT_FOUND', 'Not found.');

async function owned(c: Context<AppEnv>, pullRequestId: string) {
  const row = await pullOwned(getDb(c.env.DB), c.get('auth').accountId, pullRequestId);
  if (!row) throw NOT_FOUND();
  return row;
}

function commentOutcome(result: CommentResult) {
  if (result.status === 'not_found') throw NOT_FOUND();
  if (result.status === 'forbidden') throw new ApiError('FORBIDDEN', 'Only the author can change that comment.');
  if (result.status === 'stale')
    throw new ApiError(
      'STALE_SNAPSHOT',
      "That comparison doesn't belong to this pull request. Refresh and try again.",
    );
  if (result.status === 'invalid') throw new ApiError('VALIDATION_FAILED', 'Replies go to the first comment of a thread.');
  return result.comment;
}

// Under /api/v1/repositories: the pull requests of one repository the account owns.
export function repositoryPullRoutes(app: Hono<AppEnv>) {
  app.get(
    '/:repositoryId/pull-requests',
    validate('param', repositoryParams),
    validate('query', listQuery),
    async (c) => {
      const db = getDb(c.env.DB);
      const { repositoryId } = c.req.valid('param');
      if (!(await repositoryOwned(db, c.get('auth').accountId, repositoryId))) throw NOT_FOUND();
      return c.json(await listPulls(db, repositoryId, c.req.valid('query')));
    },
  );

  app.get(
    '/:repositoryId/pull-requests/stats',
    validate('param', repositoryParams),
    validate('query', statsQuery),
    async (c) => {
      const db = getDb(c.env.DB);
      const { repositoryId } = c.req.valid('param');
      if (!(await repositoryOwned(db, c.get('auth').accountId, repositoryId))) throw NOT_FOUND();
      return c.json(await pullStats(db, repositoryId, c.req.valid('query').range, Date.now()));
    },
  );

  app.post(
    '/:repositoryId/pull-requests',
    pullLimit,
    validate('param', repositoryParams),
    validate('header', createHeaders),
    validate('json', createBody),
    async (c) => {
      const db = getDb(c.env.DB);
      const { accountId } = c.get('auth');
      const { repositoryId } = c.req.valid('param');
      if (!(await repositoryOwned(db, accountId, repositoryId))) throw NOT_FOUND();
      const row = await createPull(
        db,
        accountId,
        repositoryId,
        c.req.valid('json'),
        c.req.valid('header')['idempotency-key'] ?? null,
        Date.now(),
      );
      logEvent('pull_request_created', { requestId: c.get('requestId'), accountId });
      return c.json({ pullRequest: await showPull(db, row) }, 201);
    },
  );
}

// Under /api/v1/pull-requests: one pull request, found only through its owner's repository.
export function pullRequestRoutes() {
  const app = new Hono<AppEnv>();
  app.use(requireAuth);

  app.get('/:pullRequestId', validate('param', pullParams), async (c) => {
    const row = await owned(c, c.req.valid('param').pullRequestId);
    return c.json({ pullRequest: await showPull(getDb(c.env.DB), row) });
  });

  app.patch('/:pullRequestId', pullLimit, validate('param', pullParams), validate('json', updateBody), async (c) => {
    const db = getDb(c.env.DB);
    const row = await owned(c, c.req.valid('param').pullRequestId);
    if (row.status === 'merged') throw new ApiError('INVALID_STATE', 'A merged pull request can no longer be edited.');
    const updated = await updatePull(db, c.get('auth').accountId, row, c.req.valid('json'), Date.now());
    return c.json({ pullRequest: await showPull(db, updated) });
  });

  for (const [action, status] of [
    ['close', 'closed'],
    ['reopen', 'open'],
  ] as const) {
    app.post(`/:pullRequestId/${action}`, pullLimit, validate('param', pullParams), async (c) => {
      const db = getDb(c.env.DB);
      const row = await owned(c, c.req.valid('param').pullRequestId);
      if (row.status === 'merged')
        throw new ApiError('INVALID_STATE', 'A merged pull request stays merged. Revert it to undo its changes.');
      const updated = await setStatus(db, c.get('auth').accountId, row, status, Date.now());
      if (!updated) throw new ApiError('INVALID_STATE', 'That pull request was merged meanwhile.');
      return c.json({ pullRequest: await showPull(db, updated) });
    });
  }

  app.get('/:pullRequestId/reviews', validate('param', pullParams), async (c) => {
    const row = await owned(c, c.req.valid('param').pullRequestId);
    return c.json({ reviews: await listReviews(getDb(c.env.DB), row.id) });
  });

  app.post('/:pullRequestId/reviews', pullLimit, validate('param', pullParams), validate('json', reviewBody), async (c) => {
    const row = await owned(c, c.req.valid('param').pullRequestId);
    if (row.status !== 'open') throw new ApiError('INVALID_STATE', 'Only an open pull request takes reviews.');
    const result = await addReview(getDb(c.env.DB), c.get('auth').accountId, row, c.req.valid('json'), Date.now());
    if (result.status === 'stale')
      throw new ApiError('STALE_SNAPSHOT', 'The pull request changed since that comparison. Review the latest.');
    return c.json({ review: result.review }, 201);
  });

  app.get('/:pullRequestId/comments', validate('param', pullParams), async (c) => {
    const row = await owned(c, c.req.valid('param').pullRequestId);
    return c.json({ comments: await listComments(getDb(c.env.DB), row.id) });
  });

  app.post('/:pullRequestId/comments', pullLimit, validate('param', pullParams), validate('json', commentBody), async (c) => {
    const row = await owned(c, c.req.valid('param').pullRequestId);
    const result = await addComment(getDb(c.env.DB), c.get('auth').accountId, row, c.req.valid('json'), Date.now());
    return c.json({ comment: commentOutcome(result) }, 201);
  });

  app.patch(
    '/:pullRequestId/comments/:commentId',
    pullLimit,
    validate('param', commentParams),
    validate('json', commentPatch),
    async (c) => {
      const { pullRequestId, commentId } = c.req.valid('param');
      const row = await owned(c, pullRequestId);
      const result = await editComment(getDb(c.env.DB), c.get('auth').accountId, row, commentId, c.req.valid('json'), Date.now());
      return c.json({ comment: commentOutcome(result) });
    },
  );

  app.delete('/:pullRequestId/comments/:commentId', pullLimit, validate('param', commentParams), async (c) => {
    const { pullRequestId, commentId } = c.req.valid('param');
    const row = await owned(c, pullRequestId);
    const result = await deleteComment(getDb(c.env.DB), c.get('auth').accountId, row, commentId, Date.now());
    if (result === 'not_found') throw NOT_FOUND();
    if (result === 'forbidden') throw new ApiError('FORBIDDEN', 'Only the author can delete that comment.');
    return c.body(null, 204);
  });

  app.get('/:pullRequestId/activity', validate('param', pullParams), validate('query', activityQuery), async (c) => {
    const row = await owned(c, c.req.valid('param').pullRequestId);
    return c.json(await listActivity(getDb(c.env.DB), row.id, c.req.valid('query')));
  });

  // Events from the desktop's Git work (merge started, conflicts, pushed, reverted...).
  app.post('/:pullRequestId/events', pullLimit, validate('param', pullParams), validate('json', eventBody), async (c) => {
    const row = await owned(c, c.req.valid('param').pullRequestId);
    const body = c.req.valid('json');
    await recordEvent(getDb(c.env.DB), c.get('auth').accountId, row, body.type, body.detail, Date.now());
    return c.body(null, 204);
  });

  app.post('/:pullRequestId/comparisons', pullLimit, validate('param', pullParams), validate('json', comparisonBody), async (c) => {
    const db = getDb(c.env.DB);
    const row = await owned(c, c.req.valid('param').pullRequestId);
    if (row.status !== 'open') throw new ApiError('INVALID_STATE', 'Only an open pull request is compared again.');
    const updated = await recordComparison(db, c.get('auth').accountId, row, c.req.valid('json'), Date.now());
    return c.json({ pullRequest: await showPull(db, updated) });
  });

  app.post('/:pullRequestId/merge-result', pullLimit, validate('param', pullParams), validate('json', mergeResultBody), async (c) => {
    const db = getDb(c.env.DB);
    const { accountId } = c.get('auth');
    const row = await owned(c, c.req.valid('param').pullRequestId);
    if (row.status === 'closed') throw new ApiError('INVALID_STATE', 'A closed pull request is not merged.');
    const result = await recordMerge(db, accountId, row, c.req.valid('json'), Date.now());
    if (result.status === 'conflict')
      throw new ApiError('VALIDATION_FAILED', 'That operation id belongs to another pull request.');
    logEvent('pull_request_merged', { requestId: c.get('requestId'), accountId });
    return c.json({ pullRequest: await showPull(db, (await pullOwned(db, accountId, row.id))!) });
  });

  app.get('/:pullRequestId/merge-state', validate('param', pullParams), async (c) => {
    const row = await owned(c, c.req.valid('param').pullRequestId);
    return c.json(await mergeState(getDb(c.env.DB), row));
  });

  return app;
}
