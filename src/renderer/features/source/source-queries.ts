import {
  useQueries,
  useQuery,
  useQueryClient,
  type QueryClient,
} from '@tanstack/react-query';
import { useEffect, useMemo } from 'react';
import type { RepositorySummary } from '../../../shared/repos';
import type {
  RemoteProblem,
  SourceEntry,
  SourceFile,
  SourceSnapshot,
} from '../../../shared/source';

const source = () => window.desktop.source;

// Where the Files tab reads from: this computer (working tree, index or a commit), or the
// account's hosted copy at one commit. A remote branch is resolved to that commit first.
export type Origin =
  | { kind: 'local'; repoId: string; snapshot: SourceSnapshot }
  | { kind: 'remote'; repoId: string; commit: string };

export type ListOptions = {
  showIgnored: boolean;
  showHidden: boolean;
  foldersFirst: boolean;
};

export type DirPage = {
  entries: SourceEntry[];
  // A local offset or a remote cursor for the next page; null on the last one.
  next: number | string | null;
  total: number | null;
};

export type Fetched<T> =
  | { ok: true; value: T }
  | { ok: false; problem: RemoteProblem };

// An answer is kept until something says it changed; a problem (offline, hosting off, signed out)
// is asked again the next time the screen shows, so it never outlives its cause.
const keepAnswers = (query: {
  state: { data: Fetched<unknown> | undefined };
}) => (query.state.data?.ok === false ? 0 : Infinity);

export const snapshotKey = (snapshot: SourceSnapshot): string =>
  snapshot.kind === 'commit' ? snapshot.oid : snapshot.kind;

const originKey = (origin: Origin) =>
  origin.kind === 'local'
    ? (['local', origin.repoId, snapshotKey(origin.snapshot)] as const)
    : (['remote', origin.repoId, origin.commit] as const);

export const sourceKeys = {
  dir: (origin: Origin, options: ListOptions, dir: string, page: number) =>
    ['src-dir', ...originKey(origin), options, dir, page] as const,
  file: (
    origin: Origin,
    path: string,
    oid: string | null,
    limitMiB: number,
    force: boolean,
  ) =>
    // Remote blobs are content-addressed, so the object id alone names their bytes.
    origin.kind === 'remote'
      ? (['src-file', 'remote', origin.repoId, oid, limitMiB, force] as const)
      : (['src-file', ...originKey(origin), path, limitMiB, force] as const),
  head: (repoId: string, ref: string) =>
    ['src-remote-head', repoId, ref] as const,
  branches: (repoId: string) => ['src-remote-branches', repoId] as const,
  paths: (repoId: string, query: string) =>
    ['src-paths', repoId, query] as const,
  lastChange: (repoId: string, snapshot: string, path: string) =>
    ['src-last', repoId, snapshot, path] as const,
  stats: (repoId: string, signature: string) =>
    ['src-stats', repoId, signature] as const,
};

async function fetchPage(
  qc: QueryClient,
  origin: Origin,
  options: ListOptions,
  dir: string,
  page: number,
): Promise<Fetched<DirPage>> {
  if (origin.kind === 'local') {
    const offset =
      page === 0
        ? 0
        : (
            qc.getQueryData<Fetched<DirPage>>(
              sourceKeys.dir(origin, options, dir, page - 1),
            ) as { ok: true; value: DirPage } | undefined
          )?.value.next;
    if (typeof offset !== 'number')
      return { ok: true, value: { entries: [], next: null, total: null } };
    const result = await source().list({
      id: origin.repoId,
      snapshot: origin.snapshot,
      path: dir,
      offset,
      ...options,
    });
    return {
      ok: true,
      value: {
        entries: result.entries,
        next: result.nextOffset,
        total: result.total,
      },
    };
  }
  const previous =
    page === 0
      ? null
      : qc.getQueryData<Fetched<DirPage>>(
          sourceKeys.dir(origin, options, dir, page - 1),
        );
  const cursor =
    previous?.ok && typeof previous.value.next === 'string'
      ? previous.value.next
      : null;
  if (page > 0 && !cursor)
    return { ok: true, value: { entries: [], next: null, total: null } };
  const result = await source().remoteList({
    id: origin.repoId,
    ref: origin.commit,
    path: dir,
    cursor,
  });
  if (!result.ok) return result;
  const entries = options.showHidden
    ? result.entries
    : result.entries.filter((e) => !e.name.startsWith('.'));
  return { ok: true, value: { entries, next: result.nextCursor, total: null } };
}

export type DirState = {
  entries: SourceEntry[];
  loading: boolean;
  loadingMore: boolean;
  hasMore: boolean;
  total: number | null;
  error: string | null;
  problem: RemoteProblem | null;
};

// One query per folder page that is on screen, so a big tree never loads as one request and a
// collapsed folder keeps its cached rows for when it opens again.
export function useDirs(
  origin: Origin | null,
  options: ListOptions,
  dirs: string[],
  pages: Record<string, number>,
): Map<string, DirState> {
  const qc = useQueryClient();
  const plan = useMemo(
    () =>
      origin
        ? dirs.flatMap((dir) =>
            Array.from({ length: pages[dir] ?? 1 }, (_, page) => ({
              dir,
              page,
            })),
          )
        : [],
    [origin, dirs, pages],
  );
  const results = useQueries({
    queries: plan.map(({ dir, page }) => ({
      queryKey: sourceKeys.dir(origin!, options, dir, page),
      queryFn: () => fetchPage(qc, origin!, options, dir, page),
      staleTime: keepAnswers,
      placeholderData: (previous: Fetched<DirPage> | undefined) => previous,
    })),
  });
  return useMemo(() => {
    const map = new Map<string, DirState>();
    plan.forEach(({ dir, page }, i) => {
      const result = results[i]!;
      const state = map.get(dir) ?? {
        entries: [],
        loading: false,
        loadingMore: false,
        hasMore: false,
        total: null,
        error: null,
        problem: null,
      };
      if (result.isPending) {
        if (page === 0) state.loading = true;
        else state.loadingMore = true;
      } else if (result.isError) {
        state.error = page === 0 ? 'load' : 'more';
      } else if (result.data && !result.data.ok) {
        state.problem = result.data.problem;
      } else if (result.data?.ok) {
        state.entries = state.entries.concat(result.data.value.entries);
        state.hasMore = result.data.value.next !== null;
        state.total = result.data.value.total ?? state.total;
      }
      map.set(dir, state);
    });
    return map;
  }, [plan, results]);
}

// The open file. Kept for a minute after it is closed, so going back to it is instant without
// holding many files' text at once.
export function useSourceFile(
  origin: Origin | null,
  entry: { path: string; oid: string | null } | null,
  limitMiB: 1 | 2 | 5,
  force: boolean,
) {
  return useQuery({
    queryKey:
      origin && entry
        ? sourceKeys.file(origin, entry.path, entry.oid, limitMiB, force)
        : ['src-file', 'none'],
    enabled: !!origin && !!entry && (origin.kind === 'local' || !!entry.oid),
    // shortcut: bounded by time, not bytes; add a byte budget if people keep many large files open.
    gcTime: 60_000,
    staleTime: origin?.kind === 'remote' ? keepAnswers : 0,
    queryFn: async (): Promise<Fetched<SourceFile>> => {
      if (origin!.kind === 'local')
        return {
          ok: true,
          value: await source().read({
            id: origin!.repoId,
            snapshot: origin!.snapshot,
            path: entry!.path,
            limitMiB,
            force,
          }),
        };
      const result = await source().remoteRead({
        id: origin!.repoId,
        oid: entry!.oid!,
        path: entry!.path,
        limitMiB,
        force,
      });
      return result.ok ? { ok: true, value: result.file } : result;
    },
  });
}

// The hosted repository's branch, resolved to the commit everything else is read from.
export function useRemoteHead(repoId: string, ref: string, enabled: boolean) {
  const qc = useQueryClient();
  return useQuery({
    queryKey: sourceKeys.head(repoId, ref),
    enabled,
    staleTime: keepAnswers,
    queryFn: async (): Promise<Fetched<{ commit: string }>> => {
      const root = await source().remoteList({
        id: repoId,
        ref,
        path: '',
        cursor: null,
      });
      if (!root.ok) return root;
      // The root's first page is already here; it seeds the folder cache for that commit.
      for (const showHidden of [true, false])
        for (const foldersFirst of [true, false]) {
          const seed: Fetched<DirPage> = {
            ok: true,
            value: {
              entries: showHidden
                ? root.entries
                : root.entries.filter((e) => !e.name.startsWith('.')),
              next: root.nextCursor,
              total: null,
            },
          };
          qc.setQueryData(
            sourceKeys.dir(
              { kind: 'remote', repoId, commit: root.commit },
              { showIgnored: false, showHidden, foldersFirst },
              '',
              0,
            ),
            seed,
          );
        }
      return { ok: true, value: { commit: root.commit } };
    },
  });
}

export const useRemoteBranches = (repoId: string, enabled: boolean) =>
  useQuery({
    queryKey: sourceKeys.branches(repoId),
    enabled,
    staleTime: 30_000,
    queryFn: () => source().remoteBranches(repoId),
  });

export const usePathSearch = (
  repoId: string,
  query: string,
  enabled: boolean,
) =>
  useQuery({
    queryKey: sourceKeys.paths(repoId, query),
    enabled: enabled && query.trim().length > 0,
    staleTime: 15_000,
    placeholderData: (previous) => previous,
    queryFn: () => source().paths({ id: repoId, query: query.trim() }),
  });

export const useLastChange = (
  repoId: string,
  snapshot: SourceSnapshot,
  path: string | null,
  enabled: boolean,
) =>
  useQuery({
    queryKey: sourceKeys.lastChange(repoId, snapshotKey(snapshot), path ?? ''),
    enabled: enabled && !!path,
    staleTime: 60_000,
    queryFn: () => source().lastChange({ id: repoId, snapshot, path: path! }),
  });

// What the counts depend on: the commit checked out and how many paths are changed. A new
// edit to an already-changed file keeps it, so the counts aren't read again on every save.
export function statusSignature(repo: RepositorySummary): string {
  const s = repo.status;
  return s
    ? [s.headOid, s.staged, s.unstaged, s.untracked, s.conflicts].join(':')
    : 'none';
}

export const useSourceStats = (repo: RepositorySummary, enabled: boolean) =>
  useQuery({
    queryKey: sourceKeys.stats(repo.id, statusSignature(repo)),
    enabled,
    staleTime: Infinity,
    placeholderData: (previous) => previous,
    queryFn: () => source().stats(repo.id),
  });

const ancestors = (dir: string): string[] => {
  const out = [''];
  const parts = dir ? dir.split('/') : [];
  for (let i = 1; i <= parts.length; i++) out.push(parts.slice(0, i).join('/'));
  return out;
};

// Keeps the working-tree view current. The watcher reports the folders a burst of edits touched,
// so only those folders, their parents (for the change markers) and an open file inside them are
// read again. Staging and commits change the status signature, which rereads the local tree.
export function useLiveSource(repo: RepositorySummary | null): void {
  const qc = useQueryClient();
  const id = repo?.id ?? null;
  useEffect(() => {
    if (!id) return;
    return source().onChanged((change) => {
      if (change.id !== id) return;
      const touched = change.dirs
        ? new Set(change.dirs.flatMap(ancestors))
        : null;
      const parentOf = (path: string) =>
        path.slice(0, Math.max(0, path.lastIndexOf('/')));
      void qc.invalidateQueries({
        predicate: ({ queryKey: k }) =>
          (k[0] === 'src-dir' &&
            k[1] === 'local' &&
            k[2] === id &&
            k[3] === 'worktree' &&
            (!touched || touched.has(k[5] as string))) ||
          (k[0] === 'src-file' &&
            k[1] === 'local' &&
            k[2] === id &&
            k[3] === 'worktree' &&
            (!change.dirs || change.dirs.includes(parentOf(k[4] as string)))),
      });
      void qc.invalidateQueries({ queryKey: ['src-paths', id] });
    });
  }, [id, qc]);

  const signature = repo ? statusSignature(repo) : null;
  useEffect(() => {
    if (!id || signature === null) return;
    return () => {
      // Runs when the signature changes: what is staged or checked out moved on.
      void qc.invalidateQueries({
        predicate: ({ queryKey: k }) =>
          (k[0] === 'src-dir' || k[0] === 'src-file') &&
          k[1] === 'local' &&
          k[2] === id &&
          k[3] !== undefined &&
          !/^[0-9a-f]{40,64}$/.test(String(k[3])),
      });
    };
  }, [id, signature, qc]);
}

// Everything the tab shows for this repository, read again: the Refresh button. A hosted branch
// stays on the commit it was opened at; the branch list is read again, so a move shows as the
// "has moved" band and Show latest is the one thing that moves on.
export function refreshSource(qc: QueryClient, repoId: string): Promise<void> {
  return qc.invalidateQueries({
    predicate: ({ queryKey: k }) =>
      typeof k[0] === 'string' &&
      k[0].startsWith('src-') &&
      k[0] !== 'src-remote-head' &&
      (k[1] === repoId || k[2] === repoId),
  });
}
