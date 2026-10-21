import { and, asc, count, desc, eq, gt, lt, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import { accounts, repositories } from '../../db/schema';
import { encodeCursor } from '../../lib/cursor';
import { recentActivity, recordActivity, toActivity } from '../activity/activity';
import type { listQuery } from './schemas';

// A personal account on the free plan: a cap keeps one runaway client from filling D1.
export const MAX_REPOSITORIES_PER_ACCOUNT = 200;

type Row = typeof repositories.$inferSelect;
type Remote = ReturnType<typeof toRemote>;

export const toRemote = (row: Row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  visibility: row.visibility,
  defaultBranch: row.defaultBranch,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

const owned = (accountId: string, id: string) =>
  and(eq(repositories.id, id), eq(repositories.ownerAccountId, accountId));

const isUniqueViolation = (err: unknown): boolean =>
  err instanceof Error &&
  (err.message.includes('UNIQUE constraint failed') || isUniqueViolation(err.cause));

// Indexed reads in one round trip: a count over the owner's index range, the five most recent
// repositories and the five latest activity rows. Nothing here touches R2.
export async function overview(db: Db, accountId: string) {
  const [totals, recent, activity] = await db.batch([
    db
      .select({ total: count() })
      .from(repositories)
      .where(eq(repositories.ownerAccountId, accountId)),
    db
      .select()
      .from(repositories)
      .where(eq(repositories.ownerAccountId, accountId))
      .orderBy(desc(repositories.updatedAt), desc(repositories.id))
      .limit(5),
    recentActivity(db, accountId, 5),
  ]);
  return {
    total: totals[0]?.total ?? 0,
    recent: recent.map(toRemote),
    recentActivity: activity.map(toActivity),
  };
}

// Keyset pagination: stable under inserts, and each page reads only its rows.
export async function listPage(db: Db, accountId: string, input: z.output<typeof listQuery>) {
  let after;
  if (input.sort === 'name' && input.cursor) {
    const [nameKey, id] = input.cursor;
    after = or(
      gt(repositories.nameKey, nameKey),
      and(eq(repositories.nameKey, nameKey), gt(repositories.id, id)),
    );
  } else if (input.sort === 'updated' && input.cursor) {
    const [updatedAt, id] = input.cursor;
    after = or(
      lt(repositories.updatedAt, updatedAt),
      and(eq(repositories.updatedAt, updatedAt), lt(repositories.id, id)),
    );
  }
  const rows = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.ownerAccountId, accountId), after))
    .orderBy(
      ...(input.sort === 'name'
        ? [asc(repositories.nameKey), asc(repositories.id)]
        : [desc(repositories.updatedAt), desc(repositories.id)]),
    )
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    repositories: page.map(toRemote),
    nextCursor:
      rows.length > input.limit && last
        ? encodeCursor([input.sort === 'name' ? last.nameKey : last.updatedAt, last.id])
        : null,
  };
}

// Ownership is part of the lookup: an id alone never finds another account's repository.
export async function getOwned(db: Db, accountId: string, id: string) {
  const [row] = await db.select().from(repositories).where(owned(accountId, id)).limit(1);
  return row ? toRemote(row) : null;
}

export type CreateResult =
  | { status: 'created'; repository: Remote }
  | { status: 'name_taken' }
  | { status: 'limit' };

export async function createRepository(
  db: Db,
  accountId: string,
  input: { name: string; description: string | null; idempotencyKey: string | null },
  now: number,
): Promise<CreateResult> {
  const id = crypto.randomUUID();
  const nameKey = input.name.toLowerCase();
  // The cap check and the insert are one statement, so concurrent creates can't overshoot it.
  // The unique (owner, name_key) and (owner, idempotency_key) indexes settle the other races.
  const [inserted] = await db.batch([
    db
      .insert(repositories)
      .select(
        db
          .select({
            id: sql<string>`${id}`.as('id'),
            ownerAccountId: accounts.id,
            name: sql<string>`${input.name}`.as('name'),
            nameKey: sql<string>`${nameKey}`.as('name_key'),
            description: sql<string | null>`${input.description}`.as('description'),
            visibility: sql<'private'>`'private'`.as('visibility'),
            defaultBranch: sql<string>`'main'`.as('default_branch'),
            createdAt: sql<number>`${now}`.as('created_at'),
            updatedAt: sql<number>`${now}`.as('updated_at'),
            idempotencyKey: sql<string | null>`${input.idempotencyKey}`.as('idempotency_key'),
          })
          .from(accounts)
          .where(
            and(
              eq(accounts.id, accountId),
              lt(
                db
                  .select({ total: count() })
                  .from(repositories)
                  .where(eq(repositories.ownerAccountId, accountId)),
                MAX_REPOSITORIES_PER_ACCOUNT,
              ),
            ),
          ),
      )
      .onConflictDoNothing()
      .returning(),
    recordActivity(db, 'repository.created', eq(repositories.id, id), now),
  ]);
  if (inserted[0]) return { status: 'created', repository: toRemote(inserted[0]) };

  // Nothing was inserted: a retry of an earlier create, a taken name, or the cap.
  const matches = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.ownerAccountId, accountId),
        or(
          eq(repositories.nameKey, nameKey),
          input.idempotencyKey ? eq(repositories.idempotencyKey, input.idempotencyKey) : undefined,
        ),
      ),
    );
  const original = input.idempotencyKey
    ? matches.find((row) => row.idempotencyKey === input.idempotencyKey)
    : undefined;
  if (original) return { status: 'created', repository: toRemote(original) };
  return { status: matches.length ? 'name_taken' : 'limit' };
}

export type UpdateResult =
  | { status: 'updated'; repository: Remote }
  | { status: 'not_found' }
  | { status: 'name_taken' };

export async function updateRepository(
  db: Db,
  accountId: string,
  id: string,
  input: { name?: string; description?: string | null },
  now: number,
): Promise<UpdateResult> {
  const where = owned(accountId, id);
  try {
    const [updated] = await db.batch([
      // Drizzle skips undefined fields, so only what the client sent changes.
      db
        .update(repositories)
        .set({
          name: input.name,
          nameKey: input.name?.toLowerCase(),
          description: input.description,
          updatedAt: now,
        })
        .where(where)
        .returning(),
      recordActivity(db, 'repository.updated', where, now),
    ]);
    return updated[0]
      ? { status: 'updated', repository: toRemote(updated[0]) }
      : { status: 'not_found' };
  } catch (err) {
    if (isUniqueViolation(err)) return { status: 'name_taken' };
    throw err;
  }
}

export async function deleteRepository(db: Db, accountId: string, id: string, now: number) {
  const where = owned(accountId, id);
  // shortcut: no R2 objects exist yet, delete them here once the sync transport stores any.
  const [, deleted] = await db.batch([
    // Logged first, while the row still exists; the delete then nulls its repository_id.
    recordActivity(db, 'repository.deleted', where, now),
    db.delete(repositories).where(where).returning({ id: repositories.id }),
  ]);
  return deleted.length > 0;
}
