import { and, asc, count, desc, eq, gt, inArray, lt, ne, or, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { Db } from '../../db/client';
import { accounts, repositories } from '../../db/schema';
import { encodeCursor } from '../../lib/cursor';
import type { GitHost, GitScope } from '../../lib/git-host';
import { logEvent } from '../../lib/log';
import { recentActivity, recordActivity, toActivity } from '../activity/activity';
import type { listQuery } from './schemas';

// A personal account on the free plan: a cap keeps one runaway client from filling D1.
export const MAX_REPOSITORIES_PER_ACCOUNT = 200;

// Provisioning or deletion that stopped this long ago is picked up by the daily job.
export const STALE_LIFECYCLE_MS = 10 * 60_000;

// Every key a repository owns sits under this prefix; nothing outside it is listed or deleted.
const STORAGE_KEY = /^repositories\/[0-9a-f-]{36}\/$/;

type Row = typeof repositories.$inferSelect;
type Remote = ReturnType<typeof toRemote>;

// Where a repository's data lives. git is null when the deployment has Git hosting off.
export type Storage = { bucket: R2Bucket; git: GitHost | null };

// storage_key stays server-side: clients address a repository by id only.
export const toRemote = (row: Row) => ({
  id: row.id,
  name: row.name,
  description: row.description,
  visibility: row.visibility,
  defaultBranch: row.defaultBranch,
  status: row.status,
  // A plain https URL with no credentials; safe to show and copy.
  gitUrl: row.gitRemote,
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
            status: sql<'provisioning'>`'provisioning'`.as('status'),
            statusAt: sql<number>`${now}`.as('status_at'),
            storageKey: sql<string>`${`repositories/${id}/`}`.as('storage_key'),
            // Insert-from-select needs every column; provisioning fills this in.
            gitRemote: sql<string | null>`null`.as('git_remote'),
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

export type ProvisionResult =
  | { status: 'done'; repository: Remote }
  | { status: 'not_found' }
  | { status: 'invalid_state' };

// D1, R2 and the git host can't commit together: the row exists first as `provisioning`, the
// storage marker and the Git repository are created, then the row moves to `ready` with its remote.
// A failed step leaves `failed`; retrying is safe because every step is idempotent. A `ready` row
// from before Git hosting was on gets its Git repository here too, without changing status.
export async function provisionRepository(
  db: Db,
  storage: Storage,
  accountId: string,
  id: string,
  now: number,
): Promise<ProvisionResult> {
  const [row] = await db.select().from(repositories).where(owned(accountId, id)).limit(1);
  if (!row) return { status: 'not_found' };
  if (row.status === 'deleting') return { status: 'invalid_state' };
  if (row.status === 'ready') {
    if (row.gitRemote || !storage.git) return { status: 'done', repository: toRemote(row) };
    return backfillRemote(db, storage.git, row);
  }
  if (!STORAGE_KEY.test(row.storageKey)) throw new Error('repository has no valid storage key');

  let gitRemote: string | null = null;
  let ok = true;
  try {
    await storage.bucket.put(
      `${row.storageKey}meta.json`,
      JSON.stringify({ repositoryId: row.id, createdAt: row.createdAt }),
      { httpMetadata: { contentType: 'application/json' } },
    );
    if (storage.git) gitRemote = await storage.git.ensure(row.id, row.defaultBranch);
  } catch (err) {
    ok = false;
    logEvent('repository_provision_failed', { accountId, error: String(err) }, 'warn');
  }
  const status = ok ? 'ready' : 'failed';
  const [updated] = await db.batch([
    db
      .update(repositories)
      .set({ status, statusAt: now, ...(gitRemote ? { gitRemote } : {}) })
      .where(and(owned(accountId, id), inArray(repositories.status, ['provisioning', 'failed'])))
      .returning(),
    // Matches only the row this call just moved, so a concurrent retry isn't logged twice.
    recordActivity(
      db,
      ok ? 'repository.provisioned' : 'repository.provisioning_failed',
      and(owned(accountId, id), eq(repositories.status, status), eq(repositories.statusAt, now)),
      now,
    ),
  ]);
  if (updated[0]) return { status: 'done', repository: toRemote(updated[0]) };
  const current = await getOwned(db, accountId, id);
  return current ? { status: 'done', repository: current } : { status: 'not_found' };
}

async function backfillRemote(db: Db, git: GitHost, row: Row): Promise<ProvisionResult> {
  let gitRemote;
  try {
    gitRemote = await git.ensure(row.id, row.defaultBranch);
  } catch (err) {
    // The metadata is still fine; the repository has no Git URL until a later retry works.
    const fields = { accountId: row.ownerAccountId, error: String(err) };
    logEvent('git_remote_backfill_failed', fields, 'warn');
    return { status: 'done', repository: toRemote(row) };
  }
  const [updated] = await db
    .update(repositories)
    .set({ gitRemote })
    .where(and(owned(row.ownerAccountId, row.id), eq(repositories.status, 'ready')))
    .returning();
  return updated ? { status: 'done', repository: toRemote(updated) } : { status: 'invalid_state' };
}

export type CredentialsResult =
  | { status: 'issued'; remote: string; token: string; scope: GitScope; expiresAt: number }
  | { status: 'not_found' }
  | { status: 'not_ready' }
  | { status: 'unavailable' };

// A token for one repository and one scope. The plaintext goes to the owner's client and nowhere
// else: it is not stored, logged or recorded as activity.
export async function gitCredentials(
  db: Db,
  git: GitHost | null,
  accountId: string,
  id: string,
  input: { scope: GitScope; lifetime: number },
): Promise<CredentialsResult> {
  const [row] = await db.select().from(repositories).where(owned(accountId, id)).limit(1);
  if (!row) return { status: 'not_found' };
  if (row.status !== 'ready') return { status: 'not_ready' };
  if (!git) return { status: 'unavailable' };
  let remote = row.gitRemote;
  if (!remote) {
    const filled = await backfillRemote(db, git, row);
    remote = filled.status === 'done' ? filled.repository.gitUrl : null;
    if (!remote) return { status: 'unavailable' };
  }
  const { token, expiresAt } = await git.token(row.id, input.scope, input.lifetime);
  return { status: 'issued', remote, token, scope: input.scope, expiresAt };
}

export type RevokeResult =
  | { status: 'revoked'; count: number }
  | { status: 'not_found' }
  | { status: 'unavailable' };

export async function revokeGitCredentials(
  db: Db,
  git: GitHost | null,
  accountId: string,
  id: string,
): Promise<RevokeResult> {
  const [row] = await db.select().from(repositories).where(owned(accountId, id)).limit(1);
  if (!row) return { status: 'not_found' };
  if (!git || !row.gitRemote) return { status: 'unavailable' };
  return { status: 'revoked', count: await git.revokeAll(row.id) };
}

export type UpdateResult =
  | { status: 'updated'; repository: Remote }
  | { status: 'not_found' }
  | { status: 'invalid_state' }
  | { status: 'name_taken' };

export async function updateRepository(
  db: Db,
  accountId: string,
  id: string,
  input: { name?: string; description?: string | null },
  now: number,
): Promise<UpdateResult> {
  // A repository on its way out takes no more edits.
  const where = and(owned(accountId, id), ne(repositories.status, 'deleting'));
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
    if (updated[0]) return { status: 'updated', repository: toRemote(updated[0]) };
    return (await getOwned(db, accountId, id))
      ? { status: 'invalid_state' }
      : { status: 'not_found' };
  } catch (err) {
    if (isUniqueViolation(err)) return { status: 'name_taken' };
    throw err;
  }
}

async function removeStored(bucket: R2Bucket, prefix: string): Promise<void> {
  if (!STORAGE_KEY.test(prefix)) throw new Error('refusing to delete outside a repository prefix');
  let cursor: string | undefined;
  do {
    const page = await bucket.list({ prefix, cursor, limit: 1000 });
    if (page.objects.length) await bucket.delete(page.objects.map((object) => object.key));
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
}

export type DeleteResult =
  | { status: 'deleted' }
  | { status: 'not_found' }
  | { status: 'incomplete'; repository: Remote };

// Storage goes before the row: a row that outlives its data can be retried, data without a row is orphaned.
async function finishDelete(db: Db, storage: Storage, row: Row, now: number): Promise<DeleteResult> {
  const where = owned(row.ownerAccountId, row.id);
  try {
    await removeStored(storage.bucket, row.storageKey);
    // Deleting the Git repository also revokes every token issued for it.
    if (storage.git) await storage.git.remove(row.id);
    else if (row.gitRemote)
      logEvent('git_repository_left_behind', { accountId: row.ownerAccountId }, 'warn');
  } catch (err) {
    const fields = { accountId: row.ownerAccountId, error: String(err) };
    logEvent('repository_delete_incomplete', fields, 'warn');
    await recordActivity(db, 'repository.deletion_failed', where, now);
    return { status: 'incomplete', repository: toRemote(row) };
  }
  await db.batch([
    // Logged first, while the row still exists; the delete then nulls its repository_id.
    recordActivity(db, 'repository.deleted', where, now),
    db.delete(repositories).where(where),
  ]);
  return { status: 'deleted' };
}

// Marks the row `deleting` first, so edits and provisioning stop while storage is cleared.
// Calling it again on a `deleting` row resumes the cleanup.
export async function deleteRepository(
  db: Db,
  storage: Storage,
  accountId: string,
  id: string,
  now: number,
): Promise<DeleteResult> {
  const [marked] = await db
    .update(repositories)
    .set({ status: 'deleting', statusAt: now })
    .where(owned(accountId, id))
    .returning();
  if (!marked) return { status: 'not_found' };
  return finishDelete(db, storage, marked, now);
}

// Daily: provisioning that never finished becomes `failed` so its owner can retry, and stalled
// deletions get another attempt. Bounded so one run stays well inside the cron CPU limit.
export async function resumeLifecycle(db: Db, storage: Storage, now: number): Promise<void> {
  const stale = now - STALE_LIFECYCLE_MS;
  await db
    .update(repositories)
    .set({ status: 'failed', statusAt: now })
    .where(and(eq(repositories.status, 'provisioning'), lt(repositories.statusAt, stale)));
  const stuck = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.status, 'deleting'), lt(repositories.statusAt, stale)))
    .limit(20);
  for (const row of stuck) await finishDelete(db, storage, row, now);
}
