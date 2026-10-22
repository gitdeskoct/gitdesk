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
