import { and, asc, count, desc, eq, inArray, isNull, lt, ne, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import {
  accounts,
  pullRequestActivity,
  pullRequestCommentAnchors,
  pullRequestComments,
  pullRequestMergeResults,
  pullRequestReviews,
  pullRequests,
  pullRequestSnapshots,
  repositories,
} from '../../db/schema';
import { encodeCursor } from '../../lib/cursor';
import type {
  activityQuery,
  anchorBody,
  comparisonBody,
  createBody,
  listQuery,
  REPORTED_EVENTS,
  reviewBody,
} from './schemas';

type PullRow = typeof pullRequests.$inferSelect;
type Author = { accountId: string; name: string; avatarUrl: string | null };

// Every lookup carries the owner: a pull request is only ever found through a repository the
// account owns, so another account's id answers exactly like a missing one.
const ownedRepository = (accountId: string, repositoryId: string) =>
  and(
    eq(repositories.id, repositoryId),
    eq(repositories.ownerAccountId, accountId),
    ne(repositories.status, 'deleting'),
  );

export async function repositoryOwned(db: Db, accountId: string, repositoryId: string) {
  const [row] = await db
    .select({ id: repositories.id })
    .from(repositories)
    .where(ownedRepository(accountId, repositoryId))
    .limit(1);
  return !!row;
}

export async function pullOwned(db: Db, accountId: string, pullId: string): Promise<PullRow | null> {
  const [row] = await db
    .select({ pull: pullRequests })
    .from(pullRequests)
    .innerJoin(repositories, eq(repositories.id, pullRequests.repositoryId))
    .where(
      and(
        eq(pullRequests.id, pullId),
        eq(repositories.ownerAccountId, accountId),
        ne(repositories.status, 'deleting'),
      ),
    )
    .limit(1);
  return row?.pull ?? null;
}

async function authors(db: Db, ids: string[]): Promise<Map<string, Author>> {
  const unique = [...new Set(ids)];
  if (!unique.length) return new Map();
  const rows = await db
    .select({ id: accounts.id, name: accounts.displayName, avatarUrl: accounts.avatarUrl })
    .from(accounts)
    .where(inArray(accounts.id, unique));
  return new Map(rows.map((row) => [row.id, { accountId: row.id, name: row.name, avatarUrl: row.avatarUrl }]));
}

const unknownAuthor = (accountId: string): Author => ({ accountId, name: 'Deleted account', avatarUrl: null });

// The pull requests of one page with what a list row needs: latest snapshot, comment counts and
// the newest decision. Four batched reads, whatever the page size.
async function present(db: Db, rows: PullRow[]) {
  if (!rows.length) return [];
  const ids = rows.map((row) => row.id);
  const [snapshots, comments, reviews] = await db.batch([
    db
      .select()
      .from(pullRequestSnapshots)
      .where(inArray(pullRequestSnapshots.pullRequestId, ids))
      .orderBy(desc(pullRequestSnapshots.version)),
    db
      .select({
        pullRequestId: pullRequestComments.pullRequestId,
        comments: count(),
        unresolved: sql<number>`sum(case when ${pullRequestComments.parentCommentId} is null and ${pullRequestComments.resolvedAt} is null then 1 else 0 end)`,
      })
      .from(pullRequestComments)
      .where(and(inArray(pullRequestComments.pullRequestId, ids), isNull(pullRequestComments.deletedAt)))
      .groupBy(pullRequestComments.pullRequestId),
    db
      .select()
      .from(pullRequestReviews)
      .where(and(inArray(pullRequestReviews.pullRequestId, ids), ne(pullRequestReviews.decision, 'commented')))
      .orderBy(desc(pullRequestReviews.submittedAt)),
  ]);
  const people = await authors(db, rows.map((row) => row.authorAccountId));
  return rows.map((row) => {
    const snapshot = snapshots.find((s) => s.pullRequestId === row.id);
    const counted = comments.find((c) => c.pullRequestId === row.id);
    const review = reviews.find((r) => r.pullRequestId === row.id);
    const latest = snapshot
      ? {
          version: snapshot.version,
          sourceOid: snapshot.sourceOid,
          targetOid: snapshot.targetOid,
          mergeBaseOid: snapshot.mergeBaseOid,
          mergeability: snapshot.mergeability,
          reason: snapshot.reason,
          conflicts: JSON.parse(snapshot.conflicts) as string[],
          checkedAt: snapshot.checkedAt,
        }
      : null;
    return {
      id: row.id,
      number: row.number,
      title: row.title,
      description: row.description,
      sourceRef: row.sourceRef,
      targetRef: row.targetRef,
      status: row.status,
      isDraft: row.isDraft,
      author: people.get(row.authorAccountId) ?? unknownAuthor(row.authorAccountId),
      createdAt: row.createdAt,
      updatedAt: row.updatedAt,
      closedAt: row.closedAt,
      mergedAt: row.mergedAt,
      mergeCommitOid: row.mergeCommitOid,
      latest,
      comments: counted?.comments ?? 0,
      unresolved: Number(counted?.unresolved ?? 0),
      review: review
        ? {
            decision: review.decision,
            version: review.comparisonVersion,
            stale: !!latest && review.comparisonVersion < latest.version,
          }
        : null,
    };
  });
}

export type PullView = Awaited<ReturnType<typeof present>>[number];

export async function showPull(db: Db, row: PullRow): Promise<PullView> {
  return (await present(db, [row]))[0]!;
}

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export async function listPulls(db: Db, repositoryId: string, input: z.output<typeof listQuery>) {
  const q = input.q.trim();
  const number = /^#?(\d{1,9})$/.exec(q)?.[1];
  const like = `%${likeEscape(q)}%`;
  const search = q
    ? or(
        sql`${pullRequests.title} like ${like} escape '\\'`,
        sql`${pullRequests.sourceRef} like ${like} escape '\\'`,
        sql`${pullRequests.targetRef} like ${like} escape '\\'`,
        number ? eq(pullRequests.number, Number(number)) : undefined,
      )
    : undefined;
  const after = input.cursor
    ? or(
        lt(pullRequests.updatedAt, input.cursor[0]),
        and(eq(pullRequests.updatedAt, input.cursor[0]), lt(pullRequests.id, input.cursor[1])),
      )
    : undefined;
  const [rows, totals] = await db.batch([
    db
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.repositoryId, repositoryId), eq(pullRequests.status, input.status), search, after))
      .orderBy(desc(pullRequests.updatedAt), desc(pullRequests.id))
      .limit(input.limit + 1),
    db
      .select({ status: pullRequests.status, n: count() })
      .from(pullRequests)
      .where(eq(pullRequests.repositoryId, repositoryId))
      .groupBy(pullRequests.status),
  ]);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  const counts = { open: 0, merged: 0, closed: 0 };
  for (const row of totals) counts[row.status] = row.n;
  return {
    pullRequests: await present(db, page),
    nextCursor: rows.length > input.limit && last ? encodeCursor([last.updatedAt, last.id]) : null,
    counts,
  };
}

const event = (
  db: Db,
  pullRequestId: string,
  actor: Author,
  type: string,
  payload: string | null,
  now: number,
) =>
  db.insert(pullRequestActivity).values({
    id: crypto.randomUUID(),
    pullRequestId,
    actorAccountId: actor.accountId,
    actorName: actor.name,
    eventType: type,
    eventPayload: payload,
    createdAt: now,
  });

export async function actorOf(db: Db, accountId: string): Promise<Author> {
  return (await authors(db, [accountId])).get(accountId) ?? unknownAuthor(accountId);
}

// The number comes from the insert itself, so two creates can't take the same one. A retried
// create with the same key returns the first pull request.
export async function createPull(
  db: Db,
  accountId: string,
  repositoryId: string,
  input: z.output<typeof createBody>,
  idempotencyKey: string | null,
  now: number,
): Promise<PullRow> {
  if (idempotencyKey) {
    const [existing] = await db
      .select()
      .from(pullRequests)
      .where(and(eq(pullRequests.repositoryId, repositoryId), eq(pullRequests.idempotencyKey, idempotencyKey)))
      .limit(1);
    if (existing) return existing;
  }
  const id = crypto.randomUUID();
  const actor = await actorOf(db, accountId);
  await db.batch([
    db
      .insert(pullRequests)
      .select(
        db
          .select({
            id: sql<string>`${id}`.as('id'),
            repositoryId: sql<string>`${repositoryId}`.as('repository_id'),
            authorAccountId: sql<string>`${accountId}`.as('author_account_id'),
            number: sql<number>`coalesce(max(${pullRequests.number}), 0) + 1`.as('number'),
            title: sql<string>`${input.title}`.as('title'),
            description: sql<string>`${input.description}`.as('description'),
            sourceRef: sql<string>`${input.sourceRef}`.as('source_ref'),
            targetRef: sql<string>`${input.targetRef}`.as('target_ref'),
            status: sql<'open'>`'open'`.as('status'),
            isDraft: sql<boolean>`${input.isDraft ? 1 : 0}`.as('is_draft'),
            createdAt: sql<number>`${now}`.as('created_at'),
            updatedAt: sql<number>`${now}`.as('updated_at'),
            closedAt: sql<null>`null`.as('closed_at'),
            mergedAt: sql<null>`null`.as('merged_at'),
            mergeCommitOid: sql<null>`null`.as('merge_commit_oid'),
            latestSourceOid: sql<null>`null`.as('latest_source_oid'),
            latestTargetOid: sql<null>`null`.as('latest_target_oid'),
            comparisonVersion: sql<number>`0`.as('comparison_version'),
            idempotencyKey: sql<string | null>`${idempotencyKey}`.as('idempotency_key'),
          })
          .from(pullRequests)
          .where(eq(pullRequests.repositoryId, repositoryId)),
      )
      .onConflictDoNothing(),
    event(db, id, actor, 'created', `${input.sourceRef} → ${input.targetRef}`, now),
  ]);
  const [row] = await db.select().from(pullRequests).where(eq(pullRequests.id, id)).limit(1);
  if (row) return row;
  // The insert lost a race to a create with the same key; return that one.
  const [original] = await db
    .select()
    .from(pullRequests)
    .where(and(eq(pullRequests.repositoryId, repositoryId), eq(pullRequests.idempotencyKey, idempotencyKey ?? '')))
    .limit(1);
  if (!original) throw new Error('pull request was not created');
  return original;
}

export async function updatePull(
  db: Db,
  accountId: string,
  row: PullRow,
  patch: { title?: string; description?: string; isDraft?: boolean },
  now: number,
) {
  const actor = await actorOf(db, accountId);
  await db.batch([
    db
      .update(pullRequests)
      .set({ title: patch.title, description: patch.description, isDraft: patch.isDraft, updatedAt: now })
      .where(eq(pullRequests.id, row.id)),
    event(db, row.id, actor, 'edited', patch.title && patch.title !== row.title ? patch.title : null, now),
  ]);
  return (await db.select().from(pullRequests).where(eq(pullRequests.id, row.id)))[0]!;
}

// Closing and reopening never touch branches; a merged pull request is never reopened.
export async function setStatus(db: Db, accountId: string, row: PullRow, status: 'open' | 'closed', now: number) {
  if (row.status === status) return row;
  const actor = await actorOf(db, accountId);
  const [updated] = await db.batch([
    db
      .update(pullRequests)
      .set({ status, closedAt: status === 'closed' ? now : null, updatedAt: now })
      .where(and(eq(pullRequests.id, row.id), ne(pullRequests.status, 'merged')))
      .returning(),
    event(db, row.id, actor, status === 'closed' ? 'closed' : 'reopened', null, now),
  ]);
  return updated[0] ?? null;
}

export async function recordComparison(
  db: Db,
  accountId: string,
  row: PullRow,
  input: z.output<typeof comparisonBody>,
  now: number,
) {
  const [latest] = await db
    .select()
    .from(pullRequestSnapshots)
    .where(eq(pullRequestSnapshots.pullRequestId, row.id))
    .orderBy(desc(pullRequestSnapshots.version))
    .limit(1);
  const same = latest && latest.sourceOid === input.sourceOid && latest.targetOid === input.targetOid;
  const actor = await actorOf(db, accountId);
  const version = same ? latest.version : (latest?.version ?? 0) + 1;
  const writes = [];
  if (!same) {
    writes.push(
      db.insert(pullRequestSnapshots).values({
        id: crypto.randomUUID(),
        pullRequestId: row.id,
        version,
        sourceOid: input.sourceOid,
        targetOid: input.targetOid,
        mergeBaseOid: input.mergeBaseOid,
        createdAt: now,
      }),
      db
        .update(pullRequests)
        .set({
          latestSourceOid: input.sourceOid,
          latestTargetOid: input.targetOid,
          comparisonVersion: version,
          updatedAt: now,
        })
        .where(eq(pullRequests.id, row.id)),
    );
    if (latest) writes.push(event(db, row.id, actor, 'comparison_updated', `${version}:${input.sourceOid}:${input.targetOid}`, now));
  }
  if (input.check) {
    writes.push(
      db
        .update(pullRequestSnapshots)
        .set({
          mergeability: input.check.mergeability,
          reason: input.check.reason,
          conflicts: JSON.stringify(input.check.conflicts),
          checkedAt: now,
        })
        .where(and(eq(pullRequestSnapshots.pullRequestId, row.id), eq(pullRequestSnapshots.version, version))),
      event(db, row.id, actor, 'mergeability_checked', `${version}:${input.check.mergeability}:${input.check.conflicts.length}`, now),
    );
  }
  if (writes.length) await db.batch(writes as [ (typeof writes)[number], ...(typeof writes)[number][] ]);
  return (await db.select().from(pullRequests).where(eq(pullRequests.id, row.id)))[0]!;
}

const toReview = (review: typeof pullRequestReviews.$inferSelect, people: Map<string, Author>) => ({
  id: review.id,
  decision: review.decision,
  body: review.body,
  version: review.comparisonVersion,
  sourceOid: review.sourceOid,
  targetOid: review.targetOid,
  author: people.get(review.reviewerAccountId) ?? unknownAuthor(review.reviewerAccountId),
  submittedAt: review.submittedAt,
});

export async function listReviews(db: Db, pullId: string) {
  const rows = await db
    .select()
    .from(pullRequestReviews)
    .where(eq(pullRequestReviews.pullRequestId, pullId))
    .orderBy(desc(pullRequestReviews.submittedAt))
    .limit(100);
  const people = await authors(db, rows.map((row) => row.reviewerAccountId));
  return rows.map((row) => toReview(row, people));
}

export type ReviewResult = { status: 'stale' } | { status: 'done'; review: ReturnType<typeof toReview> };

// A review names the exact snapshot it looked at; a review of anything but the latest is refused.
export async function addReview(
  db: Db,
  accountId: string,
  row: PullRow,
  input: z.output<typeof reviewBody>,
  now: number,
): Promise<ReviewResult> {
  const [latest] = await db
    .select()
    .from(pullRequestSnapshots)
    .where(eq(pullRequestSnapshots.pullRequestId, row.id))
    .orderBy(desc(pullRequestSnapshots.version))
    .limit(1);
  if (
    !latest ||
    latest.version !== input.comparisonVersion ||
    latest.sourceOid !== input.sourceOid ||
    latest.targetOid !== input.targetOid
  )
    return { status: 'stale' };
  const actor = await actorOf(db, accountId);
  const review = {
    id: crypto.randomUUID(),
    pullRequestId: row.id,
    reviewerAccountId: accountId,
    decision: input.decision,
    body: input.body,
    sourceOid: input.sourceOid,
    targetOid: input.targetOid,
    comparisonVersion: input.comparisonVersion,
    submittedAt: now,
  };
  await db.batch([
    db.insert(pullRequestReviews).values(review),
    event(db, row.id, actor, 'reviewed', `${input.decision}:${input.comparisonVersion}`, now),
    db.update(pullRequests).set({ updatedAt: now }).where(eq(pullRequests.id, row.id)),
  ]);
  return { status: 'done', review: toReview(review, new Map([[accountId, actor]])) };
}

type CommentRow = typeof pullRequestComments.$inferSelect;
type AnchorRow = typeof pullRequestCommentAnchors.$inferSelect;

const toComment = (row: CommentRow, anchor: AnchorRow | null, people: Map<string, Author>) => ({
  id: row.id,
  parentId: row.parentCommentId,
  author: people.get(row.authorAccountId) ?? unknownAuthor(row.authorAccountId),
  body: row.deletedAt ? '' : row.body,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
  deleted: row.deletedAt !== null,
  resolved: row.resolvedAt !== null,
  anchor: anchor
    ? {
        comparisonVersion: anchor.comparisonVersion,
        sourceOid: anchor.sourceOid,
        targetOid: anchor.targetOid,
        path: anchor.path,
        side: anchor.side,
        oldLine: anchor.oldLine,
        newLine: anchor.newLine,
        contextHash: anchor.contextHash,
      }
    : null,
});

export async function listComments(db: Db, pullId: string) {
  const rows = await db
    .select({ comment: pullRequestComments, anchor: pullRequestCommentAnchors })
    .from(pullRequestComments)
    .leftJoin(pullRequestCommentAnchors, eq(pullRequestCommentAnchors.commentId, pullRequestComments.id))
    .where(eq(pullRequestComments.pullRequestId, pullId))
    .orderBy(asc(pullRequestComments.createdAt), asc(pullRequestComments.id))
    .limit(1000);
  const people = await authors(db, rows.map((row) => row.comment.authorAccountId));
  return rows.map((row) => toComment(row.comment, row.anchor, people));
}

export type CommentResult =
  | { status: 'done'; comment: ReturnType<typeof toComment> }
  | { status: 'not_found' }
  | { status: 'stale' }
  | { status: 'forbidden' }
  | { status: 'invalid' };

export async function addComment(
  db: Db,
  accountId: string,
  row: PullRow,
  input: { body: string; parentCommentId: string | null; anchor: z.output<typeof anchorBody> | null },
  now: number,
): Promise<CommentResult> {
  if (input.parentCommentId) {
    const [parent] = await db
      .select()
      .from(pullRequestComments)
      .where(and(eq(pullRequestComments.id, input.parentCommentId), eq(pullRequestComments.pullRequestId, row.id)))
      .limit(1);
    // Threads are one level deep: replies go to the first comment.
    if (!parent || parent.parentCommentId) return { status: 'invalid' };
  }
  if (input.anchor) {
    const [snapshot] = await db
      .select()
      .from(pullRequestSnapshots)
      .where(
        and(
          eq(pullRequestSnapshots.pullRequestId, row.id),
          eq(pullRequestSnapshots.version, input.anchor.comparisonVersion),
        ),
      )
      .limit(1);
    if (!snapshot || snapshot.sourceOid !== input.anchor.sourceOid || snapshot.targetOid !== input.anchor.targetOid)
      return { status: 'stale' };
  }
  const actor = await actorOf(db, accountId);
  const comment: CommentRow = {
    id: crypto.randomUUID(),
    pullRequestId: row.id,
    authorAccountId: accountId,
    parentCommentId: input.parentCommentId,
    body: input.body,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
    resolvedAt: null,
  };
  const anchor: AnchorRow | null = input.anchor ? { commentId: comment.id, ...input.anchor, isOutdated: false } : null;
  await db.batch([
    db.insert(pullRequestComments).values(comment),
    ...(anchor ? [db.insert(pullRequestCommentAnchors).values(anchor)] : []),
    event(
      db,
      row.id,
      actor,
      'commented',
      input.anchor ? `${input.anchor.path}:${input.anchor.newLine ?? input.anchor.oldLine}` : null,
      now,
    ),
    db.update(pullRequests).set({ updatedAt: now }).where(eq(pullRequests.id, row.id)),
  ]);
  return { status: 'done', comment: toComment(comment, anchor, new Map([[accountId, actor]])) };
}

// Only the author edits or deletes a comment's text; the repository owner may resolve any thread.
export async function editComment(
  db: Db,
  accountId: string,
  row: PullRow,
  commentId: string,
  patch: { body?: string; resolved?: boolean },
  now: number,
): Promise<CommentResult> {
  const [found] = await db
    .select({ comment: pullRequestComments, anchor: pullRequestCommentAnchors })
    .from(pullRequestComments)
    .leftJoin(pullRequestCommentAnchors, eq(pullRequestCommentAnchors.commentId, pullRequestComments.id))
    .where(and(eq(pullRequestComments.id, commentId), eq(pullRequestComments.pullRequestId, row.id)))
    .limit(1);
  if (!found || found.comment.deletedAt) return { status: 'not_found' };
  if (patch.body !== undefined && found.comment.authorAccountId !== accountId) return { status: 'forbidden' };
  const resolvedAt =
    patch.resolved === undefined ? found.comment.resolvedAt : patch.resolved ? (found.comment.resolvedAt ?? now) : null;
  const [updated] = await db
    .update(pullRequestComments)
    .set({ body: patch.body ?? found.comment.body, resolvedAt, updatedAt: now })
    .where(eq(pullRequestComments.id, commentId))
    .returning();
  const people = await authors(db, [updated!.authorAccountId]);
  return { status: 'done', comment: toComment(updated!, found.anchor, people) };
}

export async function deleteComment(db: Db, accountId: string, row: PullRow, commentId: string, now: number) {
  const [found] = await db
    .select()
    .from(pullRequestComments)
    .where(and(eq(pullRequestComments.id, commentId), eq(pullRequestComments.pullRequestId, row.id)))
    .limit(1);
  if (!found || found.deletedAt) return 'not_found' as const;
  if (found.authorAccountId !== accountId) return 'forbidden' as const;
  // Soft delete keeps the replies of a thread readable under "Comment deleted".
  await db
    .update(pullRequestComments)
    .set({ deletedAt: now, body: '', updatedAt: now })
    .where(eq(pullRequestComments.id, commentId));
  return 'deleted' as const;
}

export async function listActivity(db: Db, pullId: string, input: z.output<typeof activityQuery>) {
  const after = input.cursor
    ? or(
        lt(pullRequestActivity.createdAt, input.cursor[0]),
        and(eq(pullRequestActivity.createdAt, input.cursor[0]), lt(pullRequestActivity.id, input.cursor[1])),
      )
    : undefined;
  const rows = await db
    .select()
    .from(pullRequestActivity)
    .where(and(eq(pullRequestActivity.pullRequestId, pullId), after))
    .orderBy(desc(pullRequestActivity.createdAt), desc(pullRequestActivity.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    events: page.map((row) => ({
      id: row.id,
      type: row.eventType,
      actor: { accountId: row.actorAccountId, name: row.actorName, avatarUrl: null },
      detail: row.eventPayload,
      createdAt: row.createdAt,
    })),
    nextCursor: rows.length > input.limit && last ? encodeCursor([last.createdAt, last.id]) : null,
  };
}

export async function recordEvent(
  db: Db,
  accountId: string,
  row: PullRow,
  type: (typeof REPORTED_EVENTS)[number],
  detail: string | null,
  now: number,
) {
  await event(db, row.id, await actorOf(db, accountId), type, detail, now);
}

// A client-reported merge. The operation id makes a retry after a timeout return the first result
// instead of logging a second merge; a pull request that is already merged stays as it was.
export async function recordMerge(
  db: Db,
  accountId: string,
  row: PullRow,
  input: { operationId: string; mergeCommitOid: string; targetOid: string },
  now: number,
) {
  const [existing] = await db
    .select()
    .from(pullRequestMergeResults)
    .where(eq(pullRequestMergeResults.operationId, input.operationId))
    .limit(1);
  if (existing) {
    if (existing.pullRequestId !== row.id) return { status: 'conflict' as const };
    return { status: 'done' as const };
  }
  if (row.status === 'merged') return { status: 'done' as const };
  const actor = await actorOf(db, accountId);
  await db.batch([
    db
      .insert(pullRequestMergeResults)
      .values({ ...input, pullRequestId: row.id, createdAt: now })
      .onConflictDoNothing(),
    db
      .update(pullRequests)
      .set({ status: 'merged', mergedAt: now, mergeCommitOid: input.mergeCommitOid, closedAt: null, updatedAt: now })
      .where(and(eq(pullRequests.id, row.id), ne(pullRequests.status, 'merged'))),
    event(db, row.id, actor, 'merged', input.mergeCommitOid, now),
  ]);
  return { status: 'done' as const };
}

export async function mergeState(db: Db, row: PullRow) {
  const [result] = await db
    .select()
    .from(pullRequestMergeResults)
    .where(eq(pullRequestMergeResults.pullRequestId, row.id))
    .orderBy(desc(pullRequestMergeResults.createdAt))
    .limit(1);
  const view = await showPull(db, row);
  return {
    status: row.status,
    mergedAt: row.mergedAt,
    mergeCommitOid: row.mergeCommitOid,
    latest: view.latest,
    // Reported by a desktop after its local merge. Not verified against hosted Git refs.
    result: result
      ? { operationId: result.operationId, mergeCommitOid: result.mergeCommitOid, targetOid: result.targetOid, reportedAt: result.createdAt }
      : null,
  };
}

const MONTHS = { '3m': 3, '6m': 6, '1y': 12 } as const;

// Months are UTC on the server; the desktop labels them as such.
export async function pullStats(db: Db, repositoryId: string, range: keyof typeof MONTHS, now: number) {
  const today = new Date(now);
  const start = Date.UTC(today.getUTCFullYear(), today.getUTCMonth() - (MONTHS[range] - 1), 1);
  const months: { month: string; opened: number; merged: number }[] = [];
  for (let d = new Date(start); d.getTime() <= now; d = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)))
    months.push({ month: d.toISOString().slice(0, 7), opened: 0, merged: 0 });
  const key = (at: number) => new Date(at).toISOString().slice(0, 7);
  const [rows, totals, conflicted] = await db.batch([
    db
      .select({ createdAt: pullRequests.createdAt, mergedAt: pullRequests.mergedAt, status: pullRequests.status })
      .from(pullRequests)
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          or(sql`${pullRequests.createdAt} >= ${start}`, sql`${pullRequests.mergedAt} >= ${start}`),
        ),
      )
      .limit(5000),
    db
      .select({ status: pullRequests.status, n: count() })
      .from(pullRequests)
      .where(eq(pullRequests.repositoryId, repositoryId))
      .groupBy(pullRequests.status),
    db
      .select({ n: count() })
      .from(pullRequests)
      .innerJoin(
        pullRequestSnapshots,
        and(
          eq(pullRequestSnapshots.pullRequestId, pullRequests.id),
          eq(pullRequestSnapshots.version, pullRequests.comparisonVersion),
        ),
      )
      .where(
        and(
          eq(pullRequests.repositoryId, repositoryId),
          eq(pullRequests.status, 'open'),
          eq(pullRequestSnapshots.mergeability, 'conflicts'),
        ),
      ),
  ]);
  const byMonth = new Map(months.map((m) => [m.month, m]));
  const durations: number[] = [];
  for (const row of rows) {
    if (row.createdAt >= start) {
      const month = byMonth.get(key(row.createdAt));
      if (month) month.opened++;
    }
    if (row.mergedAt && row.mergedAt >= start) {
      const month = byMonth.get(key(row.mergedAt));
      if (month) month.merged++;
      durations.push(row.mergedAt - row.createdAt);
    }
  }
  durations.sort((a, b) => a - b);
  const mid = Math.floor(durations.length / 2);
  const counts = { open: 0, merged: 0, closed: 0 };
  for (const row of totals) counts[row.status] = row.n;
  return {
    months,
    counts,
    medianMergeMs: durations.length
      ? durations.length % 2
        ? durations[mid]!
        : (durations[mid - 1]! + durations[mid]!) / 2
      : null,
    merges: durations.length,
    openWithConflicts: conflicted[0]?.n ?? 0,
  };
}
