import { and, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { desktopAuthCodes, oauthTransactions } from '../../db/schema';
import { randomToken, sha256 } from '../../lib/crypto';

export const OAUTH_TRANSACTION_TTL_MS = 10 * 60_000;
export const DESKTOP_CODE_TTL_MS = 60_000;

export type NewTransaction = {
  stateHash: string;
  nonce: string;
  googleCodeVerifier: string;
  desktopChallenge: string;
  desktopState: string;
  redirectPort: number;
};

export async function createOAuthTransaction(
  db: Db,
  tx: NewTransaction,
  now: number,
): Promise<void> {
  await db.insert(oauthTransactions).values({
    id: crypto.randomUUID(),
    ...tx,
    createdAt: now,
    expiresAt: now + OAUTH_TRANSACTION_TTL_MS,
  });
}

// One conditional UPDATE: of two concurrent callbacks only one gets a row back.
export async function consumeOAuthTransaction(db: Db, stateHash: string, now: number) {
  const [row] = await db
    .update(oauthTransactions)
    .set({ consumedAt: now })
    .where(
      and(
        eq(oauthTransactions.stateHash, stateHash),
        isNull(oauthTransactions.consumedAt),
        gt(oauthTransactions.expiresAt, now),
      ),
    )
    .returning();
  return row;
}

export async function createDesktopCode(
  db: Db,
  input: { accountId: string; desktopChallenge: string },
  now: number,
): Promise<string> {
  const code = randomToken();
  await db.insert(desktopAuthCodes).values({
    codeHash: await sha256(code),
    accountId: input.accountId,
    desktopChallenge: input.desktopChallenge,
    createdAt: now,
    expiresAt: now + DESKTOP_CODE_TTL_MS,
  });
  return code;
}

export async function consumeDesktopCode(db: Db, code: string, now: number) {
  const [row] = await db
    .update(desktopAuthCodes)
    .set({ consumedAt: now })
    .where(
      and(
        eq(desktopAuthCodes.codeHash, await sha256(code)),
        isNull(desktopAuthCodes.consumedAt),
        gt(desktopAuthCodes.expiresAt, now),
      ),
    )
    .returning({
      accountId: desktopAuthCodes.accountId,
      desktopChallenge: desktopAuthCodes.desktopChallenge,
    });
  return row;
}
