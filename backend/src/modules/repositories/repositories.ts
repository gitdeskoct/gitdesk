import { and, count, desc, eq, lt, or } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { repositories } from '../../db/schema';

// A personal account on the free plan: a cap keeps one runaway client from filling D1.
export const MAX_REPOSITORIES_PER_ACCOUNT = 200;

type Row = typeof repositories.$inferSelect;

export const toRemote = (row: Row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  visibility: 'private' as const,
  defaultBranch: row.defaultBranch,
  createdAt: row.createdAt,
  updatedAt: row.updatedAt,
});

// Two indexed reads in one round trip: a count over the owner's index range and the five most
// recent rows. Nothing here touches R2.
export async function overview(db: Db, accountId: string) {
  const [totals, recent] = await db.batch([
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
  ]);
  return { total: totals[0]?.total ?? 0, recent: recent.map(toRemote) };
}

// Keyset pagination on (updated_at, id): stable under inserts, and each page reads only its rows.
const encodeCursor = (row: Row) =>
  btoa(`${row.updatedAt}:${row.id}`)
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');

function decodeCursor(cursor: string): { updatedAt: number; id: string } | null {
  try {
    const [time, id] = atob(cursor.replace(/-/g, '+').replace(/_/g, '/')).split(':');
    const updatedAt = Number(time);
    return Number.isSafeInteger(updatedAt) && id ? { updatedAt, id } : null;
  } catch {
    return null;
  }
}

export async function listPage(
  db: Db,
  accountId: string,
  input: { limit: number; cursor?: string },
) {
  const after = input.cursor ? decodeCursor(input.cursor) : null;
  const rows = await db
    .select()
    .from(repositories)
    .where(
      and(
        eq(repositories.ownerAccountId, accountId),
        after
          ? or(
              lt(repositories.updatedAt, after.updatedAt),
              and(eq(repositories.updatedAt, after.updatedAt), lt(repositories.id, after.id)),
            )
          : undefined,
      ),
    )
    .orderBy(desc(repositories.updatedAt), desc(repositories.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  return {
    repositories: page.map(toRemote),
    nextCursor: rows.length > input.limit ? encodeCursor(page[page.length - 1]!) : null,
  };
}

// Ownership is part of the lookup: an id alone never finds another account's repository.
export async function getOwned(db: Db, accountId: string, id: string) {
  const [row] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, id), eq(repositories.ownerAccountId, accountId)))
    .limit(1);
  return row ? toRemote(row) : null;
}

export type CreateResult =
  | { status: 'created'; repository: ReturnType<typeof toRemote> }
  | { status: 'name_taken' }
  | { status: 'limit' };

export async function createRepository(
  db: Db,
  accountId: string,
  input: { name: string; description: string | null },
  now: number,
): Promise<CreateResult> {
  const [existing] = await db
    .select({ total: count() })
    .from(repositories)
    .where(eq(repositories.ownerAccountId, accountId));
  if ((existing?.total ?? 0) >= MAX_REPOSITORIES_PER_ACCOUNT) return { status: 'limit' };

  const row: Row = {
    id: crypto.randomUUID(),
    ownerAccountId: accountId,
    name: input.name,
    nameKey: input.name.toLowerCase(),
    description: input.description,
    visibility: 'private',
    defaultBranch: 'main',
    createdAt: now,
    updatedAt: now,
  };
  // The unique (owner, name_key) index settles races: of two concurrent creates, one wins.
  const inserted = await db
    .insert(repositories)
    .values(row)
    .onConflictDoNothing({ target: [repositories.ownerAccountId, repositories.nameKey] })
    .returning({ id: repositories.id });
  if (!inserted.length) return { status: 'name_taken' };
  return { status: 'created', repository: toRemote(row) };
}
