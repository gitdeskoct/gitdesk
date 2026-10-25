import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  ArrowLeftRight,
  Check,
  ChevronsUpDown,
  Code2,
  Copy,
  Download,
  FileText,
  FolderOpen,
  GitBranch,
  ListTree,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from 'react';
import type { RepositorySummary } from '../../../shared/repos';
import type { SourceEntry, SourceSnapshot } from '../../../shared/source';
import {
  FilesArt,
  NoResultsArt,
  OfflineArt,
  RemoteArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import {
  ContextMenuItem,
  ContextMenuSeparator,
} from '../../components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { EmptyState } from '../../components/ui/empty-state';
import { Loading } from '../../components/ui/status';
import { useToast } from '../../components/ui/toast';
import { useNavigation, type SourceTarget } from '../../app/navigation';
import { cn } from '../../lib/cn';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useBranches,
  useCopyFilePath,
  useOpenInEditor,
  useRepoPreferences,
  useRepositoryChanges,
  useSetRepoPreferences,
  useSettings,
  useSignIn,
  useUpdateSettings,
} from '../../lib/queries';
import { useWidth } from '../../lib/use-width';
import { fileManagerLabel } from '../repos/repo-actions';
import { iconFor } from './file-icons';
import {
  refreshSource,
  snapshotKey,
  useDirs,
  useLastChange,
  useLiveSource,
  usePathSearch,
  useRemoteBranches,
  useRemoteHead,
  useSourceFile,
  type Origin,
} from './source-queries';
import { describeEntry, flattenTree, SourceTree } from './source-tree';
import { PROBLEM_TEXT, SourceViewer } from './source-viewer';

export type ExplorerMode =
  | { kind: 'local'; repo: RepositorySummary }
  | {
      kind: 'remote';
      repoId: string;
      name: string;
      defaultBranch: string;
      // A clone on this computer, offered when hosted files can't load.
      localId: string | null;
    };

type LocalSnapshot = { snapshot: SourceSnapshot; ref: string | null };

const source = () => window.desktop.source;
const ancestorsOf = (path: string): string[] => {
  const parts = path.split('/');
  return parts.slice(0, -1).map((_p, i) => parts.slice(0, i + 1).join('/'));
};

export function SourceExplorer({
  mode,
  target,
}: {
  mode: ExplorerMode;
  target?: SourceTarget;
}) {
  const local = mode.kind === 'local' ? mode.repo : null;
  const repoId = mode.kind === 'local' ? mode.repo.id : mode.repoId;
  const qc = useQueryClient();
  const toast = useToast();
  const { navigate } = useNavigation();
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const prefs = useRepoPreferences(local?.id ?? '');
  const setPrefs = useSetRepoPreferences(local?.id ?? '');
  const [measure, width] = useWidth();
  useLiveSource(local);

  // What is shown: a local snapshot, or a remote branch pinned to the commit it resolved to.
  const [localSnap, setLocalSnap] = useState<LocalSnapshot>({
    snapshot: { kind: 'worktree' },
    ref: null,
  });
  const [remoteRef, setRemoteRef] = useState<string>('HEAD');
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['']));
  const [pages, setPages] = useState<Record<string, number>>({});
  const [focused, setFocused] = useState<string | null>(null);
  const [selected, setSelected] = useState<SourceEntry | null>(null);
  const [force, setForce] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [showIgnored, setShowIgnored] = useState<boolean | null>(null);
  const [narrowView, setNarrowView] = useState<'tree' | 'file'>('tree');
  const [line, setLine] = useState<number | null>(null);
  const filterRef = useRef<HTMLInputElement>(null);

  // A link from a pull request, History or Changes: resolve its ref once, then open the file.
  const targetRef = target?.ref ?? null;
  const resolved = useQuery({
    queryKey: ['src-resolve', repoId, targetRef],
    enabled: !!local && !!targetRef,
    staleTime: Infinity,
    queryFn: () => source().resolve({ id: repoId, ref: targetRef! }),
  });
  useEffect(() => {
    if (mode.kind === 'remote' && targetRef) setRemoteRef(targetRef);
  }, [mode.kind, targetRef]);
  useEffect(() => {
    if (resolved.data)
      setLocalSnap({
        snapshot: { kind: 'commit', oid: resolved.data.oid },
        ref: /^[0-9a-f]{40,64}$/.test(targetRef ?? '') ? null : targetRef,
      });
  }, [resolved.data, targetRef]);
  useEffect(() => {
    if (!target?.path) return;
    const path = target.path;
    setExpanded((prev) => new Set([...prev, ...ancestorsOf(path)]));
    setSelected({
      name: path.split('/').pop()!,
      path,
      type: 'file',
      size: null,
      oid: null,
      status: null,
      ignored: false,
      changes: false,
    });
    setFocused(path);
    setLine(target.line ?? null);
    setNarrowView('file');
  }, [target?.path, target?.line]);

  const head = useRemoteHead(repoId, remoteRef, mode.kind === 'remote');
  const remoteBranches = useRemoteBranches(repoId, mode.kind === 'remote');
  const origin: Origin | null = local
    ? { kind: 'local', repoId, snapshot: localSnap.snapshot }
    : head.data?.ok
      ? { kind: 'remote', repoId, commit: head.data.value.commit }
      : null;

  const worktree = !!local && localSnap.snapshot.kind === 'worktree';
  const options = {
    showIgnored:
      worktree && (showIgnored ?? settings?.sourceShowIgnored ?? false),
    showHidden: settings?.sourceShowHidden ?? true,
    foldersFirst: settings?.sourceFoldersFirst ?? true,
  };
  const openDirs = useMemo(() => [...expanded], [expanded]);
  const dirs = useDirs(origin, options, openDirs, pages);
  const rows = useMemo(() => flattenTree(dirs, expanded), [dirs, expanded]);
  const root = dirs.get('');

  // The open file; a remote one is read by the object id its tree entry named.
  const selectedEntry = useMemo(() => {
    if (!selected) return null;
    for (const state of dirs.values()) {
      const found = state.entries.find((e) => e.path === selected.path);
      if (found) return found;
    }
    return selected;
  }, [selected, dirs]);
  const limitMiB = settings?.sourceInlineLimit ?? 1;
  const fileQuery = useSourceFile(
    origin,
    selectedEntry && selectedEntry.type !== 'dir' ? selectedEntry : null,
    limitMiB,
    force === selectedEntry?.path,
  );
  const lastChange = useLastChange(
    repoId,
    localSnap.snapshot,
    selectedEntry && selectedEntry.type === 'file' ? selectedEntry.path : null,
    !!local && (settings?.sourceLastChange ?? true),
  );

  // Recent files, newest first, kept per repository.
  const remember = (path: string) => {
    if (!local || !prefs.data) return;
    const recent = [
      path,
      ...prefs.data.recentFiles.filter((p) => p !== path),
    ].slice(0, 10);
    if (recent.join('\0') !== prefs.data.recentFiles.join('\0'))
      setPrefs.mutate({ recentFiles: recent });
  };

  const open = (entry: SourceEntry) => {
    setSelected(entry);
    setFocused(entry.path);
    setLine(null);
    setNarrowView('file');
    if (entry.type !== 'dir') remember(entry.path);
  };
  const toggle = useCallback((dir: string, isOpen: boolean) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (isOpen) next.add(dir);
      else next.delete(dir);
      return next;
    });
  }, []);
  const revealDir = (dir: string) => {
    setExpanded((prev) => new Set([...prev, ...ancestorsOf(`${dir}/x`)]));
    setFocused(dir);
    setNarrowView('tree');
  };
  const loadMore = (dir: string) =>
    setPages((prev) => ({ ...prev, [dir]: (prev[dir] ?? 1) + 1 }));
  const retry = (dir: string) =>
    void qc.invalidateQueries({
      predicate: ({ queryKey: k }) =>
        k[0] === 'src-dir' && k[2] === repoId && k[5] === dir,
    });

  const [refreshing, setRefreshing] = useState(false);
  const refresh = () => {
    setRefreshing(true);
    void refreshSource(qc, repoId).finally(() => setRefreshing(false));
  };

  const reveal = useMutation({
    mutationFn: (path: string) => source().reveal({ id: repoId, path }),
    onError: (err) =>
      toast({
        tone: 'danger',
        title: "Couldn't show it",
        description: ipcErrorMessage(err, 'Try again.'),
      }),
  });
  const copyFull = useCopyFilePath(repoId);
  const openInEditor = useOpenInEditor(repoId);
  const save = useMutation({
    mutationFn: (entry: SourceEntry) =>
      source().remoteSave({ id: repoId, oid: entry.oid!, path: entry.path }),
    onSuccess: (result) => {
      if (!result.ok)
        toast({
          tone: 'danger',
          title: PROBLEM_TEXT[result.problem].title,
          description: PROBLEM_TEXT[result.problem].body,
        });
      else if (result.outcome === 'saved')
        toast({ tone: 'success', title: 'Copy saved' });
      else if (result.outcome === 'too-large')
        toast({
          tone: 'danger',
          title: 'Too large to save from here',
          description: 'Files over 5 MB come with a clone of the repository.',
        });
    },
    onError: (err) =>
      toast({
        tone: 'danger',
        title: "Couldn't save a copy",
        description: ipcErrorMessage(err, 'Try again.'),
      }),
  });

  const failed = (title: string) => (err: unknown) =>
    toast({
      tone: 'danger',
      title,
      description: ipcErrorMessage(err, 'Try again in a moment.'),
    });
  const menu = (entry: SourceEntry) => {
    const folder = entry.type === 'dir';
    return (
      <>
        {folder ? (
          <ContextMenuItem
            onSelect={() => toggle(entry.path, !expanded.has(entry.path))}
          >
            <ListTree /> {expanded.has(entry.path) ? 'Collapse' : 'Expand'}
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={() => open(entry)}>
            <FileText /> Open
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onSelect={() =>
            void navigator.clipboard
              .writeText(entry.path)
              .then(
                () => toast({ tone: 'success', title: 'Path copied' }),
                failed("Couldn't copy the path"),
              )
          }
        >
          <Copy /> Copy path
        </ContextMenuItem>
        {worktree && (
          <ContextMenuItem
            onSelect={() =>
              copyFull.mutate(entry.path, {
                onSuccess: () =>
                  toast({ tone: 'success', title: 'Full path copied' }),
                onError: failed("Couldn't copy the path"),
              })
            }
          >
            <Copy /> Copy full path
          </ContextMenuItem>
        )}
        {(worktree ||
          (mode.kind === 'remote' && !folder && entry.type === 'file')) && (
          <ContextMenuSeparator />
        )}
        {worktree && (
          <ContextMenuItem onSelect={() => reveal.mutate(entry.path)}>
            <FolderOpen /> {fileManagerLabel()}
          </ContextMenuItem>
        )}
        {worktree && !folder && (
          <ContextMenuItem
            onSelect={() =>
              openInEditor.mutate(
                { path: entry.path, line: null },
                { onError: failed("Couldn't open it") },
              )
            }
          >
            <Code2 /> Open in editor
          </ContextMenuItem>
        )}
        {local && entry.status && !folder && (
          <ContextMenuItem
            onSelect={() =>
              navigate({ name: 'repository', id: local.id, tab: 'changes' })
            }
          >
            <ArrowLeftRight /> Show the change
          </ContextMenuItem>
        )}
        {mode.kind === 'remote' && entry.type === 'file' && (
          <ContextMenuItem onSelect={() => save.mutate(entry)}>
            <Download /> Save a copy
          </ContextMenuItem>
        )}
      </>
    );
  };

  // Layout: the repository's own choice, else Settings › Files; Auto splits from 960px.
  const chosen =
    prefs.data && prefs.data.sourceLayout !== 'global'
      ? prefs.data.sourceLayout
      : (settings?.sourceLayout ?? 'auto');
  const layout =
    chosen !== 'centered' && width >= (chosen === 'split' ? 700 : 960)
      ? 'split'
      : chosen !== 'centered' && width > 0 && width < 700
        ? 'narrow'
        : 'centered';

  // The divider between tree and file: drag, or focus it and use the arrow keys.
  const [treeWidth, setTreeWidth] = useState<number | null>(null);
  const shownWidth = treeWidth ?? settings?.sourceTreeWidth ?? 300;
  const clampWidth = (w: number) => Math.round(Math.min(560, Math.max(200, w)));
  const saveWidth = (w: number) =>
    updateSettings.mutate({ sourceTreeWidth: clampWidth(w) });
  const drag = useRef<{ x: number; start: number } | null>(null);
  const onDividerDown = (event: PointerEvent<HTMLDivElement>) => {
    event.currentTarget.setPointerCapture(event.pointerId);
    drag.current = { x: event.clientX, start: shownWidth };
  };
  const onDividerMove = (event: PointerEvent<HTMLDivElement>) => {
    if (drag.current)
      setTreeWidth(
        clampWidth(drag.current.start + event.clientX - drag.current.x),
      );
  };
  const onDividerUp = () => {
    if (drag.current) saveWidth(shownWidth);
    drag.current = null;
  };
  const onDividerKey = (event: KeyboardEvent<HTMLDivElement>) => {
    const step =
      event.key === 'ArrowLeft' ? -12 : event.key === 'ArrowRight' ? 12 : 0;
    if (!step) return;
    event.preventDefault();
    const next = clampWidth(shownWidth + step);
    setTreeWidth(next);
    saveWidth(next);
  };

  // Snapshot picker.
  const branches = useBranches(repoId, local?.statusAt ?? null, !!local);
  const currentRemoteBranch =
    remoteRef === 'HEAD' && mode.kind === 'remote'
      ? mode.defaultBranch
      : remoteRef;
  const snapshotLabel = local
    ? localSnap.snapshot.kind === 'worktree'
      ? 'Working tree'
      : localSnap.snapshot.kind === 'index'
        ? 'Staged'
        : `${localSnap.ref ?? 'Commit'} at ${localSnap.snapshot.oid.slice(0, 7)}`
    : head.data?.ok
      ? `${/^[0-9a-f]{40,64}$/.test(currentRemoteBranch) ? 'Commit' : currentRemoteBranch} at ${head.data.value.commit.slice(0, 7)}`
      : 'Hosted copy';
  const pickLocal = (next: LocalSnapshot) => {
    setLocalSnap(next);
    setForce(null);
  };
  const pickBranch = useMutation({
    mutationFn: async (name: string) => ({
      name,
      oid: (await source().resolve({ id: repoId, ref: name })).oid,
    }),
    onSuccess: ({ name, oid }) =>
      pickLocal({ snapshot: { kind: 'commit', oid }, ref: name }),
    onError: failed("Couldn't open that branch"),
  });
  const moved =
    mode.kind === 'remote' &&
    head.data?.ok &&
    remoteBranches.data?.ok &&
    !/^[0-9a-f]{40,64}$/.test(remoteRef) &&
    remoteBranches.data.branches.find((b) => b.name === currentRemoteBranch)
      ?.oid !== undefined &&
    remoteBranches.data.branches.find((b) => b.name === currentRemoteBranch)
      ?.oid !== head.data.value.commit;

  const picker = (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          size="sm"
          className="w-full min-w-0 justify-between"
          aria-label={`Showing ${snapshotLabel}. Change what is shown`}
        >
          <span className="flex min-w-0 items-center gap-1.5">
            {localSnap.snapshot.kind === 'commit' || mode.kind === 'remote' ? (
              <GitBranch />
            ) : (
              <ListTree />
            )}
            <span className="truncate">{snapshotLabel}</span>
          </span>
          <ChevronsUpDown className="text-muted" />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-h-96 overflow-y-auto">
        {local ? (
          <>
            <DropdownMenuItem
              onSelect={() =>
                pickLocal({ snapshot: { kind: 'worktree' }, ref: null })
              }
            >
              {localSnap.snapshot.kind === 'worktree' ? (
                <Check />
              ) : (
                <span className="size-4" />
              )}
              Working tree
              <span className="ml-auto text-xs text-muted">on disk</span>
            </DropdownMenuItem>
            <DropdownMenuItem
              onSelect={() =>
                pickLocal({ snapshot: { kind: 'index' }, ref: null })
              }
            >
              {localSnap.snapshot.kind === 'index' ? (
                <Check />
              ) : (
                <span className="size-4" />
              )}
              Staged
              <span className="ml-auto text-xs text-muted">next commit</span>
            </DropdownMenuItem>
            {!!branches.data?.local.length && (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuLabel className="text-xs text-muted">
                  Branches
                </DropdownMenuLabel>
                {branches.data.local.slice(0, 30).map((b) => (
                  <DropdownMenuItem
                    key={b.name}
                    onSelect={() => pickBranch.mutate(b.name)}
                  >
                    {localSnap.ref === b.name ? (
                      <Check />
                    ) : (
                      <span className="size-4" />
                    )}
                    <span className="truncate font-mono text-[0.78125rem]">
                      {b.name}
                    </span>
                    <span className="ml-auto font-mono text-xs text-muted">
                      {b.oid.slice(0, 7)}
                    </span>
                  </DropdownMenuItem>
                ))}
              </>
            )}
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() =>
                navigate({ name: 'repository', id: repoId, tab: 'history' })
              }
            >
              <span className="size-4" />
              Pick a commit in History
            </DropdownMenuItem>
          </>
        ) : remoteBranches.data?.ok ? (
          remoteBranches.data.branches.map((b) => (
            <DropdownMenuItem
              key={b.name}
              onSelect={() => setRemoteRef(b.name)}
            >
              {currentRemoteBranch === b.name ? (
                <Check />
              ) : (
                <span className="size-4" />
              )}
              <span className="truncate font-mono text-[0.78125rem]">
                {b.name}
              </span>
              <span className="ml-auto font-mono text-xs text-muted">
                {b.oid.slice(0, 7)}
              </span>
            </DropdownMenuItem>
          ))
        ) : (
          <DropdownMenuLabel className="text-xs text-muted">
            {remoteBranches.isPending
              ? 'Loading branches…'
              : 'Branches couldn’t load.'}
          </DropdownMenuLabel>
        )}
      </DropdownMenuContent>
    </DropdownMenu>
  );

  // Filter: every local path Git knows (tracked and untracked, ignored left out); for a hosted
  // repository only the folders already opened, and the label says so.
  const search = usePathSearch(repoId, filter, !!local);
  const remoteMatches = useMemo(() => {
    if (local || !filter.trim()) return [];
    const q = filter.trim().toLowerCase();
    const all: SourceEntry[] = [];
    for (const state of dirs.values())
      for (const e of state.entries)
        if (e.path.toLowerCase().includes(q)) all.push(e);
    return all.slice(0, 200);
  }, [local, filter, dirs]);
  const filtering = filter.trim().length > 0;

  const typedIcons = settings?.sourceFileIcons ?? true;
  const deleted = useRepositoryChanges(
    repoId,
    local?.statusAt ?? null,
    worktree,
  );
  const deletedCount = worktree
    ? new Set(
        (deleted.data?.files ?? [])
          .filter((f) => f.code === 'D')
          .map((f) => f.path),
      ).size
    : 0;

  const filterResults = (
    <div className="min-h-0 flex-1 overflow-auto px-2 pb-2">
      <p className="px-2 pt-1 pb-2 text-xs text-muted">
        {local
          ? 'Paths in this repository. Ignored files are left out.'
          : 'Folders you’ve opened in this commit.'}
      </p>
      {local && search.isPending ? (
        <div className="px-2">
          <Loading label="Searching paths" />
        </div>
      ) : local && search.isError ? (
        <EmptyState
          compact
          className="px-2"
          art={<NoResultsArt />}
          title="Search didn’t run"
          action={
            <Button size="sm" onClick={() => void search.refetch()}>
              Try again
            </Button>
          }
        >
          {ipcErrorMessage(search.error, 'Git couldn’t list the paths.')}
        </EmptyState>
      ) : (local
          ? (search.data?.matches.length ?? 0)
          : remoteMatches.length) === 0 ? (
        <EmptyState
          compact
          className="px-2"
          art={<NoResultsArt />}
          title={`No paths match “${filter.trim()}”`}
          action={
            <Button size="sm" onClick={() => setFilter('')}>
              <X /> Clear filter
            </Button>
          }
        >
          {local
            ? 'The filter checks tracked and untracked paths.'
            : 'Open more folders to search them too.'}
        </EmptyState>
      ) : (
        <ul aria-label="Matching paths">
          {(local
            ? search.data!.matches.map((path) => ({
                name: path.split('/').pop()!,
                path,
                type: 'file' as const,
                size: null,
                oid: null,
                status: null,
                ignored: false,
                changes: false,
              }))
            : remoteMatches
          ).map((entry) => {
            const Icon = iconFor(entry, false, typedIcons);
            const dir = entry.path.slice(
              0,
              Math.max(0, entry.path.lastIndexOf('/') + 1),
            );
            return (
              <li key={entry.path}>
                <button
                  type="button"
                  title={describeEntry(entry)}
                  onClick={() => {
                    if (entry.type === 'dir') revealDir(entry.path);
                    else {
                      setExpanded(
                        (prev) =>
                          new Set([...prev, ...ancestorsOf(entry.path)]),
                      );
                      open(entry);
                    }
                  }}
                  className={cn(
                    'flex h-7 w-full items-center gap-1.5 rounded-[4px] px-2 text-left text-[0.8125rem] hover:bg-row-hover focus-visible:outline-offset-[-2px]',
                  )}
                >
                  <Icon
                    aria-hidden
                    className={cn(
                      'size-4 shrink-0',
                      selected?.path === entry.path
                        ? 'text-accent'
                        : 'text-muted',
                    )}
                  />
                  <span className="min-w-0 truncate font-mono text-[0.78125rem]">
                    <span className="text-muted">{dir}</span>
                    <span
                      className={
                        selected?.path === entry.path
                          ? 'font-semibold text-accent'
                          : 'text-ink'
                      }
                    >
                      {entry.name}
                    </span>
                  </span>
                </button>
              </li>
            );
          })}
          {local &&
            search.data &&
            search.data.total > search.data.matches.length && (
              <li className="px-2 pt-1 text-xs text-muted">
                Showing {search.data.matches.length} of{' '}
                {search.data.total.toLocaleString()}. Type more to narrow it.
              </li>
            )}
        </ul>
      )}
    </div>
  );

  const signIn = useSignIn();
  // The whole tab can't show anything: the hosted copy didn't load.
  const headProblem =
    mode.kind === 'remote' && head.data && !head.data.ok
      ? head.data.problem
      : null;
  if (
    mode.kind === 'remote' &&
    (head.isPending || headProblem || head.isError)
  ) {
    if (head.isPending)
      return (
        <div ref={measure} className="px-6">
          <Loading label="Loading the hosted files" />
        </div>
      );
    const problem = headProblem ?? 'failed';
    const text = PROBLEM_TEXT[problem];
    const action =
      problem === 'signed-out' ? (
        <Button
          variant="primary"
          pending={signIn.isPending}
          onClick={() => signIn.mutate()}
        >
          Sign in
        </Button>
      ) : problem === 'local-only' ? (
        <Button
          onClick={() =>
            navigate({
              name: 'settings',
              section: 'general',
              row: 'local-only',
            })
          }
        >
          Open Settings
        </Button>
      ) : problem === 'hosting-off' && mode.localId ? (
        <Button
          onClick={() =>
            navigate({ name: 'repository', id: mode.localId!, tab: 'source' })
          }
        >
          Open the local copy
        </Button>
      ) : problem === 'ref-gone' ? (
        <Button onClick={() => setRemoteRef('HEAD')}>
          Show {mode.defaultBranch}
        </Button>
      ) : (
        <Button pending={head.isFetching} onClick={() => void head.refetch()}>
          {!head.isFetching && <RefreshCw />}
          Try again
        </Button>
      );
    return (
      <div ref={measure} className="flex-1">
        <EmptyState
          art={problem === 'offline' ? <OfflineArt /> : <RemoteArt />}
          title={text.title}
          action={action}
        >
          {text.body}
        </EmptyState>
      </div>
    );
  }

  const treePane = (
    <section
      aria-label="Files"
      className={cn(
        'flex min-h-0 flex-col',
        layout !== 'narrow' && 'border-r border-line',
      )}
    >
      <div className="flex flex-none flex-col gap-2 p-3 pb-2">
        {picker}
        <label className="field flex h-8 items-center gap-2 px-2.5 text-sm">
          <Search aria-hidden className="size-4 shrink-0 text-muted" />
          <input
            ref={filterRef}
            type="search"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setFilter('')}
            placeholder={local ? 'Filter files' : 'Filter opened folders'}
            aria-label={local ? 'Filter files' : 'Filter opened folders'}
            className="min-w-0 flex-1 bg-transparent text-ink outline-none placeholder:text-muted"
          />
        </label>
        <div className="flex items-center justify-between gap-2">
          {worktree ? (
            <label className="flex items-center gap-2 text-[0.8125rem] text-muted">
              <Checkbox
                checked={options.showIgnored}
                onCheckedChange={(value) => setShowIgnored(value === true)}
              />
              Show ignored files
            </label>
          ) : (
            <span className="text-xs text-muted">
              {local
                ? 'Read from Git, not the folder on disk'
                : 'Pinned to one commit'}
            </span>
          )}
          <Button
            size="sm"
            variant="ghost"
            pending={refreshing}
            onClick={refresh}
          >
            {!refreshing && <RefreshCw />}
            Refresh
          </Button>
        </div>
      </div>
      {filtering ? (
        filterResults
      ) : root?.error === 'load' && !root.entries.length ? (
        <EmptyState
          compact
          className="px-3"
          art={<FilesArt />}
          title="Couldn’t read the files"
          action={
            <Button size="sm" pending={refreshing} onClick={refresh}>
              {!refreshing && <RefreshCw />}Try again
            </Button>
          }
        >
          Git stopped before it listed them. Your files are unchanged.
        </EmptyState>
      ) : root && !root.loading && !root.entries.length && !root.problem ? (
        <EmptyState
          compact
          className="px-3"
          art={<FilesArt />}
          title={worktree ? 'No files yet' : 'Nothing in this snapshot'}
          action={
            worktree ? (
              <Button
                size="sm"
                pending={reveal.isPending}
                onClick={() => reveal.mutate('')}
              >
                {!reveal.isPending && <FolderOpen />}
                {fileManagerLabel()}
              </Button>
            ) : (
              <Button
                size="sm"
                onClick={() =>
                  pickLocal({ snapshot: { kind: 'worktree' }, ref: null })
                }
              >
                Show the working tree
              </Button>
            )
          }
        >
          {worktree
            ? 'Files you add to this folder show up here.'
            : 'No files were committed or staged here yet.'}
        </EmptyState>
      ) : (
        <SourceTree
          label={`Files in ${local?.name ?? (mode.kind === 'remote' ? mode.name : '')}`}
          rows={rows}
          focused={focused}
          selected={selectedEntry?.path ?? null}
          typedIcons={typedIcons}
          onFocus={setFocused}
          onOpen={open}
          onToggle={toggle}
          onLoadMore={loadMore}
          onRetry={retry}
          menu={menu}
        />
      )}
      {deletedCount > 0 && !filtering && (
        <Button
          variant="link"
          size="sm"
          className="mx-4 mb-3 flex-none justify-start text-[0.8125rem]"
          onClick={() =>
            navigate({ name: 'repository', id: repoId, tab: 'changes' })
          }
        >
          {deletedCount} deleted {deletedCount === 1 ? 'file is' : 'files are'}{' '}
          in Changes
        </Button>
      )}
    </section>
  );

  const recent = prefs.data?.recentFiles[0];
  const readme = root?.entries.find(
    (e) => /^readme(\.|$)/i.test(e.name) && e.type === 'file',
  );
  const fileValue = fileQuery.data;
  const viewer =
    selectedEntry && selectedEntry.type !== 'dir' ? (
      <SourceViewer
        key={`${snapshotKey(localSnap.snapshot)}:${selectedEntry.path}`}
        entry={selectedEntry}
        file={fileValue}
        isLoading={fileQuery.isFetching}
        error={fileQuery.error}
        snapshotLabel={snapshotLabel}
        line={line}
        lastChange={lastChange.data ?? null}
        actions={{
          local: worktree
            ? {
                repoId,
                reveal: () => reveal.mutate(selectedEntry.path),
                revealing: reveal.isPending,
              }
            : null,
          remote:
            mode.kind === 'remote'
              ? {
                  save: () => save.mutate(selectedEntry),
                  saving: save.isPending,
                }
              : null,
        }}
        onShowAnyway={() => setForce(selectedEntry.path)}
        onRefresh={() => void fileQuery.refetch()}
        refreshing={fileQuery.isFetching}
        onCrumb={revealDir}
        onBack={layout === 'narrow' ? () => setNarrowView('tree') : null}
      />
    ) : (
      <div className="flex min-h-0 flex-1 flex-col">
        <EmptyState
          art={<FilesArt />}
          title="Pick a file to read"
          action={
            recent ? (
              <Button
                onClick={() => {
                  setExpanded((p) => new Set([...p, ...ancestorsOf(recent)]));
                  open({
                    name: recent.split('/').pop()!,
                    path: recent,
                    type: 'file',
                    size: null,
                    oid: null,
                    status: null,
                    ignored: false,
                    changes: false,
                  });
                }}
              >
                Open {recent.split('/').pop()}
              </Button>
            ) : readme ? (
              <Button onClick={() => open(readme)}>Open {readme.name}</Button>
            ) : (
              <Button onClick={() => filterRef.current?.focus()}>
                <Search /> Filter files
              </Button>
            )
          }
        >
          Choose one in the tree, or type part of its name in Filter files.
        </EmptyState>
      </div>
    );

  return (
    <div ref={measure} className="flex min-h-0 flex-1 flex-col">
      {moved && (
        <div
          role="status"
          className="flex flex-none flex-wrap items-center gap-2 border-b border-line bg-sunken px-6 py-2 text-[0.8125rem] text-ink"
        >
          <span className="min-w-0 flex-1">
            <span className="font-mono">{currentRemoteBranch}</span> has moved
            since you opened it. These files are from{' '}
            <span className="font-mono">
              {head.data?.ok ? head.data.value.commit.slice(0, 7) : ''}
            </span>
            .
          </span>
          <Button
            size="sm"
            pending={head.isFetching}
            onClick={() => void head.refetch()}
          >
            {!head.isFetching && <RefreshCw />}
            Show latest
          </Button>
        </div>
      )}
      {layout === 'narrow' ? (
        narrowView === 'file' &&
        selectedEntry &&
        selectedEntry.type !== 'dir' ? (
          viewer
        ) : (
          treePane
        )
      ) : (
        <div
          className="grid min-h-0 flex-1"
          style={{
            gridTemplateColumns:
              layout === 'split'
                ? `${shownWidth}px 6px minmax(0,1fr)`
                : '240px minmax(0,1fr)',
          }}
        >
          {treePane}
          {layout === 'split' && (
            <div
              role="separator"
              aria-orientation="vertical"
              aria-label="Resize the file list"
              aria-valuenow={shownWidth}
              aria-valuemin={200}
              aria-valuemax={560}
              tabIndex={0}
              onPointerDown={onDividerDown}
              onPointerMove={onDividerMove}
              onPointerUp={onDividerUp}
              onKeyDown={onDividerKey}
              className="cursor-col-resize outline-offset-[-2px] hover:bg-control focus-visible:bg-control"
            />
          )}
          <div
            className={cn(
              'flex min-h-0 min-w-0 flex-col',
              layout === 'centered' && 'items-stretch',
            )}
          >
            {layout === 'centered' ? (
              <div className="mx-auto flex min-h-0 w-full max-w-(--content-max) flex-1 flex-col">
                {viewer}
              </div>
            ) : (
              viewer
            )}
          </div>
        </div>
      )}
    </div>
  );
}
