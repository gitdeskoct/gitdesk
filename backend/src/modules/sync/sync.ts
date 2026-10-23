import { and, eq } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { repositories, syncEvents } from '../../db/schema';
import type { GitHost } from '../../lib/git-host';
import { logEvent } from '../../lib/log';

export type PushReport = {
  operationId: string;
  kind: 'push';
  ref: string;
  oldOid: string | null;
  newOid: string;
};

export type RecordResult =
  | { status: 'recorded'; result: 'confirmed' | 'unverified'; tip: string | null }
  | { status: 'not_found' }
  | { status: 'conflict' };

// The desktop says it pushed; the server checks Artifacts. Confirmed means the pushed commit is
// stored there, whatever was pushed after it. Hosting off, or Artifacts not answering, leaves the
// push unverified rather than failing the report. One row per operation id: a retry returns it.
export async function recordPush(
  db: Db,
  git: GitHost | null,
  accountId: string,
  repositoryId: string,
  input: PushReport,
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
      const [stored, current] = await Promise.all([
        git.hasCommit(row.id, input.newOid),
        git.tip(row.id, input.ref),
      ]);
      result = stored ? 'confirmed' : 'unverified';
      tip = current;
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
  // A concurrent retry may have written first; its row is the answer.
  return (await known()) ?? { status: 'recorded', result, tip };
}
