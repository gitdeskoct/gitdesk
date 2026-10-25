import type {
  RemoteRepository,
  RepoStatus,
  RepositorySummary,
} from '../../shared/repos';
import type { RepoScope } from '../app/navigation';

// One row in the Repositories list. A linked registration carries its remote's metadata when that
// remote is among the loaded pages; a remote with no registration here is its own row.
export type RepoItem =
  | {
      kind: 'local';
      key: string;
      repo: RepositorySummary;
      remote: RemoteRepository | null;
    }
  | { kind: 'remote'; key: string; remote: RemoteRepository };

export function repoItems(
  local: RepositorySummary[],
  remote: RemoteRepository[],
): RepoItem[] {
  const byId = new Map(remote.map((r) => [r.id, r]));
  const linked = new Set(local.map((r) => r.remoteId).filter(Boolean));
  return [
    ...local.map(
      (repo): RepoItem => ({
        kind: 'local',
        key: repo.id,
        repo,
        remote: repo.remoteId ? (byId.get(repo.remoteId) ?? null) : null,
      }),
    ),
    ...remote
      .filter((r) => !linked.has(r.id))
      .map(
        (r): RepoItem => ({ kind: 'remote', key: `remote:${r.id}`, remote: r }),
      ),
  ];
}

export const itemName = (item: RepoItem) =>
  item.kind === 'local' ? item.repo.name : item.remote.name;

// Local: registered on this computer. Remote: in the account, linked or not. Linked: both.
export function inScope(item: RepoItem, scope: RepoScope): boolean {
  if (scope === 'local') return item.kind === 'local';
  if (scope === 'linked') return item.kind === 'local' && !!item.repo.remoteId;
  if (scope === 'remote') return item.kind === 'remote' || !!item.repo.remoteId;
  return true;
}

// Two dimensions, never merged into one label: what is uncommitted here, and how the current
// branch compares with its upstream. A clean tree can be behind; an up-to-date branch can be dirty.
export type TreeState = 'clean' | 'changed' | 'conflict' | 'unknown';
export type SyncState =
  | 'no-remote'
  | 'no-upstream'
  | 'up-to-date'
  | 'ahead'
  | 'behind'
  | 'diverged'
  // The branch tracks an upstream the remote no longer has.
  | 'gone'
  | 'unknown';

export const changeCount = (status: RepoStatus | null): number =>
  status ? status.staged + status.unstaged + status.untracked : 0;

export function treeState(repo: RepositorySummary): TreeState {
  if (repo.availability !== 'available' || !repo.status) return 'unknown';
  if (repo.status.conflicts > 0) return 'conflict';
  return changeCount(repo.status) > 0 ? 'changed' : 'clean';
}

export function syncState(repo: RepositorySummary): SyncState {
  const status = repo.status;
  if (repo.availability !== 'available' || !status) return 'unknown';
  if (!status.hasRemotes) return 'no-remote';
  // Ahead/behind is only claimed when Git reported it for a known upstream.
  // With no commits yet, Git calls the upstream gone only because nothing was ever pushed.
  if (!status.upstream || status.headOid === null) return 'no-upstream';
  if (status.ahead === null || status.behind === null) return 'gone';
  if (status.ahead > 0 && status.behind > 0) return 'diverged';
  if (status.ahead > 0) return 'ahead';
  if (status.behind > 0) return 'behind';
  return 'up-to-date';
}

export type Attention = {
  repo: RepositorySummary;
  kind:
    | 'missing'
    | 'not-a-repo'
    | 'error'
    | 'conflict'
    | 'operation'
    | 'changed'
    | 'diverged'
    | 'behind'
    | 'ahead'
    | 'no-upstream';
};

// Ordered by how much it blocks work: a missing folder before a merge before unpushed commits.
const ORDER: Attention['kind'][] = [
  'missing',
  'not-a-repo',
  'error',
  'conflict',
  'operation',
  'diverged',
  'behind',
  'changed',
  'ahead',
  'no-upstream',
];

export function attentionOf(repo: RepositorySummary): Attention['kind'] | null {
  if (repo.availability === 'missing') return 'missing';
  if (repo.availability === 'not-a-repo') return 'not-a-repo';
  if (repo.error) return 'error';
  const tree = treeState(repo);
  if (tree === 'conflict') return 'conflict';
  if (repo.status?.operation) return 'operation';
  const sync = syncState(repo);
  if (sync === 'diverged') return 'diverged';
  if (sync === 'behind') return 'behind';
  if (tree === 'changed') return 'changed';
  if (sync === 'ahead') return 'ahead';
  // A remote exists but this branch tracks nothing, so pushes and pulls have no target.
  // A repository with no remote at all is a choice, not a problem, and stays out of this list.
  if ((sync === 'no-upstream' || sync === 'gone') && repo.status?.branch)
    return 'no-upstream';
  return null;
}

// What the Problems filter means: the repository can't be worked with until this is fixed.
export const isProblem = (repo: RepositorySummary): boolean => {
  const kind = attentionOf(repo);
  return (
    kind === 'missing' ||
    kind === 'not-a-repo' ||
    kind === 'error' ||
    kind === 'conflict' ||
    kind === 'operation'
  );
};

export function needsAttention(repos: RepositorySummary[]): Attention[] {
  return repos
    .map((repo) => ({ repo, kind: attentionOf(repo) }))
    .filter((item): item is Attention => item.kind !== null)
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

export type WorkspaceStats = {
  local: number;
  // Registered but not found on disk; not counted as local.
  missing: number;
  changed: number;
  ahead: number;
  // Available repositories with no snapshot yet: their changes and sync are unknown, not zero.
  unchecked: number;
  checking: number;
  // The oldest snapshot among available repositories: the strip's honest freshness.
  oldestCheck: number | null;
};

export function workspaceStats(repos: RepositorySummary[]): WorkspaceStats {
  const available = repos.filter((repo) => repo.availability === 'available');
  const checks = available
    .map((repo) => repo.statusAt)
    .filter((at): at is number => at !== null);
  return {
    local: available.length,
    missing: repos.length - available.length,
    unchecked: available.filter((repo) => !repo.status).length,
    changed: available.filter((repo) => {
      const tree = treeState(repo);
      return tree === 'changed' || tree === 'conflict';
    }).length,
    ahead: available.filter((repo) => {
      const sync = syncState(repo);
      return sync === 'ahead' || sync === 'diverged';
    }).length,
    checking: repos.filter((repo) => repo.inspecting).length,
    oldestCheck: checks.length ? Math.min(...checks) : null,
  };
}

// Recent means last opened; it is not the same clock as the last commit.
export const byRecent = (a: RepositorySummary, b: RepositorySummary) =>
  (b.lastOpenedAt ?? b.addedAt) - (a.lastOpenedAt ?? a.addedAt);
