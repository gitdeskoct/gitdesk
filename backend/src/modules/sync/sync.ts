import { and, count, desc, eq, gte, lt, or, sql } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { repositories, repositoryBranches, syncEvents } from '../../db/schema';
import { encodeCursor } from '../../lib/cursor';
import type { GitHost } from '../../lib/git-host';
import { logEvent } from '../../lib/log';

export type RefReport =
  | { operationId: string; kind: 'push'; ref: string; oldOid: string | null; newOid: string }
  | { operationId: string; kind: 'delete'; ref: string; oldOid: string | null; newOid: null };

export type RecordResult =
  | { status: 'recorded'; result: 'confirmed' | 'unverified'; tip: string | null }
  | { status: 'not_found' }
  | { status: 'conflict' };

// The desktop says it pushed or deleted a branch; the server checks Artifacts. A push is confirmed
// when the commit is stored there, whatever was pushed after it; a deletion when the branch has no
// tip any more. Hosting off, or Artifacts not answering, leaves the event unverified rather than
// failing the report. One row per operation id: a retry returns it. The branch index changes only
// for a confirmed event.
export async function recordRefEvent(
  db: Db,
  git: GitHost | null,
  accountId: string,
  repositoryId: string,
  input: RefReport,
  now: number,
): Promise<RecordResult> {
  const [row] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, repositoryId), eq(repositories.ownerAccountId, accountId)))
    .limit(1);
  if (!row) return { status: 'not_found' };
  const known = async () => {
    const [existing] = await db
      .select()
      .from(syncEvents)
      .where(eq(syncEvents.operationId, input.operationId))
      .limit(1);
    if (!existing) return null;
    // Operation ids are random per push; the same id under another repository or account is a misuse.
    if (existing.repositoryId !== repositoryId || existing.accountId !== accountId)
      return { status: 'conflict' as const };
    return { status: 'recorded' as const, result: existing.result, tip: existing.tip };
  };
  const earlier = await known();
  if (earlier) return earlier;

  let result: 'confirmed' | 'unverified' = 'unverified';
  let tip: string | null = null;
  if (git && row.gitRemote && row.status === 'ready') {
    try {
      if (input.kind === 'delete') {
        tip = await git.tip(row.id, input.ref);
        result = tip === null ? 'confirmed' : 'unverified';
      } else {
        const [stored, current] = await Promise.all([
          git.hasCommit(row.id, input.newOid),
          git.tip(row.id, input.ref),
        ]);
        result = stored ? 'confirmed' : 'unverified';
        tip = current;
      }
    } catch (err) {
      logEvent('sync_verify_failed', { accountId, error: String(err) }, 'warn');
    }
  }
  await db
    .insert(syncEvents)
    .values({
      operationId: input.operationId,
      repositoryId,
      accountId,
      kind: input.kind,
      ref: input.ref,
      oldOid: input.oldOid,
      newOid: input.newOid,
      result,
      tip,
      createdAt: now,
    })
    .onConflictDoNothing();
  const answer = (await known()) ?? { status: 'recorded' as const, result, tip };
  // A concurrent retry may have written first; its row is the answer, and indexing it twice is harmless.
  if (answer.status === 'recorded' && answer.result === 'confirmed') {
    const name = input.ref.slice('refs/heads/'.length);
    const values =
      input.kind === 'delete'
        ? { oid: null, deletedAt: now }
        : { oid: answer.tip ?? input.newOid, deletedAt: null };
    await db
      .insert(repositoryBranches)
      .values({ repositoryId, name, updatedAt: now, ...values })
      .onConflictDoUpdate({
        target: [repositoryBranches.repositoryId, repositoryBranches.name],
        set: { updatedAt: now, ...values },
      });
  }
  return answer;
}

const WEEK_MS = 7 * 24 * 60 * 60_000;

// Monday 00:00 UTC of the week holding `at`.
export function utcWeekStart(at: number): number {
  const day = new Date(at);
  day.setUTCHours(0, 0, 0, 0);
  day.setUTCDate(day.getUTCDate() - ((day.getUTCDay() + 6) % 7));
  return day.getTime();
}

// Every recorded push of the account, newest first, keyset-paged on (created_at, operation_id).
export async function listPushes(
  db: Db,
  accountId: string,
  input: {
    limit: number;
    cursor?: [number, string];
    repositoryId?: string;
    result?: 'confirmed' | 'unverified';
  },
) {
  const after = input.cursor
    ? or(
        lt(syncEvents.createdAt, input.cursor[0]),
        and(eq(syncEvents.createdAt, input.cursor[0]), lt(syncEvents.operationId, input.cursor[1])),
      )
    : undefined;
  const rows = await db
    .select({
      operationId: syncEvents.operationId,
      repositoryId: syncEvents.repositoryId,
      repositoryName: repositories.name,
      kind: syncEvents.kind,
      ref: syncEvents.ref,
      oldOid: syncEvents.oldOid,
      newOid: syncEvents.newOid,
      result: syncEvents.result,
      tip: syncEvents.tip,
      createdAt: syncEvents.createdAt,
    })
    .from(syncEvents)
    .innerJoin(repositories, eq(repositories.id, syncEvents.repositoryId))
    .where(
      and(
        eq(syncEvents.accountId, accountId),
        // The list is of pushes; deletions are indexed on the branch instead.
        eq(syncEvents.kind, 'push'),
        input.repositoryId ? eq(syncEvents.repositoryId, input.repositoryId) : undefined,
        input.result ? eq(syncEvents.result, input.result) : undefined,
        after,
      ),
    )
    .orderBy(desc(syncEvents.createdAt), desc(syncEvents.operationId))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    events: page,
    nextCursor:
      rows.length > input.limit && last ? encodeCursor([last.createdAt, last.operationId]) : null,
  };
}

// Pushes per UTC week for the last 8 weeks, oldest first, counted in D1 rather than in the Worker.
export async function pushStats(db: Db, accountId: string, now: number) {
  const first = utcWeekStart(now) - 7 * WEEK_MS;
  const week = sql<number>`(${syncEvents.createdAt} - ${first}) / ${WEEK_MS}`;
  const rows = await db
    .select({ week, result: syncEvents.result, count: count() })
    .from(syncEvents)
    .where(
      and(
        eq(syncEvents.accountId, accountId),
        eq(syncEvents.kind, 'push'),
        gte(syncEvents.createdAt, first),
      ),
    )
    .groupBy(week, syncEvents.result);
  const weeks = Array.from({ length: 8 }, (_, i) => ({
    start: first + i * WEEK_MS,
    confirmed: 0,
    unverified: 0,
  }));
  for (const row of rows) {
    const bucket = weeks[Math.floor(Number(row.week))];
    if (bucket) bucket[row.result] += row.count;
  }
  return { weeks };
}
