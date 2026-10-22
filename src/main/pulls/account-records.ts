import type { PullEvent, PullRequest, PullStatRange } from '../../shared/pulls';
import {
  ApiRequestError,
  type AccountPull,
  type ApiClient,
} from '../auth/api-client';
import { UserError } from '../errors';
import { userError } from '../remote/remote-service';
import {
  PullNotFound,
  type PullRecords,
  type StoredComment,
  type StoredReview,
} from './records';

// Pull request records of a linked repository, kept in the account through the Worker. Every call
// carries the signed-in session; the Worker only finds pull requests of repositories the account owns.

type Call = <T>(fn: (token: string) => Promise<T>) => Promise<T>;

function failure(err: unknown, fallback: string): Error {
  if (err instanceof ApiRequestError) {
    if (err.code === 'NOT_FOUND') return new PullNotFound();
    if (err.code === 'STALE_SNAPSHOT')
      return new UserError(
        'The pull request changed since you opened it. Refresh and try again.',
      );
    if (err.code === 'FORBIDDEN')
      return new UserError('Only the author can change that comment.');
    if (err.code === 'INVALID_STATE')
      return new UserError(
        "That pull request can't take this change in its current state. Refresh to see why.",
      );
    if (err.code === 'PAYLOAD_TOO_LARGE')
      return new UserError('That text is too long to save.');
  }
  return userError(err, fallback);
}

export function createAccountRecords(deps: {
  api: ApiClient;
  call: Call;
  repositoryId: string;
  localRepositoryId: string;
}): PullRecords {
  const { api, call, repositoryId } = deps;
  const view = (pull: AccountPull): PullRequest => ({
    ...pull,
    store: 'account',
    repositoryId: deps.localRepositoryId,
  });
  async function attempt<T>(
    fallback: string,
    fn: (token: string) => Promise<T>,
  ): Promise<T> {
    try {
      return await call(fn);
    } catch (err) {
      throw failure(err, fallback);
    }
  }
  const pullCall = (
    id: string,
    rest: string,
    init: { method?: string; body?: unknown } = {},
    fallback = "Your account didn't save that.",
  ) =>
    attempt(fallback, (token) =>
      api.pullRequest<{ pullRequest: AccountPull }>(
        token,
        id,
        rest,
        'pull',
        init,
      ),
    ).then((result) => view(result.pullRequest));

  return {
    store: 'account',

    async list(input) {
      const page = await attempt(
        "Couldn't load this repository's pull requests.",
        (token) => api.listPullRequests(token, repositoryId, input),
      );
      return {
        pulls: page.pullRequests.map(view),
        nextCursor: page.nextCursor,
        counts: page.counts,
      };
    },

    async get(id) {
      try {
        return await pullCall(id, '', {}, "Couldn't load that pull request.");
      } catch (err) {
        if (err instanceof PullNotFound) return null;
        throw err;
      }
    },

    async create(input) {
      const result = await attempt(
        "Your account didn't create the pull request.",
        (token) =>
          api.createPullRequest(
            token,
            repositoryId,
            {
              title: input.title,
              description: input.description,
              sourceRef: input.sourceRef,
              targetRef: input.targetRef,
              isDraft: input.draft,
            },
            input.key,
          ),
      );
      return view(result.pullRequest);
    },

    update: (id, patch) =>
      pullCall(id, '', {
        method: 'PATCH',
        body: {
          title: patch.title,
          description: patch.description,
          isDraft: patch.draft,
        },
      }),

    setStatus: (id, status) =>
      pullCall(id, status === 'closed' ? '/close' : '/reopen', {
        method: 'POST',
      }),

    // Nothing is sent when the commits are the ones already recorded.
    async recordComparison(id, snapshot) {
      const current = await pullCall(
        id,
        '',
        {},
        "Couldn't load that pull request.",
      );
      if (
        current.latest &&
        current.latest.sourceOid === snapshot.sourceOid &&
        current.latest.targetOid === snapshot.targetOid
      )
        return current;
      return pullCall(id, '/comparisons', { method: 'POST', body: snapshot });
    },

    async recordCheck(id, version, check) {
      const current = await pullCall(
        id,
        '',
        {},
        "Couldn't load that pull request.",
      );
      const latest = current.latest;
      if (!latest || latest.version !== version) return current;
      return pullCall(id, '/comparisons', {
        method: 'POST',
        body: {
          sourceOid: latest.sourceOid,
          targetOid: latest.targetOid,
          mergeBaseOid: latest.mergeBaseOid,
          check,
        },
      });
    },

    reviews: (id) =>
      attempt("Couldn't load the reviews.", (token) =>
        api.pullRequest<{ reviews: StoredReview[] }>(
          token,
          id,
          '/reviews',
          'reviews',
        ),
      ).then((result) => result.reviews),

    addReview: (id, input) =>
      attempt("Your account didn't save the review.", (token) =>
        api.pullRequest<{ review: StoredReview }>(
          token,
          id,
          '/reviews',
          'review',
          {
            method: 'POST',
            body: {
              decision: input.decision,
              body: input.body,
              comparisonVersion: input.version,
              sourceOid: input.sourceOid,
              targetOid: input.targetOid,
            },
          },
        ),
      ).then((result) => result.review),

    comments: (id) =>
      attempt("Couldn't load the comments.", (token) =>
        api.pullRequest<{ comments: StoredComment[] }>(
          token,
          id,
          '/comments',
          'comments',
        ),
      ).then((result) => result.comments),

    addComment: (id, input) =>
      attempt(
        "Your account didn't save the comment. Your text is still here.",
        (token) =>
          api.pullRequest<{ comment: StoredComment }>(
            token,
            id,
            '/comments',
            'comment',
            {
              method: 'POST',
              body: {
                body: input.body,
                parentCommentId: input.parentId,
                anchor: input.anchor,
              },
            },
          ),
      ).then((result) => result.comment),

    editComment: (id, commentId, patch) =>
      attempt("Your account didn't save the change.", (token) =>
        api.pullRequest<{ comment: StoredComment }>(
          token,
          id,
          `/comments/${encodeURIComponent(commentId)}`,
          'comment',
          {
            method: 'PATCH',
            body: patch,
          },
        ),
      ).then((result) => result.comment),

    async deleteComment(id, commentId) {
      await attempt("Your account didn't delete the comment.", (token) =>
        api.pullRequest(
          token,
          id,
          `/comments/${encodeURIComponent(commentId)}`,
          'none',
          { method: 'DELETE' },
        ),
      );
    },

    activity: (id, cursor) =>
      attempt("Couldn't load the activity.", (token) =>
        api.pullRequest<{ events: PullEvent[]; nextCursor: string | null }>(
          token,
          id,
          `/activity?limit=30${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
          'activity',
        ),
      ),

    async recordEvent(id, type, detail) {
      await attempt("Your account didn't record that.", (token) =>
        api.pullRequest(token, id, '/events', 'none', {
          method: 'POST',
          body: { type, detail },
        }),
      );
    },

    recordMerge: (id, input) =>
      pullCall(
        id,
        '/merge-result',
        { method: 'POST', body: input },
        "Your account didn't record the merge yet.",
      ),

    stats: (range: PullStatRange) =>
      attempt("Couldn't load the pull request statistics.", (token) =>
        api.pullRequestStats(token, repositoryId, range),
      ),
  };
}
