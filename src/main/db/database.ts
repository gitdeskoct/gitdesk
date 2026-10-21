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
