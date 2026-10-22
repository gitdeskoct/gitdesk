import { randomUUID } from 'node:crypto';
import type {
  CommentAnchor,
  PullAuthor,
  PullCounts,
  PullEvent,
  PullEventType,
  PullRequest,
  PullSnapshot,
  PullStatRange,
  ReviewDecision,
} from '../../shared/pulls';
import { PULL_PAGE } from '../../shared/pulls';
import { transaction, type AppDatabase } from '../db/database';
import {
  decodeCursor,
  emptyMonths,
  encodeCursor,
  median,
  monthKey,
  PullNotFound,
  rangeStart,
  type PullRecords,
  type ReportedEvent,
  type StoredComment,
  type StoredReview,
} from './records';

// Pull request records for a repository that isn't linked to the account. They live in gitdesk's
// own SQLite file on this computer and work offline.

type PullRow = {
  id: string;
  number: number;
  title: string;
  description: string;
  source_ref: string;
  target_ref: string;
  status: PullRequest['status'];
  is_draft: number;
  author_json: string;
  created_at: number;
  updated_at: number;
  closed_at: number | null;
  merged_at: number | null;
  merge_commit_oid: string | null;
};
type SnapshotRow = {
  version: number;
  source_oid: string;
  target_oid: string;
  merge_base_oid: string | null;
  mergeability: PullSnapshot['mergeability'];
  reason: PullSnapshot['reason'];
  conflicts_json: string;
  checked_at: number | null;
};

const PAGE_EVENTS = 30;

function parseJson<T>(text: string | null, fallback: T): T {
  if (!text) return fallback;
  try {
    return JSON.parse(text) as T;
  } catch {
    return fallback;
  }
}

const isCursor = (value: unknown): value is [number, string] =>
  Array.isArray(value) &&
  value.length === 2 &&
  Number.isInteger(value[0]) &&
  typeof value[1] === 'string';
const isEventCursor = (value: unknown): value is [number] =>
  Array.isArray(value) && value.length === 1 && Number.isInteger(value[0]);

const likeEscape = (text: string) => text.replace(/[\\%_]/g, (c) => `\\${c}`);

export function createLocalRecords(
  db: AppDatabase,
  repositoryId: string,
  now: () => number = Date.now,
): PullRecords {
  const snapshotOf = (pullId: string): PullSnapshot | null => {
    const row = db
      .prepare(
        `SELECT version, source_oid, target_oid, merge_base_oid, mergeability, reason, conflicts_json, checked_at
         FROM pull_snapshots WHERE pull_id = ? ORDER BY version DESC LIMIT 1`,
      )
      .get(pullId) as SnapshotRow | undefined;
    return row
      ? {
          version: row.version,
          sourceOid: row.source_oid,
          targetOid: row.target_oid,
          mergeBaseOid: row.merge_base_oid,
          mergeability: row.mergeability,
          reason: row.reason,
          conflicts: parseJson<string[]>(row.conflicts_json, []),
          checkedAt: row.checked_at,
        }
      : null;
  };

  function toPull(row: PullRow): PullRequest {
    const latest = snapshotOf(row.id);
    const counts = db
      .prepare(
        `SELECT COUNT(*) AS comments,
                SUM(CASE WHEN parent_id IS NULL AND resolved_at IS NULL AND deleted_at IS NULL THEN 1 ELSE 0 END) AS unresolved
         FROM pull_comments WHERE pull_id = ? AND deleted_at IS NULL`,
      )
      .get(row.id) as { comments: number; unresolved: number | null };
    const review = db
      .prepare(
        `SELECT decision, version FROM pull_reviews WHERE pull_id = ? AND decision != 'commented'
         ORDER BY submitted_at DESC LIMIT 1`,
      )
      .get(row.id) as { decision: ReviewDecision; version: number } | undefined;
    return {
      id: row.id,
      number: row.number,
      store: 'local',
      repositoryId,
      title: row.title,
      description: row.description,
      sourceRef: row.source_ref,
      targetRef: row.target_ref,
      status: row.status,
      isDraft: row.is_draft === 1,
      author: parseJson<PullAuthor>(row.author_json, {
        accountId: null,
        name: 'You',
        avatarUrl: null,
      }),
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      closedAt: row.closed_at,
      mergedAt: row.merged_at,
      mergeCommitOid: row.merge_commit_oid,
      latest,
      comments: counts.comments,
      unresolved: counts.unresolved ?? 0,
      review: review
        ? {
            decision: review.decision,
            version: review.version,
            stale: !!latest && review.version < latest.version,
          }
        : null,
    };
  }

  function rowOf(id: string): PullRow {
    const row = db
      .prepare('SELECT * FROM pull_requests WHERE id = ? AND repository_id = ?')
      .get(id, repositoryId) as PullRow | undefined;
    if (!row) throw new PullNotFound();
    return row;
  }

  function event(
    pullId: string,
    type: PullEventType,
    actor: PullAuthor,
    detail: string | null,
  ) {
    db.prepare(
      'INSERT INTO pull_activity (pull_id, event_type, actor_json, detail, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(pullId, type, JSON.stringify(actor), detail, now());
  }

  const touch = (id: string) =>
    db
      .prepare('UPDATE pull_requests SET updated_at = ? WHERE id = ?')
      .run(now(), id);

  function counts(): PullCounts {
    const rows = db
      .prepare(
        'SELECT status, COUNT(*) AS n FROM pull_requests WHERE repository_id = ? GROUP BY status',
      )
      .all(repositoryId) as { status: PullRequest['status']; n: number }[];
    const result: PullCounts = { open: 0, merged: 0, closed: 0 };
    for (const row of rows) result[row.status] = row.n;
    return result;
  }

  function commentOf(id: string, commentId: string): StoredComment {
    const row = db
      .prepare('SELECT * FROM pull_comments WHERE id = ? AND pull_id = ?')
      .get(commentId, id) as
      | {
          id: string;
          parent_id: string | null;
          author_json: string;
          body: string;
          anchor_json: string | null;
          created_at: number;
          updated_at: number;
          deleted_at: number | null;
          resolved_at: number | null;
        }
      | undefined;
    if (!row) throw new PullNotFound();
    return {
      id: row.id,
      parentId: row.parent_id,
      author: parseJson<PullAuthor>(row.author_json, {
        accountId: null,
        name: 'You',
        avatarUrl: null,
      }),
      body: row.deleted_at ? '' : row.body,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      deleted: row.deleted_at !== null,
      resolved: row.resolved_at !== null,
      anchor: parseJson<CommentAnchor | null>(row.anchor_json, null),
    };
  }

  return {
    store: 'local',

    async list(input) {
      const after = decodeCursor(input.cursor, isCursor);
      const q = input.q.trim();
      const number = /^#?(\d{1,9})$/.exec(q)?.[1];
      const like = `%${likeEscape(q)}%`;
      const rows = db
        .prepare(
          `SELECT * FROM pull_requests
           WHERE repository_id = ? AND status = ?
             AND (? = '' OR title LIKE ? ESCAPE '\\' OR source_ref LIKE ? ESCAPE '\\' OR target_ref LIKE ? ESCAPE '\\' OR number = ?)
             AND (? IS NULL OR updated_at < ? OR (updated_at = ? AND id < ?))
           ORDER BY updated_at DESC, id DESC LIMIT ?`,
        )
        .all(
          repositoryId,
          input.status,
          q,
          like,
          like,
          like,
          number ? Number(number) : -1,
          after ? after[0] : null,
          after ? after[0] : 0,
          after ? after[0] : 0,
          after ? after[1] : '',
          PULL_PAGE + 1,
        ) as PullRow[];
      const page = rows.slice(0, PULL_PAGE);
      const last = page[page.length - 1];
      return {
        pulls: page.map(toPull),
        nextCursor:
          rows.length > PULL_PAGE && last
            ? encodeCursor([last.updated_at, last.id])
            : null,
        counts: counts(),
      };
    },

    async get(id) {
      const row = db
        .prepare(
          'SELECT * FROM pull_requests WHERE id = ? AND repository_id = ?',
        )
        .get(id, repositoryId) as PullRow | undefined;
      return row ? toPull(row) : null;
    },

    async create(input) {
      const existing = db
        .prepare(
          'SELECT * FROM pull_requests WHERE repository_id = ? AND idempotency_key = ?',
        )
        .get(repositoryId, input.key) as PullRow | undefined;
      if (existing) return toPull(existing);
      const id = randomUUID();
      const at = now();
      transaction(db, () => {
        // The number is allocated in the insert itself, so two creates can't take the same one.
        db.prepare(
          `INSERT INTO pull_requests
             (id, repository_id, number, title, description, source_ref, target_ref, status, is_draft,
              author_json, idempotency_key, created_at, updated_at)
           SELECT ?, ?, COALESCE(MAX(number), 0) + 1, ?, ?, ?, ?, 'open', ?, ?, ?, ?, ?
           FROM pull_requests WHERE repository_id = ?`,
        ).run(
          id,
          repositoryId,
          input.title,
          input.description,
          input.sourceRef,
          input.targetRef,
          input.draft ? 1 : 0,
          JSON.stringify(input.author),
          input.key,
          at,
          at,
          repositoryId,
        );
        event(
          id,
          'created',
          input.author,
          `${input.sourceRef} → ${input.targetRef}`,
        );
      });
      return toPull(rowOf(id));
    },

    async update(id, patch, actor) {
      const row = rowOf(id);
      transaction(db, () => {
        db.prepare(
          `UPDATE pull_requests SET title = ?, description = ?, is_draft = ?, updated_at = ? WHERE id = ?`,
        ).run(
          patch.title ?? row.title,
          patch.description ?? row.description,
          patch.draft === undefined ? row.is_draft : patch.draft ? 1 : 0,
          now(),
          id,
        );
        event(
          id,
          'edited',
          actor,
          patch.title && patch.title !== row.title ? patch.title : null,
        );
      });
      return toPull(rowOf(id));
    },

    async setStatus(id, status, actor) {
      const row = rowOf(id);
      if (row.status === 'merged')
        throw new Error('A merged pull request stays merged.');
      if (row.status === status) return toPull(row);
      transaction(db, () => {
        db.prepare(
          'UPDATE pull_requests SET status = ?, closed_at = ?, updated_at = ? WHERE id = ?',
        ).run(status, status === 'closed' ? now() : null, now(), id);
        event(id, status === 'closed' ? 'closed' : 'reopened', actor, null);
      });
      return toPull(rowOf(id));
    },

    async recordComparison(id, snapshot, actor) {
      rowOf(id);
      const latest = snapshotOf(id);
      if (
        latest &&
        latest.sourceOid === snapshot.sourceOid &&
        latest.targetOid === snapshot.targetOid
      )
        return toPull(rowOf(id));
      const version = (latest?.version ?? 0) + 1;
      transaction(db, () => {
        db.prepare(
          `INSERT INTO pull_snapshots (pull_id, version, source_oid, target_oid, merge_base_oid, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          version,
          snapshot.sourceOid,
          snapshot.targetOid,
          snapshot.mergeBaseOid,
          now(),
        );
        if (latest)
          event(
            id,
            'comparison_updated',
            actor,
            `${version}:${snapshot.sourceOid}:${snapshot.targetOid}`,
          );
        touch(id);
      });
      return toPull(rowOf(id));
    },

    async recordCheck(id, version, check, actor) {
      rowOf(id);
      transaction(db, () => {
        const changed = db
          .prepare(
            `UPDATE pull_snapshots SET mergeability = ?, reason = ?, conflicts_json = ?, checked_at = ?
             WHERE pull_id = ? AND version = ?`,
          )
          .run(
            check.mergeability,
            check.reason,
            JSON.stringify(check.conflicts),
            now(),
            id,
            version,
          );
        if (changed.changes)
          event(
            id,
            'mergeability_checked',
            actor,
            `${version}:${check.mergeability}:${check.conflicts.length}`,
          );
      });
      return toPull(rowOf(id));
    },

    async reviews(id) {
      rowOf(id);
      return (
        db
          .prepare(
            'SELECT * FROM pull_reviews WHERE pull_id = ? ORDER BY submitted_at DESC',
          )
          .all(id) as {
          id: string;
          decision: ReviewDecision;
          body: string;
          version: number;
          source_oid: string;
          target_oid: string;
          author_json: string;
          submitted_at: number;
        }[]
      ).map((row) => ({
        id: row.id,
        decision: row.decision,
        body: row.body,
        version: row.version,
        sourceOid: row.source_oid,
        targetOid: row.target_oid,
        author: parseJson<PullAuthor>(row.author_json, {
          accountId: null,
          name: 'You',
          avatarUrl: null,
        }),
        submittedAt: row.submitted_at,
      }));
    },

    async addReview(id, input) {
      rowOf(id);
      const review: StoredReview = {
        ...input,
        id: randomUUID(),
        submittedAt: now(),
      };
      transaction(db, () => {
        db.prepare(
          `INSERT INTO pull_reviews (id, pull_id, decision, body, version, source_oid, target_oid, author_json, submitted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          review.id,
          id,
          review.decision,
          review.body,
          review.version,
          review.sourceOid,
          review.targetOid,
          JSON.stringify(review.author),
          review.submittedAt,
        );
        event(
          id,
          'reviewed',
          input.author,
          `${review.decision}:${review.version}`,
        );
        touch(id);
      });
      return review;
    },

    async comments(id) {
      rowOf(id);
      const ids = db
        .prepare(
          'SELECT id FROM pull_comments WHERE pull_id = ? ORDER BY created_at, id',
        )
        .all(id) as { id: string }[];
      return ids.map((row) => commentOf(id, row.id));
    },

    async addComment(id, input) {
      rowOf(id);
      if (input.parentId) {
        const parent = commentOf(id, input.parentId);
        if (parent.parentId)
          throw new Error('Replies go to the first comment of a thread.');
      }
      const commentId = randomUUID();
      const at = now();
      transaction(db, () => {
        db.prepare(
          `INSERT INTO pull_comments (id, pull_id, parent_id, author_json, body, anchor_json, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          commentId,
          id,
          input.parentId,
          JSON.stringify(input.author),
          input.body,
          input.anchor ? JSON.stringify(input.anchor) : null,
          at,
          at,
        );
        event(
          id,
          'commented',
          input.author,
          input.anchor
            ? `${input.anchor.path}:${input.anchor.newLine ?? input.anchor.oldLine}`
            : null,
        );
        touch(id);
      });
      return commentOf(id, commentId);
    },

    async editComment(id, commentId, patch) {
      const comment = commentOf(id, commentId);
      if (comment.deleted) throw new Error('That comment was deleted.');
      db.prepare(
        `UPDATE pull_comments SET body = ?, resolved_at = ?, updated_at = ? WHERE id = ?`,
      ).run(
        patch.body ?? comment.body,
        patch.resolved === undefined
          ? comment.resolved
            ? now()
            : null
          : patch.resolved
            ? now()
            : null,
        now(),
        commentId,
      );
      return commentOf(id, commentId);
    },

    async deleteComment(id, commentId) {
      commentOf(id, commentId);
      // Soft delete keeps a thread's replies in place under "Comment deleted".
      db.prepare(
        "UPDATE pull_comments SET deleted_at = ?, body = '', updated_at = ? WHERE id = ? AND deleted_at IS NULL",
      ).run(now(), now(), commentId);
    },

    async activity(id, cursor) {
      rowOf(id);
      const before = decodeCursor(cursor, isEventCursor);
      const rows = db
        .prepare(
          `SELECT id, event_type, actor_json, detail, created_at FROM pull_activity
           WHERE pull_id = ? AND (? IS NULL OR id < ?) ORDER BY id DESC LIMIT ?`,
        )
        .all(
          id,
          before ? before[0] : null,
          before ? before[0] : 0,
          PAGE_EVENTS + 1,
        ) as {
        id: number;
        event_type: PullEventType;
        actor_json: string;
        detail: string | null;
        created_at: number;
      }[];
      const page = rows.slice(0, PAGE_EVENTS);
      const events: PullEvent[] = page.map((row) => ({
        id: String(row.id),
        type: row.event_type,
        actor: parseJson<PullAuthor>(row.actor_json, {
          accountId: null,
          name: 'You',
          avatarUrl: null,
        }),
        detail: row.detail,
        createdAt: row.created_at,
      }));
      const last = page[page.length - 1];
      return {
        events,
        nextCursor:
          rows.length > PAGE_EVENTS && last ? encodeCursor([last.id]) : null,
      };
    },

    async recordEvent(id, type: ReportedEvent, detail, actor) {
      rowOf(id);
      event(id, type, actor, detail);
    },

    async recordMerge(id, input, actor) {
      const row = rowOf(id);
      if (row.status === 'merged') return toPull(row);
      transaction(db, () => {
        db.prepare(
          `UPDATE pull_requests SET status = 'merged', merged_at = ?, merge_commit_oid = ?, merge_operation_id = ?,
             closed_at = NULL, updated_at = ? WHERE id = ?`,
        ).run(now(), input.mergeCommitOid, input.operationId, now(), id);
        event(id, 'merged', actor, input.mergeCommitOid);
      });
      return toPull(rowOf(id));
    },

    async stats(range: PullStatRange) {
      const at = now();
      const since = rangeStart(range, at).getTime();
      const months = emptyMonths(range, at);
      const byMonth = new Map(months.map((m) => [m.month, m]));
      const rows = db
        .prepare(
          `SELECT created_at, merged_at FROM pull_requests
           WHERE repository_id = ? AND (created_at >= ? OR merged_at >= ?)`,
        )
        .all(repositoryId, since, since) as {
        created_at: number;
        merged_at: number | null;
      }[];
      for (const row of rows) {
        if (row.created_at >= since) {
          const month = byMonth.get(monthKey(row.created_at));
          if (month) month.opened++;
        }
        if (row.merged_at && row.merged_at >= since) {
          const month = byMonth.get(monthKey(row.merged_at));
          if (month) month.merged++;
        }
      }
      const durations = (
        db
          .prepare(
            `SELECT merged_at - created_at AS ms FROM pull_requests
             WHERE repository_id = ? AND status = 'merged' AND merged_at >= ?`,
          )
          .all(repositoryId, since) as { ms: number }[]
      ).map((row) => row.ms);
      const conflicted = db
        .prepare(
          `SELECT COUNT(*) AS n FROM pull_requests p
           JOIN pull_snapshots s ON s.pull_id = p.id
             AND s.version = (SELECT MAX(version) FROM pull_snapshots WHERE pull_id = p.id)
           WHERE p.repository_id = ? AND p.status = 'open' AND s.mergeability = 'conflicts'`,
        )
        .get(repositoryId) as { n: number };
      return {
        months,
        counts: counts(),
        medianMergeMs: median(durations),
        merges: durations.length,
        openWithConflicts: conflicted.n,
      };
    },
  };
}

// Files marked viewed belong to one snapshot of one pull request, local or account.
export function createViewedStore(db: AppDatabase) {
  return {
    list(pullId: string, version: number): string[] {
      return (
        db
          .prepare(
            'SELECT path FROM pull_viewed WHERE pull_key = ? AND version = ? ORDER BY path',
          )
          .all(pullId, version) as { path: string }[]
      ).map((row) => row.path);
    },
    set(pullId: string, version: number, path: string, viewed: boolean): void {
      if (viewed)
        db.prepare(
          'INSERT OR IGNORE INTO pull_viewed (pull_key, version, path) VALUES (?, ?, ?)',
        ).run(pullId, version, path);
      else
        db.prepare(
          'DELETE FROM pull_viewed WHERE pull_key = ? AND version = ? AND path = ?',
        ).run(pullId, version, path);
    },
  };
}
