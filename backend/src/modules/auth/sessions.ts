import { and, desc, eq, gt, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { sessions } from '../../db/schema';
import { randomToken, sha256 } from '../../lib/crypto';

export const REFRESH_IDLE_MS = 30 * 24 * 60 * 60_000;
export const SESSION_ABSOLUTE_MS = 90 * 24 * 60 * 60_000;

const active = (now: number) =>
  and(isNull(sessions.revokedAt), gt(sessions.idleExpiresAt, now), gt(sessions.expiresAt, now));

export async function createSession(
  db: Db,
  input: { accountId: string; deviceName: string },
  now: number,
) {
  const id = crypto.randomUUID();
  const refreshToken = randomToken();
  await db.insert(sessions).values({
    id,
    accountId: input.accountId,
    refreshHash: await sha256(refreshToken),
    deviceName: input.deviceName,
    createdAt: now,
    lastUsedAt: now,
    idleExpiresAt: now + REFRESH_IDLE_MS,
    expiresAt: now + SESSION_ABSOLUTE_MS,
  });
  return { sessionId: id, refreshToken };
}

export type RotateResult =
  | { status: 'rotated'; sessionId: string; accountId: string; refreshToken: string }
  | { status: 'reused'; sessionId: string; accountId: string }
  | { status: 'invalid' };

// The WHERE on the current hash makes rotation a compare-and-swap: concurrent refreshes with
// the same token can't both match. A token that only matches the previous hash is a replay.
export async function rotateRefreshToken(
  db: Db,
  refreshToken: string,
  now: number,
): Promise<RotateResult> {
  const oldHash = await sha256(refreshToken);
  const next = randomToken();
  const [rotated] = await db
    .update(sessions)
    .set({
      refreshHash: await sha256(next),
      previousRefreshHash: oldHash,
      lastUsedAt: now,
      idleExpiresAt: now + REFRESH_IDLE_MS,
    })
    .where(and(eq(sessions.refreshHash, oldHash), active(now)))
    .returning({ id: sessions.id, accountId: sessions.accountId });
  if (rotated) {
    return { status: 'rotated', sessionId: rotated.id, accountId: rotated.accountId, refreshToken: next };
  }

  const [reused] = await db
    .update(sessions)
    .set({ revokedAt: now, revokedReason: 'refresh_reuse' })
    .where(and(eq(sessions.previousRefreshHash, oldHash), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id, accountId: sessions.accountId });
  return reused
    ? { status: 'reused', sessionId: reused.id, accountId: reused.accountId }
    : { status: 'invalid' };
}

export async function revokeByRefreshToken(db: Db, refreshToken: string, now: number) {
  const [row] = await db
    .update(sessions)
    .set({ revokedAt: now, revokedReason: 'logout' })
    .where(and(eq(sessions.refreshHash, await sha256(refreshToken)), isNull(sessions.revokedAt)))
    .returning({ id: sessions.id, accountId: sessions.accountId });
  return row;
}

export const getActiveSession = (db: Db, id: string, now: number) =>
  db.query.sessions.findFirst({ where: and(eq(sessions.id, id), active(now)) });

export const listActiveSessions = (db: Db, accountId: string, now: number) =>
  db
    .select({
      id: sessions.id,
      deviceName: sessions.deviceName,
      createdAt: sessions.createdAt,
      lastUsedAt: sessions.lastUsedAt,
    })
    .from(sessions)
    .where(and(eq(sessions.accountId, accountId), active(now)))
    .orderBy(desc(sessions.lastUsedAt))
    .limit(100);

export async function revokeOwnedSession(
  db: Db,
  accountId: string,
  sessionId: string,
  now: number,
): Promise<boolean> {
  const rows = await db
    .update(sessions)
    .set({ revokedAt: now, revokedReason: 'revoked_by_user' })
    .where(
      and(eq(sessions.id, sessionId), eq(sessions.accountId, accountId), isNull(sessions.revokedAt)),
    )
    .returning({ id: sessions.id });
  return rows.length > 0;
}
