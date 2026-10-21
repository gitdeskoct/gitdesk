import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { accounts, authIdentities } from '../../db/schema';
import type { GoogleProfile } from './google';

export type AccountSummary = {
  id: string;
  displayName: string;
  email: string;
  avatarUrl: string | null;
};

export const toSummary = (row: typeof accounts.$inferSelect): AccountSummary => ({
  id: row.id,
  displayName: row.displayName,
  email: row.email,
  avatarUrl: row.avatarUrl,
});

export async function getAccount(db: Db, id: string) {
  return db.query.accounts.findFirst({ where: eq(accounts.id, id) });
}

async function findByIdentity(db: Db, provider: string, subject: string) {
  const [row] = await db
    .select({ account: accounts })
    .from(authIdentities)
    .innerJoin(accounts, eq(accounts.id, authIdentities.accountId))
    .where(and(eq(authIdentities.provider, provider), eq(authIdentities.subject, subject)));
  return row?.account;
}

// Accounts are keyed by (provider, subject), never by email: emails change and can be reassigned.
export async function upsertGoogleAccount(
  db: Db,
  profile: GoogleProfile,
  now: number,
): Promise<AccountSummary> {
  const existing = await findByIdentity(db, 'google', profile.subject);
  if (existing) {
    const [updated] = await db
      .update(accounts)
      .set({
        displayName: profile.name,
        email: profile.email,
        avatarUrl: profile.picture,
        updatedAt: now,
      })
      .where(eq(accounts.id, existing.id))
      .returning();
    return toSummary(updated ?? existing);
  }

  const id = crypto.randomUUID();
  try {
    await db.batch([
      db.insert(accounts).values({
        id,
        displayName: profile.name,
        email: profile.email,
        avatarUrl: profile.picture,
        createdAt: now,
        updatedAt: now,
      }),
      db.insert(authIdentities).values({
        id: crypto.randomUUID(),
        accountId: id,
        provider: 'google',
        subject: profile.subject,
        email: profile.email,
        createdAt: now,
      }),
    ]);
  } catch (err) {
    // A concurrent first sign-in won the unique (provider, subject) race; the batch rolled back.
    const winner = await findByIdentity(db, 'google', profile.subject);
    if (winner) return toSummary(winner);
    throw err;
  }
  return {
    id,
    displayName: profile.name,
    email: profile.email,
    avatarUrl: profile.picture,
  };
}
