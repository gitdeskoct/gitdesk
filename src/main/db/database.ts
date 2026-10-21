import { DatabaseSync } from 'node:sqlite';

// Local metadata only. Credentials never go in here; they live in the OS-backed credential store.
const MIGRATIONS = [
  `CREATE TABLE app_state (
     key TEXT PRIMARY KEY,
     value TEXT NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
];

export type AppDatabase = DatabaseSync;

export function openDatabase(file: string): AppDatabase {
  const db = new DatabaseSync(file);
  db.exec('PRAGMA journal_mode = WAL');
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

export function deleteState(db: AppDatabase, key: string): void {
  db.prepare('DELETE FROM app_state WHERE key = ?').run(key);
}
