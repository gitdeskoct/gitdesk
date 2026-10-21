import {
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
