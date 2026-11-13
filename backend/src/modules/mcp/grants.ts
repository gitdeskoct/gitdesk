import { and, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import type { GrantSummary, OAuthHelpers } from '@cloudflare/workers-oauth-provider';
import type { Db } from '../../db/client';
import { MCP_AUDIT_OUTCOMES, mcpAudit, mcpGrantUsage } from '../../db/schema';
import { encodeCursor } from '../../lib/cursor';
import { MCP_SCOPES, type GrantMetadata, type McpProps, type McpScope } from './oauth';

// One write a minute per grant is enough for "last used"; the rest of the calls change nothing.
const USAGE_STEP_MS = 60_000;
// Far more than one person authorizes; past it the list says there are more.
const MAX_GRANTS = 100;

export const touchGrant = (db: Db, props: McpProps, now: number) =>
  db
    .insert(mcpGrantUsage)
    .values({ grantKey: props.grantKey, accountId: props.accountId, createdAt: now, lastUsedAt: now })
    .onConflictDoUpdate({
      target: mcpGrantUsage.grantKey,
      set: { lastUsedAt: now },
      setWhere: lt(mcpGrantUsage.lastUsedAt, now - USAGE_STEP_MS),
    });

export type AuditOutcome = (typeof MCP_AUDIT_OUTCOMES)[number];

export const recordAudit = (
  db: Db,
  props: McpProps,
  entry: { tool: string; repositoryId: string | null; outcome: AuditOutcome; reason: string | null },
  now: number,
) =>
  db.insert(mcpAudit).values({
    id: crypto.randomUUID(),
    accountId: props.accountId,
    grantKey: props.grantKey,
    clientName: props.clientName.slice(0, 200),
    tool: entry.tool,
    repositoryId: entry.repositoryId,
    outcome: entry.outcome,
    reason: entry.reason,
    createdAt: now,
  });

export async function listAudit(db: Db, accountId: string, input: { limit: number; cursor?: [number, string] }) {
  const after = input.cursor
    ? or(
        lt(mcpAudit.createdAt, input.cursor[0]),
        and(eq(mcpAudit.createdAt, input.cursor[0]), lt(mcpAudit.id, input.cursor[1])),
      )
    : undefined;
  const rows = await db
    .select()
    .from(mcpAudit)
    .where(and(eq(mcpAudit.accountId, accountId), after))
    .orderBy(desc(mcpAudit.createdAt), desc(mcpAudit.id))
    .limit(input.limit + 1);
  const page = rows.slice(0, input.limit);
  const last = page[page.length - 1];
  return {
    events: page.map((row) => ({
      id: row.id,
      clientName: row.clientName,
      tool: row.tool,
      repositoryId: row.repositoryId,
      outcome: row.outcome,
      reason: row.reason,
      createdAt: row.createdAt,
    })),
    nextCursor: rows.length > input.limit && last ? encodeCursor([last.createdAt, last.id]) : null,
  };
}

const isScope = (scope: string): scope is McpScope => (MCP_SCOPES as readonly string[]).includes(scope);

// Grant metadata was written by this Worker, but it is read back defensively: a grant with
// anything else in it is still listed, so it can still be revoked.
function metadataOf(grant: GrantSummary): GrantMetadata {
  const raw = (grant.metadata ?? {}) as Partial<Record<keyof GrantMetadata, unknown>>;
  const text = (value: unknown) => (typeof value === 'string' && value ? value : null);
  return {
    grantKey: text(raw.grantKey) ?? '',
    clientName: text(raw.clientName) ?? 'Unnamed agent',
    clientDomain: text(raw.clientDomain),
    redirectHost: text(raw.redirectHost) ?? '',
  };
}

export async function listGrants(db: Db, oauth: OAuthHelpers, accountId: string) {
  const { items, cursor } = await oauth.listUserGrants(accountId, { limit: MAX_GRANTS });
  const keys = items.map((grant) => metadataOf(grant).grantKey).filter(Boolean);
  const usage = keys.length
    ? await db
        .select({ grantKey: mcpGrantUsage.grantKey, lastUsedAt: mcpGrantUsage.lastUsedAt })
        .from(mcpGrantUsage)
        .where(and(eq(mcpGrantUsage.accountId, accountId), inArray(mcpGrantUsage.grantKey, keys)))
    : [];
  const grants = items
    .map((grant) => {
      const meta = metadataOf(grant);
      return {
        id: grant.id,
        clientName: meta.clientName,
        // Set only for a client whose identity is a verified metadata document on that domain.
        clientDomain: meta.clientDomain,
        redirectHost: meta.redirectHost,
        scopes: grant.scope.filter(isScope),
        // The library keeps seconds; everything gitdesk stores is milliseconds.
        createdAt: grant.createdAt * 1000,
        expiresAt: grant.expiresAt ? grant.expiresAt * 1000 : null,
        lastUsedAt: usage.find((row) => row.grantKey === meta.grantKey)?.lastUsedAt ?? null,
      };
    })
    .sort((a, b) => b.createdAt - a.createdAt);
  return { grants, more: !!cursor };
}

// Revoke looks through every page, so a grant past the first page of the list can still be ended.
const MAX_PAGES = 50;

async function findGrant(oauth: OAuthHelpers, accountId: string, grantId: string) {
  let cursor: string | undefined;
  for (let page = 0; page < MAX_PAGES; page++) {
    const result = await oauth.listUserGrants(accountId, { limit: MAX_GRANTS, cursor });
    const grant = result.items.find((item) => item.id === grantId);
    if (grant || !result.cursor) return grant ?? null;
    cursor = result.cursor;
  }
  return null;
}

export async function revokeGrant(db: Db, oauth: OAuthHelpers, accountId: string, grantId: string) {
  const grant = await findGrant(oauth, accountId, grantId);
  // Someone else's grant id looks exactly like a missing one.
  if (!grant) return false;
  await oauth.revokeGrant(grant.id, accountId);
  const { grantKey } = metadataOf(grant);
  if (grantKey)
    await db
      .delete(mcpGrantUsage)
      .where(and(eq(mcpGrantUsage.accountId, accountId), eq(mcpGrantUsage.grantKey, grantKey)));
  return true;
}

const DAY_MS = 24 * 60 * 60_000;

// The audit trail is kept 90 days. A usage row whose grant ended is dropped once it could no
// longer belong to a live grant.
export const purgeMcp = (db: Db, now: number) =>
  db.batch([
    db.delete(mcpAudit).where(lt(mcpAudit.createdAt, now - 90 * DAY_MS)),
    db.delete(mcpGrantUsage).where(lt(sql`max(${mcpGrantUsage.lastUsedAt}, ${mcpGrantUsage.createdAt})`, now - 91 * DAY_MS)),
  ]);
