import { DatabaseSync } from 'node:sqlite';

// Local metadata only. Credentials never go in here; they live in the OS-backed credential store.
const MIGRATIONS = [
  `CREATE TABLE app_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // Workspace index. root_path is where the repository was last found, not its identity: the id
  // is ours, and path_key (canonical, case-folded where the filesystem is) only catches duplicates.
  // repository_cache is a snapshot of the last inspection, never proof of the current state.
  // remote_repository_cache is keyed by account so one account's data never shows under another.
  `CREATE TABLE local_repositories (
     id TEXT PRIMARY KEY,
     root_path TEXT NOT NULL,
     path_key TEXT NOT NULL UNIQUE,
     display_name TEXT NOT NULL,
     description TEXT,
     created_at INTEGER NOT NULL,
     last_opened_at INTEGER,
     is_pinned INTEGER NOT NULL DEFAULT 0,
     pinned_at INTEGER,
     remote_id TEXT,
     last_inspected_at INTEGER
   );
   CREATE INDEX local_repositories_opened ON local_repositories (last_opened_at);
   CREATE TABLE repository_cache (
     repository_id TEXT PRIMARY KEY REFERENCES local_repositories (id) ON DELETE CASCADE,
     availability TEXT NOT NULL,
     status_json TEXT,
     error TEXT,
     inspected_at INTEGER NOT NULL
   );
   CREATE TABLE remote_repository_cache (
     account_id TEXT NOT NULL,
     remote_id TEXT NOT NULL,
     name TEXT NOT NULL,
     description TEXT,
     visibility TEXT NOT NULL,
     default_branch TEXT NOT NULL,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     fetched_at INTEGER NOT NULL,
     PRIMARY KEY (account_id, remote_id)
   );
   CREATE TABLE local_activity (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     repository_id TEXT NOT NULL REFERENCES local_repositories (id) ON DELETE CASCADE,
     event_type TEXT NOT NULL,
     occurred_at INTEGER NOT NULL,
     detail TEXT
   );
   CREATE INDEX local_activity_time ON local_activity (occurred_at)`,
  // inspected_at is the last attempt; status_at is when status_json was last refreshed, so a
  // failed or "missing" check never makes an old snapshot look new.
  `ALTER TABLE repository_cache ADD COLUMN status_at INTEGER;
   UPDATE repository_cache SET status_at = inspected_at WHERE status_json IS NOT NULL`,
  // The server's lifecycle state for cached remotes (provisioning, ready, failed, deleting).
  `ALTER TABLE remote_repository_cache ADD COLUMN status TEXT NOT NULL DEFAULT 'ready'`,
  // gitdesk's own per-repository choices; Git settings stay in the repository's .git/config.
  `CREATE TABLE repository_preferences (
     repository_id TEXT PRIMARY KEY REFERENCES local_repositories (id) ON DELETE CASCADE,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  // The hosted Git URL the server gave a remote, so fetch and push know it without asking again.
  `ALTER TABLE remote_repository_cache ADD COLUMN git_url TEXT`,
  // Pull requests of repositories not linked to the account, their review records, files marked
  // viewed per snapshot (account pull requests too, by id), and merge or revert operations so an
  // interrupted one can be found again after a restart.
  `CREATE TABLE pull_requests (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES local_repositories (id) ON DELETE CASCADE,
    number INTEGER NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    source_ref TEXT NOT NULL,
    target_ref TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('open', 'closed', 'merged')),
    is_draft INTEGER NOT NULL DEFAULT 0,
    author_json TEXT NOT NULL,
    idempotency_key TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    closed_at INTEGER,
    merged_at INTEGER,
    merge_commit_oid TEXT,
    merge_operation_id TEXT,
    UNIQUE (repository_id, number),
    UNIQUE (repository_id, idempotency_key)
  );
  CREATE INDEX pull_requests_list ON pull_requests (repository_id, status, updated_at, id);
  CREATE TABLE pull_snapshots (
    pull_id TEXT NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    source_oid TEXT NOT NULL,
    target_oid TEXT NOT NULL,
    merge_base_oid TEXT,
    mergeability TEXT NOT NULL DEFAULT 'unknown',
    reason TEXT,
    conflicts_json TEXT NOT NULL DEFAULT '[]',
    checked_at INTEGER,
    created_at INTEGER NOT NULL,
    PRIMARY KEY (pull_id, version)
  );
  CREATE TABLE pull_comments (
    id TEXT PRIMARY KEY,
    pull_id TEXT NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
    parent_id TEXT,
    author_json TEXT NOT NULL,
    body TEXT NOT NULL,
    anchor_json TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL,
    deleted_at INTEGER,
    resolved_at INTEGER
  );
  CREATE INDEX pull_comments_pull ON pull_comments (pull_id, created_at);
  CREATE TABLE pull_reviews (
    id TEXT PRIMARY KEY,
    pull_id TEXT NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
    decision TEXT NOT NULL CHECK (decision IN ('approved', 'changes_requested', 'commented')),
    body TEXT NOT NULL,
    version INTEGER NOT NULL,
    source_oid TEXT NOT NULL,
    target_oid TEXT NOT NULL,
    author_json TEXT NOT NULL,
    submitted_at INTEGER NOT NULL
  );
  CREATE INDEX pull_reviews_pull ON pull_reviews (pull_id, submitted_at);
  CREATE TABLE pull_activity (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    pull_id TEXT NOT NULL REFERENCES pull_requests (id) ON DELETE CASCADE,
    event_type TEXT NOT NULL,
    actor_json TEXT NOT NULL,
    detail TEXT,
    created_at INTEGER NOT NULL
  );
  CREATE INDEX pull_activity_pull ON pull_activity (pull_id, id);
  CREATE TABLE pull_viewed (
    pull_key TEXT NOT NULL,
    version INTEGER NOT NULL,
    path TEXT NOT NULL,
    PRIMARY KEY (pull_key, version, path)
  );
  CREATE TABLE merge_operations (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES local_repositories (id) ON DELETE CASCADE,
    pull_id TEXT NOT NULL,
    kind TEXT NOT NULL CHECK (kind IN ('merge', 'revert')),
    state TEXT NOT NULL,
    strategy TEXT,
    source_oid TEXT NOT NULL,
    target_oid TEXT NOT NULL,
    result_oid TEXT,
    -- Push the target after merging; whether the account has the result; the branch to go back to
    -- after an abort; the paths that conflicted.
    push INTEGER NOT NULL DEFAULT 0,
    recorded INTEGER NOT NULL DEFAULT 0,
    head_ref TEXT,
    conflicts_json TEXT NOT NULL DEFAULT '[]',
    message TEXT,
    commit_message TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  CREATE INDEX merge_operations_repo ON merge_operations (repository_id, updated_at);`,
  // merge_operations becomes the journal for every Git operation gitdesk starts, so a pull, push
  // or move that a crash interrupts is found again: pull_id and target_oid are optional now.
  // remote_marks keeps the last successful fetch and push per remote; FETCH_HEAD only knows the
  // latest fetch of any remote. remote_backups holds the remotes a move replaced, for Undo.
  `CREATE TABLE merge_operations_next (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES local_repositories (id) ON DELETE CASCADE,
    pull_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('merge', 'revert', 'fetch', 'pull', 'push', 'move')),
    state TEXT NOT NULL,
    strategy TEXT,
    source_oid TEXT NOT NULL,
    target_oid TEXT,
    result_oid TEXT,
    push INTEGER NOT NULL DEFAULT 0,
    recorded INTEGER NOT NULL DEFAULT 0,
    head_ref TEXT,
    conflicts_json TEXT NOT NULL DEFAULT '[]',
    message TEXT,
    commit_message TEXT,
    remote TEXT,
    branch TEXT,
    error_code TEXT,
    -- For a push: what the account said after checking Artifacts (confirmed, unverified...).
    server_result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO merge_operations_next (id, repository_id, pull_id, kind, state, strategy, source_oid,
    target_oid, result_oid, push, recorded, head_ref, conflicts_json, message, commit_message,
    created_at, updated_at)
  SELECT id, repository_id, pull_id, kind, state, strategy, source_oid, target_oid, result_oid,
    push, recorded, head_ref, conflicts_json, message, commit_message, created_at, updated_at
  FROM merge_operations;
  DROP TABLE merge_operations;
  ALTER TABLE merge_operations_next RENAME TO merge_operations;
  CREATE INDEX merge_operations_repo ON merge_operations (repository_id, updated_at);
  CREATE INDEX merge_operations_time ON merge_operations (created_at);
  CREATE TABLE remote_marks (
    repository_id TEXT NOT NULL REFERENCES local_repositories (id) ON DELETE CASCADE,
    remote TEXT NOT NULL,
    fetched_at INTEGER,
    pushed_at INTEGER,
    PRIMARY KEY (repository_id, remote)
  );
  CREATE TABLE remote_backups (
    operation_id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES local_repositories (id) ON DELETE CASCADE,
    remotes_json TEXT NOT NULL,
    upstreams_json TEXT NOT NULL,
    created_at INTEGER NOT NULL,
    undone_at INTEGER
  );
  ALTER TABLE local_repositories ADD COLUMN auto_link_pending INTEGER NOT NULL DEFAULT 0;
  ALTER TABLE local_repositories ADD COLUMN root_commit TEXT;`,
  // Branch merges from the Branches tab and deletions of a remote branch join the journal.
  `CREATE TABLE merge_operations_next (
    id TEXT PRIMARY KEY,
    repository_id TEXT NOT NULL REFERENCES local_repositories (id) ON DELETE CASCADE,
    pull_id TEXT,
    kind TEXT NOT NULL CHECK (kind IN ('merge', 'revert', 'fetch', 'pull', 'push', 'move', 'branch-merge', 'remote-delete')),
    state TEXT NOT NULL,
    strategy TEXT,
    source_oid TEXT NOT NULL,
    target_oid TEXT,
    result_oid TEXT,
    push INTEGER NOT NULL DEFAULT 0,
    recorded INTEGER NOT NULL DEFAULT 0,
    head_ref TEXT,
    conflicts_json TEXT NOT NULL DEFAULT '[]',
    message TEXT,
    commit_message TEXT,
    remote TEXT,
    branch TEXT,
    error_code TEXT,
    server_result TEXT,
    created_at INTEGER NOT NULL,
    updated_at INTEGER NOT NULL
  );
  INSERT INTO merge_operations_next SELECT id, repository_id, pull_id, kind, state, strategy,
    source_oid, target_oid, result_oid, push, recorded, head_ref, conflicts_json, message,
    commit_message, remote, branch, error_code, server_result, created_at, updated_at
  FROM merge_operations;
  DROP TABLE merge_operations;
  ALTER TABLE merge_operations_next RENAME TO merge_operations;
  CREATE INDEX merge_operations_repo ON merge_operations (repository_id, updated_at);
  CREATE INDEX merge_operations_time ON merge_operations (created_at);`,
];

export type AppDatabase = DatabaseSync;

export function openDatabase(file: string): AppDatabase {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA foreign_keys = ON');
  const { user_version } = db.prepare('PRAGMA user_version').get() as {
    user_version: number;
  };
  for (let version = user_version; version < MIGRATIONS.length; version++) {
    db.exec('BEGIN');
    try {
      db.exec(MIGRATIONS[version]!);
      db.exec(`PRAGMA user_version = ${version + 1}`);
      db.exec('COMMIT');
    } catch (err) {
      db.exec('ROLLBACK');
      throw err;
    }
  }
  return db;
}

export function readState(db: AppDatabase, key: string): unknown {
  const row = db
    .prepare('SELECT value FROM app_state WHERE key = ?')
    .get(key) as { value: string } | undefined;
  if (!row) return undefined;
  try {
    return JSON.parse(row.value);
  } catch {
    return undefined;
  }
}

export function writeState(db: AppDatabase, key: string, value: unknown): void {
  db.prepare(
    `INSERT INTO app_state (key, value, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
  ).run(key, JSON.stringify(value), Date.now());
}

// Runs fn in one transaction: all of its writes land, or none do.
export function transaction<T>(db: AppDatabase, fn: () => T): T {
  db.exec('BEGIN');
  try {
    const result = fn();
    db.exec('COMMIT');
    return result;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

export function deleteState(db: AppDatabase, key: string): void {
  db.prepare('DELETE FROM app_state WHERE key = ?').run(key);
}
