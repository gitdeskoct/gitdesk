import type { RepoStatus, RepositorySummary } from '../../shared/repos';

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
  if (!status.upstream || status.ahead === null || status.behind === null)
    return 'no-upstream';
  if (status.ahead > 0 && status.behind > 0) return 'diverged';
  if (status.ahead > 0) return 'ahead';
  if (status.behind > 0) return 'behind';
  return 'up-to-date';
}

export type Attention = {
  repo: RepositorySummary;
  kind: 'missing' | 'not-a-repo' | 'error' | 'conflict' | 'operation' | 'changed' | 'diverged' | 'behind' | 'ahead';
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
  return null;
}

export function needsAttention(repos: RepositorySummary[]): Attention[] {
  return repos
    .map((repo) => ({ repo, kind: attentionOf(repo) }))
    .filter((item): item is Attention => item.kind !== null)
    .sort((a, b) => ORDER.indexOf(a.kind) - ORDER.indexOf(b.kind));
}

export type WorkspaceStats = {
  local: number;
  changed: number;
  ahead: number;
  checking: number;
  // The oldest successful check among available repositories: the strip's honest freshness.
  oldestCheck: number | null;
};

export function workspaceStats(repos: RepositorySummary[]): WorkspaceStats {
  const available = repos.filter((repo) => repo.availability === 'available');
  const checks = available
    .map((repo) => repo.inspectedAt)
    .filter((at): at is number => at !== null);
  return {
    local: available.length,
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
