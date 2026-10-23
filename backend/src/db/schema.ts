import { sql } from 'drizzle-orm';
import {
  check,
  index,
  integer,
  sqliteTable,
  text,
  uniqueIndex,
} from 'drizzle-orm/sqlite-core';

// All timestamps are Unix epoch milliseconds.

export const accounts = sqliteTable('accounts', {
  id: text('id').primaryKey(),
  displayName: text('display_name').notNull(),
  email: text('email').notNull(),
  avatarUrl: text('avatar_url'),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const authIdentities = sqliteTable(
  'auth_identities',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    provider: text('provider').notNull(),
    subject: text('subject').notNull(),
    email: text('email'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    uniqueIndex('auth_identities_provider_subject').on(t.provider, t.subject),
    index('auth_identities_account').on(t.accountId),
  ],
);

export const oauthTransactions = sqliteTable('oauth_transactions', {
  id: text('id').primaryKey(),
  stateHash: text('state_hash').notNull().unique(),
  nonce: text('nonce').notNull(),
  googleCodeVerifier: text('google_code_verifier').notNull(),
  desktopChallenge: text('desktop_challenge').notNull(),
  desktopState: text('desktop_state').notNull(),
  redirectPort: integer('redirect_port').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
});

export const desktopAuthCodes = sqliteTable('desktop_auth_codes', {
  codeHash: text('code_hash').primaryKey(),
  accountId: text('account_id')
    .notNull()
    .references(() => accounts.id, { onDelete: 'cascade' }),
  desktopChallenge: text('desktop_challenge').notNull(),
  createdAt: integer('created_at').notNull(),
  expiresAt: integer('expires_at').notNull(),
  consumedAt: integer('consumed_at'),
});

export const sessions = sqliteTable(
  'sessions',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    refreshHash: text('refresh_hash').notNull().unique(),
    previousRefreshHash: text('previous_refresh_hash'),
    deviceName: text('device_name').notNull(),
    createdAt: integer('created_at').notNull(),
    lastUsedAt: integer('last_used_at').notNull(),
    idleExpiresAt: integer('idle_expires_at').notNull(),
    expiresAt: integer('expires_at').notNull(),
    revokedAt: integer('revoked_at'),
    revokedReason: text('revoked_reason'),
  },
  (t) => [
    index('sessions_account').on(t.accountId),
    index('sessions_previous_refresh').on(t.previousRefreshHash),
    index('sessions_expires').on(t.expiresAt),
  ],
);

export const REPOSITORY_STATUSES = ['provisioning', 'ready', 'failed', 'deleting'] as const;

// Remote repository metadata. Stored data lives in R2 under storage_key; D1 and R2 can't commit
// together, so status records how far provisioning or deletion got. Every query is scoped by owner_account_id.
export const repositories = sqliteTable(
  'repositories',
  {
    id: text('id').primaryKey(),
    ownerAccountId: text('owner_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    name: text('name').notNull(),
    // Lower-cased name: one repository per name per account, regardless of case.
    nameKey: text('name_key').notNull(),
    description: text('description'),
    visibility: text('visibility', { enum: ['private'] }).notNull().default('private'),
    defaultBranch: text('default_branch').notNull().default('main'),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    // Client-chosen uuid that makes a retried create return the first result.
    idempotencyKey: text('idempotency_key'),
    status: text('status', { enum: REPOSITORY_STATUSES }).notNull().default('ready'),
    // When status last changed; the daily job uses it to find work that stopped partway.
    statusAt: integer('status_at').notNull().default(0),
    // Server-made R2 prefix (repositories/<id>/). Never derived from the name, never sent to clients.
    storageKey: text('storage_key').notNull().default(''),
    // https Git remote from the git host, null until provisioned with hosting on. Holds no credentials.
    gitRemote: text('git_remote'),
  },
  (t) => [
    uniqueIndex('repositories_owner_name').on(t.ownerAccountId, t.nameKey),
    uniqueIndex('repositories_owner_idempotency').on(t.ownerAccountId, t.idempotencyKey),
    index('repositories_owner_updated').on(t.ownerAccountId, t.updatedAt, t.id),
    index('repositories_owner_name_key').on(t.ownerAccountId, t.nameKey, t.id),
    index('repositories_status').on(t.status, t.statusAt),
    check('repositories_visibility', sql`visibility in ('private')`),
    check('repositories_status', sql`status in ('provisioning', 'ready', 'failed', 'deleting')`),
  ],
);

export const ACTIVITY_TYPES = [
  'repository.created',
  'repository.updated',
  'repository.deleted',
  'repository.provisioned',
  'repository.provisioning_failed',
  'repository.deletion_failed',
] as const;

// The name is copied so a deleted repository's history still reads; its id goes null on delete.
export const activity = sqliteTable(
  'activity',
  {
    id: text('id').primaryKey(),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    repositoryId: text('repository_id').references(() => repositories.id, { onDelete: 'set null' }),
    repositoryName: text('repository_name').notNull(),
    type: text('type', { enum: ACTIVITY_TYPES }).notNull(),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('activity_account_created').on(t.accountId, t.createdAt, t.id),
    // Without it, every repository delete scans activity to null out the reference.
    index('activity_repository').on(t.repositoryId),
  ],
);

// Pull requests: review records only. Git computes comparisons and merges on the desktop, which
// reports the commits it saw; those OIDs are client-reported facts, never verified here.
export const PULL_STATUSES = ['open', 'closed', 'merged'] as const;
export const REVIEW_DECISIONS = ['approved', 'changes_requested', 'commented'] as const;
export const MERGEABILITY = ['unknown', 'mergeable', 'conflicts', 'needs_refresh', 'unavailable'] as const;

export const pullRequests = sqliteTable(
  'pull_requests',
  {
    id: text('id').primaryKey(),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    authorAccountId: text('author_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    number: integer('number').notNull(),
    title: text('title').notNull(),
    description: text('description').notNull(),
    sourceRef: text('source_ref').notNull(),
    targetRef: text('target_ref').notNull(),
    status: text('status', { enum: PULL_STATUSES }).notNull().default('open'),
    isDraft: integer('is_draft', { mode: 'boolean' }).notNull().default(false),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    closedAt: integer('closed_at'),
    mergedAt: integer('merged_at'),
    mergeCommitOid: text('merge_commit_oid'),
    latestSourceOid: text('latest_source_oid'),
    latestTargetOid: text('latest_target_oid'),
    comparisonVersion: integer('comparison_version').notNull().default(0),
    idempotencyKey: text('idempotency_key'),
  },
  (t) => [
    uniqueIndex('pull_requests_repository_number').on(t.repositoryId, t.number),
    uniqueIndex('pull_requests_repository_idempotency').on(t.repositoryId, t.idempotencyKey),
    index('pull_requests_repository_status_updated').on(t.repositoryId, t.status, t.updatedAt, t.id),
    check('pull_requests_status', sql`status in ('open', 'closed', 'merged')`),
  ],
);

export const pullRequestSnapshots = sqliteTable(
  'pull_request_snapshots',
  {
    id: text('id').primaryKey(),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    version: integer('version').notNull(),
    sourceOid: text('source_oid').notNull(),
    targetOid: text('target_oid').notNull(),
    mergeBaseOid: text('merge_base_oid'),
    mergeability: text('mergeability', { enum: MERGEABILITY }).notNull().default('unknown'),
    reason: text('reason'),
    // JSON array of conflicted paths, at most 200.
    conflicts: text('conflicts').notNull().default('[]'),
    checkedAt: integer('checked_at'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [uniqueIndex('pull_request_snapshots_version').on(t.pullRequestId, t.version)],
);

export const pullRequestReviews = sqliteTable(
  'pull_request_reviews',
  {
    id: text('id').primaryKey(),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    reviewerAccountId: text('reviewer_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    decision: text('decision', { enum: REVIEW_DECISIONS }).notNull(),
    body: text('body').notNull(),
    sourceOid: text('source_oid').notNull(),
    targetOid: text('target_oid').notNull(),
    comparisonVersion: integer('comparison_version').notNull(),
    submittedAt: integer('submitted_at').notNull(),
  },
  (t) => [
    index('pull_request_reviews_pull').on(t.pullRequestId, t.submittedAt),
    check('pull_request_reviews_decision', sql`decision in ('approved', 'changes_requested', 'commented')`),
  ],
);

export const pullRequestComments = sqliteTable(
  'pull_request_comments',
  {
    id: text('id').primaryKey(),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    authorAccountId: text('author_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    parentCommentId: text('parent_comment_id'),
    body: text('body').notNull(),
    createdAt: integer('created_at').notNull(),
    updatedAt: integer('updated_at').notNull(),
    deletedAt: integer('deleted_at'),
    resolvedAt: integer('resolved_at'),
  },
  (t) => [index('pull_request_comments_pull').on(t.pullRequestId, t.createdAt)],
);

// A line comment's place in one snapshot: the commits, the file, the side and the line's text hash.
export const pullRequestCommentAnchors = sqliteTable(
  'pull_request_comment_anchors',
  {
    commentId: text('comment_id')
      .primaryKey()
      .references(() => pullRequestComments.id, { onDelete: 'cascade' }),
    comparisonVersion: integer('comparison_version').notNull(),
    sourceOid: text('source_oid').notNull(),
    targetOid: text('target_oid').notNull(),
    path: text('path').notNull(),
    side: text('side', { enum: ['old', 'new'] }).notNull(),
    oldLine: integer('old_line'),
    newLine: integer('new_line'),
    contextHash: text('context_hash').notNull(),
    isOutdated: integer('is_outdated', { mode: 'boolean' }).notNull().default(false),
  },
  (t) => [check('pull_request_comment_anchors_side', sql`side in ('old', 'new')`)],
);

export const pullRequestActivity = sqliteTable(
  'pull_request_activity',
  {
    id: text('id').primaryKey(),
    pullRequestId: text('pull_request_id')
      .notNull()
      .references(() => pullRequests.id, { onDelete: 'cascade' }),
    actorAccountId: text('actor_account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    // The actor's name when it happened, so history reads the same after a rename.
    actorName: text('actor_name').notNull(),
    eventType: text('event_type').notNull(),
    eventPayload: text('event_payload'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [index('pull_request_activity_pull').on(t.pullRequestId, t.createdAt, t.id)],
);

// One row per reported merge, keyed by the desktop's operation id: a retried report is a no-op.
export const pullRequestMergeResults = sqliteTable('pull_request_merge_results', {
  operationId: text('operation_id').primaryKey(),
  pullRequestId: text('pull_request_id')
    .notNull()
    .references(() => pullRequests.id, { onDelete: 'cascade' }),
  mergeCommitOid: text('merge_commit_oid').notNull(),
  targetOid: text('target_oid').notNull(),
  createdAt: integer('created_at').notNull(),
});

// One row per push the desktop reported to its account Git URL, keyed by the desktop's operation
// id so a retried report is a no-op. result is what the server found in Artifacts when told.
export const syncEvents = sqliteTable(
  'sync_events',
  {
    operationId: text('operation_id').primaryKey(),
    repositoryId: text('repository_id')
      .notNull()
      .references(() => repositories.id, { onDelete: 'cascade' }),
    accountId: text('account_id')
      .notNull()
      .references(() => accounts.id, { onDelete: 'cascade' }),
    kind: text('kind', { enum: ['push'] }).notNull(),
    ref: text('ref').notNull(),
    oldOid: text('old_oid'),
    newOid: text('new_oid').notNull(),
    result: text('result', { enum: ['confirmed', 'unverified'] }).notNull(),
    // The branch tip Artifacts reported when the event was recorded; null when it had none.
    tip: text('tip'),
    createdAt: integer('created_at').notNull(),
  },
  (t) => [
    index('sync_events_repository').on(t.repositoryId, t.createdAt),
    index('sync_events_time').on(t.createdAt),
    check('sync_events_kind', sql`${t.kind} IN ('push')`),
    check('sync_events_result', sql`${t.result} IN ('confirmed', 'unverified')`),
  ],
);
