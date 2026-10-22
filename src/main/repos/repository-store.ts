import type {
  LocalActivity,
  RemoteRepository,
  RepoAvailability,
  RepoStatus,
} from '../../shared/repos';
import {
  DEFAULT_REPO_PREFERENCES,
  repoPreferencesInputSchema,
  type RepoPreferences,
} from '../../shared/workspace';
import { transaction, type AppDatabase } from '../db/database';

export type RepoRow = {
  id: string;
  rootPath: string;
  name: string;
  description: string | null;
  addedAt: number;
  lastOpenedAt: number | null;
  pinned: boolean;
  remoteId: string | null;
  availability: RepoAvailability | null;
  status: RepoStatus | null;
  error: string | null;
  inspectedAt: number | null;
  statusAt: number | null;
};

type RawRow = {
  id: string;
  root_path: string;
  display_name: string;
  description: string | null;
  created_at: number;
  last_opened_at: number | null;
  is_pinned: number;
  remote_id: string | null;
  availability: string | null;
  status_json: string | null;
  error: string | null;
  inspected_at: number | null;
  status_at: number | null;
};

const SELECT = `SELECT r.id, r.root_path, r.display_name, r.description, r.created_at,
  r.last_opened_at, r.is_pinned, r.remote_id, c.availability, c.status_json, c.error, c.inspected_at,
  c.status_at
  FROM local_repositories r LEFT JOIN repository_cache c ON c.repository_id = r.id`;

const ACTIVITY_KEEP = 200;

function parseStatus(json: string | null): RepoStatus | null {
  if (!json) return null;
  try {
    return JSON.parse(json) as RepoStatus;
  } catch {
    return null;
  }
}

const toRow = (raw: RawRow): RepoRow => ({
  id: raw.id,
  rootPath: raw.root_path,
  name: raw.display_name,
  description: raw.description,
  addedAt: raw.created_at,
  lastOpenedAt: raw.last_opened_at,
  pinned: raw.is_pinned === 1,
  remoteId: raw.remote_id,
  availability: (raw.availability as RepoAvailability | null) ?? null,
  status: parseStatus(raw.status_json),
  error: raw.error,
  inspectedAt: raw.inspected_at,
  statusAt: raw.status_at,
});

// Every statement is prepared with bound parameters; no value is ever spliced into SQL.
export function createRepositoryStore(db: AppDatabase) {
  return {
    list(): RepoRow[] {
      return (
        db
          .prepare(
            `${SELECT} ORDER BY r.is_pinned DESC, r.last_opened_at DESC, r.created_at DESC`,
          )
          .all() as RawRow[]
      ).map(toRow);
    },

    get(id: string): RepoRow | null {
      const raw = db.prepare(`${SELECT} WHERE r.id = ?`).get(id) as
        | RawRow
        | undefined;
      return raw ? toRow(raw) : null;
    },

    idForKey(key: string): string | null {
      const row = db
        .prepare('SELECT id FROM local_repositories WHERE path_key = ?')
        .get(key) as { id: string } | undefined;
      return row?.id ?? null;
    },

    insert(input: {
      id: string;
      rootPath: string;
      pathKey: string;
      name: string;
      description: string | null;
      remoteId?: string | null;
      now: number;
      activity: LocalActivity['type'];
    }): void {
      transaction(db, () => {
        db.prepare(
          `INSERT INTO local_repositories
             (id, root_path, path_key, display_name, description, created_at, last_opened_at, remote_id)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        ).run(
          input.id,
          input.rootPath,
          input.pathKey,
          input.name,
          input.description,
          input.now,
          input.now,
          input.remoteId ?? null,
        );
        this.addActivity(input.id, input.activity, null, input.now);
      });
    },

    // Called after every inspection. A newer HEAD commit is a "commit" entry; any other HEAD move
    // (checkout, reset, pull of older work) is a "checkout", dated now rather than by the commit.
    saveInspection(
      id: string,
      inspection: {
        availability: RepoAvailability;
        status: RepoStatus | null;
        error: string | null;
      },
      now: number,
    ): void {
      transaction(db, () => {
        const previous = this.get(id);
        if (!previous) return;
        db.prepare(
          `INSERT INTO repository_cache (repository_id, availability, status_json, error, inspected_at, status_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT(repository_id) DO UPDATE SET availability = excluded.availability,
             status_json = COALESCE(excluded.status_json, repository_cache.status_json),
             status_at = COALESCE(excluded.status_at, repository_cache.status_at),
             error = excluded.error, inspected_at = excluded.inspected_at`,
        ).run(
          id,
          inspection.availability,
          inspection.status ? JSON.stringify(inspection.status) : null,
          inspection.error,
          now,
          inspection.status ? now : null,
        );
        db.prepare(
          'UPDATE local_repositories SET last_inspected_at = ? WHERE id = ?',
        ).run(now, id);
        const before = previous.status?.lastCommit;
        const after = inspection.status?.lastCommit;
        if (before && after && after.oid !== before.oid) {
          // shortcut: commit time, not ancestry; a checkout onto a newer commit reads as a commit.
          if (after.at >= before.at)
            this.addActivity(id, 'commit', after.subject, after.at);
          else
            this.addActivity(
              id,
              'checkout',
              inspection.status?.branch ?? after.oid.slice(0, 7),
              now,
            );
        }
      });
    },

    touchOpened(id: string, now: number): void {
      transaction(db, () => {
        db.prepare(
          'UPDATE local_repositories SET last_opened_at = ? WHERE id = ?',
        ).run(now, id);
        this.addActivity(id, 'opened', null, now);
      });
    },

    setPinned(id: string, pinned: boolean, now: number): void {
      db.prepare(
        'UPDATE local_repositories SET is_pinned = ?, pinned_at = ? WHERE id = ?',
      ).run(pinned ? 1 : 0, pinned ? now : null, id);
    },

    relocate(id: string, rootPath: string, key: string): void {
      db.prepare(
        'UPDATE local_repositories SET root_path = ?, path_key = ? WHERE id = ?',
      ).run(rootPath, key, id);
    },

    setRemote(id: string, remoteId: string | null): void {
      db.prepare(
        'UPDATE local_repositories SET remote_id = ? WHERE id = ?',
      ).run(remoteId, id);
    },

    // Only fields that are passed change; undefined keeps the stored value.
    rename(
      id: string,
      patch: { name?: string; description?: string | null },
      now: number,
    ): void {
      transaction(db, () => {
        if (patch.name !== undefined)
          db.prepare(
            'UPDATE local_repositories SET display_name = ? WHERE id = ?',
          ).run(patch.name, id);
        if (patch.description !== undefined)
          db.prepare(
            'UPDATE local_repositories SET description = ? WHERE id = ?',
          ).run(patch.description, id);
        if (patch.name !== undefined)
          this.addActivity(id, 'renamed', patch.name, now);
      });
    },

    clearRemoteLink(remoteId: string): void {
      db.prepare(
        'UPDATE local_repositories SET remote_id = NULL WHERE remote_id = ?',
      ).run(remoteId);
    },

    // Only the registration and its cached data; files on disk are never touched from here.
    remove(id: string): void {
      db.prepare('DELETE FROM local_repositories WHERE id = ?').run(id);
    },

    clearActivity(): void {
      db.exec('DELETE FROM local_activity');
    },

    removeAll(): void {
      db.exec('DELETE FROM local_repositories');
    },

    addActivity(
      id: string,
      type: LocalActivity['type'],
      detail: string | null,
      at: number,
    ): void {
      db.prepare(
        'INSERT INTO local_activity (repository_id, event_type, occurred_at, detail) VALUES (?, ?, ?, ?)',
      ).run(id, type, at, detail?.slice(0, 200) ?? null);
      db.prepare(
        `DELETE FROM local_activity WHERE id NOT IN
           (SELECT id FROM local_activity ORDER BY occurred_at DESC, id DESC LIMIT ?)`,
      ).run(ACTIVITY_KEEP);
    },

    activity(limit: number): LocalActivity[] {
      return (
        db
          .prepare(
            `SELECT a.id, a.repository_id, r.display_name, a.event_type, a.occurred_at, a.detail
             FROM local_activity a JOIN local_repositories r ON r.id = a.repository_id
             ORDER BY a.occurred_at DESC, a.id DESC LIMIT ?`,
          )
          .all(limit) as {
          id: number;
          repository_id: string;
          display_name: string;
          event_type: LocalActivity['type'];
          occurred_at: number;
          detail: string | null;
        }[]
      ).map((row) => ({
        id: row.id,
        repositoryId: row.repository_id,
        repositoryName: row.display_name,
        type: row.event_type,
        at: row.occurred_at,
        detail: row.detail,
      }));
    },

    // Remote metadata cache: the last list the server returned for this account, nothing more.
    replaceRemote(
      accountId: string,
      repositories: RemoteRepository[],
      fetchedAt: number,
    ): void {
      transaction(db, () => {
        db.prepare(
          'DELETE FROM remote_repository_cache WHERE account_id = ?',
        ).run(accountId);
        const insert = db.prepare(
          `INSERT INTO remote_repository_cache
             (account_id, remote_id, name, description, visibility, default_branch, status, created_at, updated_at, fetched_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        );
        for (const repo of repositories) {
          insert.run(
            accountId,
            repo.id,
            repo.name,
            repo.description,
            repo.visibility,
            repo.defaultBranch,
            repo.status,
            repo.createdAt,
            repo.updatedAt,
            fetchedAt,
          );
        }
      });
    },

    readRemote(accountId: string): RemoteRepository[] {
      return (
        db
          .prepare(
            `SELECT remote_id, name, description, visibility, default_branch, status, created_at, updated_at
             FROM remote_repository_cache WHERE account_id = ? ORDER BY updated_at DESC`,
          )
          .all(accountId) as {
          remote_id: string;
          name: string;
          description: string | null;
          visibility: 'private';
          default_branch: string;
          status: RemoteRepository['status'];
          created_at: number;
          updated_at: number;
        }[]
      ).map((row) => ({
        id: row.remote_id,
        name: row.name,
        description: row.description,
        visibility: row.visibility,
        defaultBranch: row.default_branch,
        status: row.status,
        createdAt: row.created_at,
        updatedAt: row.updated_at,
      }));
    },

    clearRemote(): void {
      db.exec('DELETE FROM remote_repository_cache');
    },

    // Stored as JSON and read back field by field, so one bad value falls back alone.
    preferences(id: string): RepoPreferences {
      const row = db
        .prepare(
          'SELECT value FROM repository_preferences WHERE repository_id = ?',
        )
        .get(id) as { value: string } | undefined;
      let stored: Record<string, unknown> = {};
      try {
        stored = row ? (JSON.parse(row.value) as Record<string, unknown>) : {};
      } catch {
        stored = {};
      }
      const merged: Record<string, unknown> = { ...DEFAULT_REPO_PREFERENCES };
      for (const [key, field] of Object.entries(
        repoPreferencesInputSchema.shape,
      )) {
        if (key === 'id') continue;
        const parsed = field.safeParse(stored[key]);
        if (parsed.success && parsed.data !== undefined)
          merged[key] = parsed.data;
      }
      return merged as RepoPreferences;
    },

    savePreferences(id: string, value: RepoPreferences, now: number): void {
      db.prepare(
        `INSERT INTO repository_preferences (repository_id, value, updated_at) VALUES (?, ?, ?)
         ON CONFLICT(repository_id) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      ).run(id, JSON.stringify(value), now);
    },
  };
}

export type RepositoryStore = ReturnType<typeof createRepositoryStore>;
