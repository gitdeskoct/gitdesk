import { and, desc, eq, lt, or, sql, type SQL } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { activity, repositories, type ACTIVITY_TYPES } from '../../db/schema';
import { encodeCursor } from '../../lib/cursor';

type Row = typeof activity.$inferSelect;

export const toActivity = (row: Row) => ({
  id: row.id,
  type: row.type,
  repositoryId: row.repositoryId,
  repositoryName: row.repositoryName,
  createdAt: row.createdAt,
});

export const recentActivity = (db: Db, accountId: string, limit: number) =>
  db
    .select()
    .from(activity)
    .where(eq(activity.accountId, accountId))
    .orderBy(desc(activity.createdAt), desc(activity.id))
    .limit(limit);

// Copies the repository matched by `where` into an activity row. Meant for the same db.batch as the
// write: when `where` matches nothing (not the owner's, or the write didn't happen), nothing is logged.
export const recordActivity = (
  db: Db,
  type: (typeof ACTIVITY_TYPES)[number],
  where: SQL | undefined,
  now: number,
) =>
  db.insert(activity).select(
    db
      .select({
        id: sql`${crypto.randomUUID()}`.as('id'),
        accountId: repositories.ownerAccountId,
        repositoryId: repositories.id,
        repositoryName: repositories.name,
        type: sql`${type}`.as('type'),
        createdAt: sql`${now}`.as('created_at'),
      })
      .from(repositories)
      .where(where),
  );

export async function listPage(
  db: Db,
  accountId: string,
  input: { limit: number; cursor?: [number, string] },
) {
  const [createdAt, id] = input.cursor ?? [];
  const rows = await db
    .select()
    .from(activity)
    .where(
      and(
        eq(activity.accountId, accountId),
        createdAt !== undefined && id !== undefined
          ? or(
              lt(activity.createdAt, createdAt),
              and(eq(activity.createdAt, createdAt), lt(activity.id, id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(activity.createdAt), desc(activity.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    activity: page.map(toActivity),
    nextCursor: rows.length > input.limit && last ? encodeCursor([last.createdAt, last.id]) : null,
  };
}
