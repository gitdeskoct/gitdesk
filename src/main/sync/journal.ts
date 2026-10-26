import { randomUUID } from 'node:crypto';
import type {
  PullStrategy,
  SyncActivityPage,
  SyncCode,
  SyncOperation,
  SyncOperationState,
} from '../../shared/sync';
import type { AppDatabase } from '../db/database';

// Sync operations share merge_operations with pull request merges, so the conflict screen finds a
// pull's merge the same way. For a sync row source_oid is the new commit and target_oid the old one.
type Row = {
  id: string;
  repository_id: string;
  display_name: string | null;
  kind: SyncOperation['kind'];
  state: SyncOperationState;
  strategy: string | null;
  source_oid: string;
  target_oid: string | null;
  remote: string | null;
  branch: string | null;
  error_code: string | null;
  message: string | null;
  server_result: string | null;
  created_at: number;
  updated_at: number;
};

const KINDS = "('fetch', 'pull', 'push', 'move', 'remote-delete')";
// Kept for half a year, and at most this many rows in all.
const KEEP_MS = 180 * 24 * 60 * 60_000;
const KEEP_ROWS = 2000;
const WEEK_MS = 7 * 24 * 60 * 60_000;

const SELECT = `SELECT o.*, r.display_name FROM merge_operations o
  LEFT JOIN local_repositories r ON r.id = o.repository_id`;

const toOperation = (row: Row): SyncOperation => ({
  id: row.id,
  repositoryId: row.repository_id,
  repositoryName: row.display_name ?? '',
  kind: row.kind,
  state: row.state,
  strategy: (row.strategy as PullStrategy | null) ?? null,
  remote: row.remote,
  branch: row.branch,
  oldOid: row.target_oid || null,
  newOid: row.source_oid || null,
  code: (row.error_code as SyncCode | null) ?? null,
  message: row.message,
  server:
    row.server_result === 'confirmed' || row.server_result === 'unverified'
      ? row.server_result
      : null,
  at: row.updated_at,
});

// Monday 00:00 local time of the week holding `at`.
function weekStart(at: number): number {
  const day = new Date(at);
  day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - ((day.getDay() + 6) % 7));
  return day.getTime();
}

export function createJournal(db: AppDatabase, now: () => number = Date.now) {
  const get = (id: string) =>
    db.prepare(`${SELECT} WHERE o.id = ?`).get(id) as Row | undefined;

  return {
    start(input: {
      repoId: string;
      kind: SyncOperation['kind'];
      state: SyncOperationState;
      remote?: string | null;
      branch?: string | null;
      oldOid?: string | null;
      newOid?: string | null;
      strategy?: PullStrategy | null;
      headRef?: string | null;
      commitMessage?: string | null;
    }): string {
      const id = randomUUID();
      db.prepare(
        `INSERT INTO merge_operations (id, repository_id, kind, state, strategy, source_oid, target_oid,
           remote, branch, head_ref, commit_message, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      ).run(
        id,
        input.repoId,
        input.kind,
        input.state,
        input.strategy ?? null,
        input.newOid ?? '',
        input.oldOid ?? null,
        input.remote ?? null,
        input.branch ?? null,
        input.headRef ?? null,
        input.commitMessage ?? null,
        now(),
        now(),
      );
      return id;
    },

    update(
      id: string,
      patch: {
        state?: SyncOperationState;
        code?: SyncCode | null;
        message?: string | null;
        newOid?: string;
        oldOid?: string | null;
        server?: 'confirmed' | 'unverified' | null;
        conflicts?: string[];
      },
    ): SyncOperation | null {
      const row = get(id);
      if (!row) return null;
      db.prepare(
        `UPDATE merge_operations SET state = ?, error_code = ?, message = ?, source_oid = ?,
           target_oid = ?, server_result = ?, conflicts_json = COALESCE(?, conflicts_json),
           updated_at = ? WHERE id = ?`,
      ).run(
        patch.state ?? row.state,
        patch.code === undefined ? row.error_code : patch.code,
        patch.message === undefined ? row.message : patch.message,
        patch.newOid ?? row.source_oid,
        patch.oldOid === undefined ? row.target_oid : patch.oldOid,
        patch.server === undefined ? row.server_result : patch.server,
        patch.conflicts ? JSON.stringify(patch.conflicts) : null,
        now(),
        id,
      );
      return toOperation(get(id)!);
    },

    get(id: string): SyncOperation | null {
      const row = get(id);
      return row &&
        ['fetch', 'pull', 'push', 'move', 'remote-delete'].includes(row.kind)
        ? toOperation(row)
        : null;
    },

    // A pull waiting on conflicts, or a push the remote hasn't settled.
    pending(repoId: string): SyncOperation | null {
      const row = db
        .prepare(
          `${SELECT} WHERE o.repository_id = ? AND o.kind IN ${KINDS}
             AND o.state IN ('merging', 'conflict_resolution', 'unknown', 'pushing')
           ORDER BY o.updated_at DESC LIMIT 1`,
        )
        .get(repoId) as Row | undefined;
      return row ? toOperation(row) : null;
    },

    recent(repoId: string, limit = 5): SyncOperation[] {
      return (
        db
          .prepare(
            `${SELECT} WHERE o.repository_id = ? AND o.kind IN ${KINDS}
             ORDER BY o.updated_at DESC, o.id DESC LIMIT ?`,
          )
          .all(repoId, limit) as Row[]
      ).map(toOperation);
    },

    page(input: {
      filter: 'all' | 'failed' | 'unconfirmed';
      offset: number;
      limit: number;
    }): SyncActivityPage {
      const where =
        input.filter === 'failed'
          ? `AND o.state IN ('failed', 'unknown')`
          : input.filter === 'unconfirmed'
            ? `AND o.kind = 'push' AND (o.server_result = 'unverified' OR o.state = 'report_pending')`
            : '';
      const { total } = db
        .prepare(
          `SELECT count(*) AS total FROM merge_operations o WHERE o.kind IN ${KINDS} ${where}`,
        )
        .get() as { total: number };
      const items = (
        db
          .prepare(
            `${SELECT} WHERE o.kind IN ${KINDS} ${where}
             ORDER BY o.updated_at DESC, o.id DESC LIMIT ? OFFSET ?`,
          )
          .all(input.limit, input.offset) as Row[]
      ).map(toOperation);
      const first = weekStart(now()) - 7 * WEEK_MS;
      const weeks = Array.from({ length: 8 }, (_, i) => ({
        start: first + i * WEEK_MS,
        confirmed: 0,
        other: 0,
      }));
      const pushes = db
        .prepare(
          `SELECT updated_at, state, server_result FROM merge_operations
           WHERE kind = 'push' AND updated_at >= ?`,
        )
        .all(first) as {
        updated_at: number;
        state: string;
        server_result: string | null;
      }[];
      for (const push of pushes) {
        const week = weeks.find(
          (w, i) =>
            push.updated_at >= w.start &&
            push.updated_at < (weeks[i + 1]?.start ?? Infinity),
        );
        if (!week) continue;
        // A push to another provider is confirmed by Git's own answer; one to the account's Git
        // URL also needs the server to have found the commit.
        if (push.state === 'completed' && push.server_result !== 'unverified')
          week.confirmed++;
        else week.other++;
      }
      return { items, total, weeks };
    },

    // Pushes the account hasn't been told about yet, oldest first.
    unreported(): SyncOperation[] {
      return (
        db
          .prepare(
            `${SELECT} WHERE o.kind IN ('push', 'remote-delete') AND o.state = 'report_pending' ORDER BY o.updated_at LIMIT 20`,
          )
          .all() as Row[]
      ).map(toOperation);
    },

    // Rows a crash left mid-way: a fetch simply failed, a push may or may not have landed.
    interrupted(): SyncOperation[] {
      return (
        db
          .prepare(
            `${SELECT} WHERE o.kind IN ('fetch', 'pull', 'push', 'remote-delete') AND o.state IN ('fetching', 'pushing', 'merging')`,
          )
          .all() as Row[]
      ).map(toOperation);
    },

    markFetched(repoId: string, remote: string): void {
      db.prepare(
        `INSERT INTO remote_marks (repository_id, remote, fetched_at) VALUES (?, ?, ?)
         ON CONFLICT (repository_id, remote) DO UPDATE SET fetched_at = excluded.fetched_at`,
      ).run(repoId, remote, now());
    },

    markPushed(repoId: string, remote: string): void {
      db.prepare(
        `INSERT INTO remote_marks (repository_id, remote, pushed_at) VALUES (?, ?, ?)
         ON CONFLICT (repository_id, remote) DO UPDATE SET pushed_at = excluded.pushed_at`,
      ).run(repoId, remote, now());
    },

    marks(
      repoId: string,
      remote: string,
    ): { fetchedAt: number | null; pushedAt: number | null } {
      const row = db
        .prepare(
          'SELECT fetched_at, pushed_at FROM remote_marks WHERE repository_id = ? AND remote = ?',
        )
        .get(repoId, remote) as
        | { fetched_at: number | null; pushed_at: number | null }
        | undefined;
      return {
        fetchedAt: row?.fetched_at ?? null,
        pushedAt: row?.pushed_at ?? null,
      };
    },

    prune(): void {
      db.prepare(
        `DELETE FROM merge_operations WHERE kind IN ${KINDS}
           AND state IN ('completed', 'failed', 'cancelled') AND updated_at < ?`,
      ).run(now() - KEEP_MS);
      db.prepare(
        `DELETE FROM merge_operations WHERE kind IN ${KINDS} AND id NOT IN (
           SELECT id FROM merge_operations WHERE kind IN ${KINDS}
           ORDER BY updated_at DESC LIMIT ?)`,
      ).run(KEEP_ROWS);
    },
  };
}

export type Journal = ReturnType<typeof createJournal>;
