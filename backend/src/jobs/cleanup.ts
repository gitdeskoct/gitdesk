import { lt, or } from 'drizzle-orm';
import type { Db } from '../db/client';
import { desktopAuthCodes, oauthTransactions, sessions } from '../db/schema';
import { logEvent } from '../lib/log';

const DAY_MS = 24 * 60 * 60_000;

export async function purgeExpired(db: Db, now: number): Promise<void> {
  await db.batch([
    db.delete(oauthTransactions).where(lt(oauthTransactions.expiresAt, now - DAY_MS)),
    db.delete(desktopAuthCodes).where(lt(desktopAuthCodes.expiresAt, now - DAY_MS)),
    db
      .delete(sessions)
      .where(
        or(
          lt(sessions.expiresAt, now - 7 * DAY_MS),
          lt(sessions.idleExpiresAt, now - 7 * DAY_MS),
          lt(sessions.revokedAt, now - 30 * DAY_MS),
        ),
      ),
  ]);
  logEvent('purge_expired_done');
}
