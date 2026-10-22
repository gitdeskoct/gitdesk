import {
  createColumnHelper,
  createSortedRowModel,
  rowSelectionFeature,
  rowSortingFeature,
  sortFn_alphanumeric,
  sortFn_basic,
  tableFeatures,
  useTable,
  type RowSelectionState,
  type SortingState,
} from '@tanstack/react-table';
import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  CircleCheck,
  Clock,
  CloudDownload,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useEffect, useMemo, useState, type KeyboardEvent } from 'react';
import type {
  RemoteRepository,
  RepositorySummary,
} from '../../../shared/repos';
import {
  NoResultsArt,
  OfflineArt,
  RemoteArt,
  RepositoriesArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { EmptyState } from '../../components/ui/empty-state';
import { Pager, usePage } from '../../components/ui/pager';
import { Segmented } from '../../components/ui/segmented';
import { Spinner } from '../../components/ui/spinner';
import { InlineStatus, Loading } from '../../components/ui/status';
import { useToast } from '../../components/ui/toast';
import { cn } from '../../lib/cn';
import { relativeTime, useNow } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  changeCount,
  inScope,
  isProblem,
  itemName,
  repoItems,
  syncState,
  treeState,
  type RepoItem,
} from '../../lib/repo-status';
import {
  useAuthStatus,
  usePinRepository,
  useRefreshRepositories,
  useRemoteList,
  useRemoteOverview,
  useRemoveRepository,
  useRepositories,
  useSettings,
  useSignIn,
} from '../../lib/queries';
import {
  useNavigation,
  type RepoScope,
  type RepoShow,
} from '../../app/navigation';
import { useWorkspaceUi } from '../../app/workspace-ui';
import { remoteContext, Stat } from '../home/stats-strip';
import { AddNotice } from '../home/workspace-sections';
import { REMOTE_STATUS, RepoTags } from '../repository/history';
import { RepositoryInspector } from '../repository/repository-inspector';
import { Page, PageTitle } from '../shell/page';
import { ClonePanel } from './clone-panel';
import { CreatePanel } from './create-panel';
import { ManageBand, type ManageMode } from './manage';
import { useWidth } from '../../lib/use-width';
import { useOpenRepo } from './repo-row';
import {
  RepoContextMenu,
  RepoMenuButton,
  useRemoteActions,
  useRepoActions,
} from './repo-actions';
import { BranchLabel, SyncChip, TreeChip } from './status';

type Show = RepoShow;

// Below these widths the list and the selected repository can't both stay readable side by side.
const SPLIT_MIN = { split: 860, auto: 1100 };

// Big enough to scan at a glance, small enough that one page never turns into a long scroll.
const PAGE_SIZE = 20;

const features = tableFeatures({
  rowSortingFeature,
  rowSelectionFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
});

const column = createColumnHelper<typeof features, RepoItem>();

const local = (item: RepoItem) => (item.kind === 'local' ? item.repo : null);

// Sort keys: what each column means to a person scanning the table, not its display text.
// A remote-only repository has no working tree here, so it sorts below every local one.
const columns = column.columns([
  column.accessor(itemName, {
    id: 'name',
    header: 'Name',
    sortFn: 'alphanumeric',
  }),
  column.accessor(
    (item) =>
      item.kind === 'local'
        ? (item.repo.status?.branch ?? '')
        : item.remote.defaultBranch,
    { id: 'branch', header: 'Branch', sortFn: 'alphanumeric' },
  ),
  column.accessor(
    (item) => {
      const repo = local(item);
      return repo
        ? (treeState(repo) === 'conflict' ? 10_000 : 0) +
            changeCount(repo.status)
        : -1;
    },
    {
      id: 'tree',
      header: 'Working tree',
      sortFn: 'basic',
      sortDescFirst: true,
    },
  ),
  column.accessor(
    (item) => {
      const status = local(item)?.status;
      return status ? (status.ahead ?? 0) + (status.behind ?? 0) : -1;
    },
    { id: 'sync', header: 'Sync', sortFn: 'basic', sortDescFirst: true },
  ),
  column.accessor(
    (item) =>
      item.kind === 'local'
        ? (item.repo.lastOpenedAt ?? item.repo.addedAt)
        : item.remote.updatedAt,
    {
      id: 'opened',
      header: 'Last opened',
      sortFn: 'basic',
      sortDescFirst: true,
    },
  ),
]);

function matchesState(repo: RepositorySummary, show: Show): boolean {
  const sync = syncState(repo);
  switch (show) {
    case 'changed':
      return ['changed', 'conflict'].includes(treeState(repo));
    case 'ahead':
      return sync === 'ahead' || sync === 'diverged';
    case 'behind':
      return sync === 'behind' || sync === 'diverged';
    case 'problems':
      return isProblem(repo);
    default:
      return true;
  }
}

// State filters describe a working tree, so they only ever match repositories on this computer.
function matches(
  item: RepoItem,
  scope: RepoScope,
  show: Show,
  query: string,
): boolean {
  if (!inScope(item, scope)) return false;
  if (
    show !== 'all' &&
    (item.kind !== 'local' || !matchesState(item.repo, show))
  )
    return false;
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack = (
    item.kind === 'local'
      ? `${item.repo.name} ${item.repo.displayPath} ${item.repo.status?.branch ?? ''} ${item.repo.description ?? ''}`
      : `${item.remote.name} ${item.remote.defaultBranch} ${item.remote.description ?? ''}`
  ).toLowerCase();
  return words.every((word) => haystack.includes(word));
}

const STATUS_ICON = {
  ready: CircleCheck,
  provisioning: Clock,
  failed: CircleAlert,
  deleting: CircleAlert,
};

function RemoteStatus({ remote }: { remote: RemoteRepository }) {
  const Icon = STATUS_ICON[remote.status];
  return (
    <span className="inline-flex items-center gap-1.5 text-[0.8125rem] font-medium whitespace-nowrap text-ink">
      <Icon
        aria-hidden
        className={cn(
          'size-3.5',
          remote.status === 'ready'
            ? 'text-success'
            : remote.status === 'provisioning'
              ? 'text-warning'
              : 'text-danger',
        )}
      />
      {REMOTE_STATUS[remote.status].label}
    </span>
  );
}

function LocalRow({
  repo,
  remote,
  selected,
  onSelect,
}: {
  repo: RepositorySummary;
  remote: RemoteRepository | null;
  selected: boolean;
  onSelect: (selected: boolean) => void;
}) {
  const openRepo = useOpenRepo();
  const [mode, setMode] = useState<ManageMode | null>(null);
  const { actions, busy } = useRepoActions(repo, setMode, remote);
  const missing = repo.availability !== 'available';
  return (
    <>
      <RepoContextMenu actions={actions} onOpen={() => openRepo(repo.id)}>
        <tr
          className={cn(
            'border-b border-line transition-colors',
            selected ? 'bg-accent-soft' : 'hover:bg-row-hover',
          )}
        >
          <td className="w-10 py-3 pl-3">
            <Checkbox
              checked={selected}
              onCheckedChange={(next) => onSelect(next === true)}
              aria-label={`Select ${repo.name}`}
            />
          </td>
          <td className="w-[34%] max-w-0 py-3 pr-4">
            <button
              type="button"
              onClick={() => openRepo(repo.id)}
              className="block max-w-full rounded-sm text-left"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'truncate text-sm font-semibold hover:underline',
                    missing ? 'text-muted' : 'text-ink',
                  )}
                >
                  {repo.name}
                </span>
                <RepoTags local remote={!!repo.remoteId} compact />
              </span>
              <span className="block truncate font-mono text-xs text-muted">
                {repo.displayPath}
              </span>
            </button>
          </td>
          <td className="max-w-0 py-3 pr-4">
            <BranchLabel repo={repo} />
          </td>
          {busy ? (
            <td colSpan={2} className="py-3 pr-4">
              <span className="inline-flex items-center gap-1.5 text-[0.8125rem] text-muted">
                <Spinner className="size-3.5" />
                {busy}
              </span>
            </td>
          ) : (
            <>
              <td className="py-3 pr-4">
                <TreeChip repo={repo} />
              </td>
              <td className="py-3 pr-4">
                <SyncChip repo={repo} />
              </td>
            </>
          )}
          <td className="py-3 pr-4 text-[0.8125rem] whitespace-nowrap text-muted">
            {relativeTime(repo.lastOpenedAt ?? repo.addedAt)}
          </td>
          <td className="w-10 py-3 pr-2">
            <RepoMenuButton name={repo.name} actions={actions} />
          </td>
        </tr>
      </RepoContextMenu>
      {mode && (
        <tr>
          <td colSpan={7} className="p-0">
            <ManageBand
              mode={mode}
              repo={repo}
              remote={remote}
              onClose={() => setMode(null)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function RemoteRow({ remote }: { remote: RemoteRepository }) {
  const { navigate } = useNavigation();
  const [mode, setMode] = useState<ManageMode | null>(null);
  const { actions, busy } = useRemoteActions(remote, setMode);
  const open = () => navigate({ name: 'remote-repository', id: remote.id });
  return (
    <>
      <RepoContextMenu actions={actions} onOpen={open}>
        <tr className="border-b border-line transition-colors hover:bg-row-hover">
          {/* Bulk actions act on registrations on this computer; there is none here. */}
          <td className="w-10 py-3 pl-3" />
          <td className="w-[34%] max-w-0 py-3 pr-4">
            <button
              type="button"
              onClick={open}
              className="block max-w-full rounded-sm text-left"
            >
              <span className="flex min-w-0 items-center gap-2">
                <span className="truncate text-sm font-semibold text-ink hover:underline">
                  {remote.name}
                </span>
                <RepoTags local={false} remote compact />
              </span>
              <span className="block truncate text-xs text-muted">
                Not on this computer · Private
              </span>
            </button>
          </td>
          <td className="max-w-0 py-3 pr-4">
            <span className="block truncate font-mono text-[0.78125rem] text-muted">
              {remote.defaultBranch}
            </span>
          </td>
          <td className="py-3 pr-4 text-[0.8125rem] text-muted">Not cloned</td>
          <td className="py-3 pr-4">
            {busy ? (
              <span className="inline-flex items-center gap-1.5 text-[0.8125rem] text-muted">
                <Spinner className="size-3.5" />
                {busy}
              </span>
            ) : (
              <RemoteStatus remote={remote} />
            )}
          </td>
          <td className="py-3 pr-4 text-[0.8125rem] whitespace-nowrap text-muted">
            Updated {relativeTime(remote.updatedAt)}
          </td>
          <td className="w-10 py-3 pr-2">
            <RepoMenuButton name={remote.name} actions={actions} />
          </td>
        </tr>
      </RepoContextMenu>
      {mode && (
        <tr>
          <td colSpan={7} className="p-0">
            <ManageBand
              mode={mode}
              remote={remote}
              onClose={() => setMode(null)}
            />
          </td>
        </tr>
      )}
    </>
  );
}

function BulkBar({
  selected,
  onDone,
}: {
  selected: RepositorySummary[];
  onDone: () => void;
}) {
  const refresh = useRefreshRepositories();
  const pin = usePinRepository();
  const remove = useRemoveRepository();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  // Held for the whole batch, so the spinner doesn't flicker between items.
  const [running, setRunning] = useState<string | null>(null);
  // One at a time, every item attempted; a failure is reported with a count, never dropped.
  const run = async (
    verb: string,
    fn: (repo: RepositorySummary) => Promise<unknown>,
    after?: () => void,
  ) => {
    if (running) return;
    setRunning(verb);
    const failures: { name: string; message: string }[] = [];
    for (const repo of selected) {
      try {
        await fn(repo);
      } catch (err) {
        failures.push({
          name: repo.name,
          message: ipcErrorMessage(err, 'It did not work.'),
        });
      }
    }
    const done = selected.length - failures.length;
    if (failures.length)
      toast({
        tone: 'danger',
        title: `${done} of ${selected.length} ${verb}`,
        description: failures
          .slice(0, 2)
          .map((f) => `${f.name}: ${f.message}`)
          .join(' '),
      });
    else
      toast({
        tone: 'success',
        title: `${done} ${done === 1 ? 'repository' : 'repositories'} ${verb}`,
      });
    setRunning(null);
    after?.();
  };
  const allPinned = selected.every((repo) => repo.pinned);

  if (confirming)
    return (
      <div className="mb-3 flex flex-wrap items-center gap-3 rounded-sm bg-danger-soft px-3 py-2.5 text-[0.8125rem] text-ink">
        <span className="flex-1">
          Remove {selected.length} repositories from gitdesk? Their folders and
          history stay on disk.
        </span>
        <Button
          size="sm"
          variant="danger"
          pending={running === 'removed'}
          onClick={() =>
            void run('removed', (repo) => remove.mutateAsync(repo.id), onDone)
          }
        >
          Remove
        </Button>
        <Button
          size="sm"
          variant="ghost"
          onClick={() => setConfirming(false)}
          autoFocus
        >
          Cancel
        </Button>
      </div>
    );
  return (
    <div
      role="toolbar"
      aria-label="Selected repositories"
      className="mb-3 flex flex-wrap items-center gap-2 rounded-sm bg-accent-soft px-3 py-2 text-[0.8125rem] text-ink"
    >
      <b className="mr-1 font-semibold">{selected.length} selected</b>
      <Button
        size="sm"
        className="bg-surface"
        pending={running === 'checked'}
        onClick={() =>
          void run('checked', (repo) => refresh.mutateAsync(repo.id))
        }
      >
        Refresh status
      </Button>
      <Button
        size="sm"
        className="bg-surface"
        pending={running === 'pinned' || running === 'unpinned'}
        onClick={() =>
          void run(allPinned ? 'unpinned' : 'pinned', (repo) =>
            pin.mutateAsync({ id: repo.id, pinned: !allPinned }),
          )
        }
      >
        {allPinned ? 'Unpin' : 'Pin'}
      </Button>
      <Button
        size="sm"
        className="bg-surface text-danger"
        onClick={() => setConfirming(true)}
      >
        Remove from gitdesk
      </Button>
      <span className="ml-auto text-muted">
        Files on disk are never touched.
      </span>
    </div>
  );
}

function RepoTable({
  items,
  resetKey,
}: {
  items: RepoItem[];
  // Changes when the filter or search does.
  resetKey: string;
}) {
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'opened', desc: true },
  ]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const table = useTable(
    {
      features,
      columns,
      data: items,
      getRowId: (item) => item.key,
      enableRowSelection: (row) => row.original.kind === 'local',
      state: { sorting, rowSelection },
      onSortingChange: setSorting,
      onRowSelectionChange: setRowSelection,
      enableSortingRemoval: false,
    },
    (state) => ({ sorting: state.sorting, rowSelection: state.rowSelection }),
  );
  const rows = table.getRowModel().rows;
  const paged = usePage(rows, PAGE_SIZE);
  const { setPage } = paged;
  // A new filter starts on its first page, and rows it hides must not stay selected for a bulk action.
  useEffect(() => {
    setPage(1);
    setRowSelection({});
  }, [resetKey, setPage]);
  // Selection can span pages; "Select all shown" means the page on screen.
  const selected = rows
    .filter((row) => row.getIsSelected())
    .map((row) => local(row.original))
    .filter((repo): repo is RepositorySummary => !!repo);
  const shown = paged.items.filter((row) => row.original.kind === 'local');
  const allShown =
    shown.length > 0 && shown.every((row) => row.getIsSelected());
  const someShown = shown.some((row) => row.getIsSelected());

  return (
    <>
      {selected.length > 0 && (
        <BulkBar selected={selected} onDone={() => setRowSelection({})} />
      )}
      <div className="overflow-x-auto">
        <table className="w-full min-w-[760px] border-collapse text-sm">
          <thead>
            <tr className="border-b border-line">
              <th scope="col" className="w-10 py-2.5 pl-3 text-left">
                <Checkbox
                  aria-label="Select all shown"
                  aria-disabled={!shown.length || undefined}
                  checked={
                    allShown ? true : someShown ? 'indeterminate' : false
                  }
                  onCheckedChange={(next) =>
                    shown.forEach((row) => row.toggleSelected(next === true))
                  }
                />
              </th>
              {table.getHeaderGroups()[0]!.headers.map((header) => {
                const sorted = header.column.getIsSorted();
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={
                      sorted === 'asc'
                        ? 'ascending'
                        : sorted === 'desc'
                          ? 'descending'
                          : 'none'
                    }
                    className="py-2.5 pr-4 text-left text-xs font-medium whitespace-nowrap text-muted"
                  >
                    <button
                      type="button"
                      onClick={header.column.getToggleSortingHandler()}
                      className={cn(
                        'inline-flex items-center gap-1 rounded-sm hover:text-ink',
                        sorted && 'text-ink',
                      )}
                    >
                      <table.FlexRender header={header} />
                      {sorted === 'asc' && (
                        <ArrowUp aria-hidden className="size-3.5" />
                      )}
                      {sorted === 'desc' && (
                        <ArrowDown aria-hidden className="size-3.5" />
                      )}
                    </button>
                  </th>
                );
              })}
              <th scope="col" className="w-10">
                <span className="sr-only">Actions</span>
              </th>
            </tr>
          </thead>
          <tbody>
            {paged.items.map((row) =>
              row.original.kind === 'local' ? (
                <LocalRow
                  key={row.id}
                  repo={row.original.repo}
                  remote={row.original.remote}
                  selected={row.getIsSelected()}
                  onSelect={(next) => row.toggleSelected(next)}
                />
              ) : (
                <RemoteRow key={row.id} remote={row.original.remote} />
              ),
            )}
          </tbody>
        </table>
      </div>
      <Pager label="Repository pages" onPage={setPage} {...paged} />
    </>
  );
}

// A listbox with one tab stop: arrows move the selection, Enter opens the full page. The arrows
// walk past the end of a page; the page follows them.
function RepoList({
  items,
  resetKey,
  selectedKey,
  onPick,
  onOpen,
  picking,
}: {
  items: RepoItem[];
  resetKey: string;
  selectedKey: string | null;
  onPick: (item: RepoItem) => void;
  onOpen: (item: RepoItem) => void;
  // false in a narrow window: there is no inspector, so choosing a row opens it.
  picking: boolean;
}) {
  const id = (item: RepoItem) => `repo-option-${item.key}`;
  const paged = usePage(items, PAGE_SIZE);
  const { setPage } = paged;
  useEffect(() => setPage(1), [resetKey, setPage]);
  const focusKey = paged.items.some((item) => item.key === selectedKey)
    ? selectedKey
    : paged.items[0]?.key;
  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    const index = items.findIndex((item) => item.key === focusKey);
    const step =
      event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (!step) return;
    event.preventDefault();
    const nextIndex = Math.min(items.length - 1, Math.max(0, index + step));
    const next = items[nextIndex];
    if (!next) return;
    onPick(next);
    setPage(Math.floor(nextIndex / PAGE_SIZE) + 1);
    // The row may only exist after the page turns.
    requestAnimationFrame(() => document.getElementById(id(next))?.focus());
  };
  return (
    <>
      <ul
        role="listbox"
        aria-label="Repositories"
        onKeyDown={move}
        className="border-t border-line"
      >
        {paged.items.map((item) => {
          const selected = picking && item.key === selectedKey;
          const repo = local(item);
          return (
            <li
              key={item.key}
              id={id(item)}
              role="option"
              aria-selected={selected}
              tabIndex={item.key === focusKey ? 0 : -1}
              onClick={() => (picking ? onPick(item) : onOpen(item))}
              onDoubleClick={() => onOpen(item)}
              onKeyDown={(event) => event.key === 'Enter' && onOpen(item)}
              className={cn(
                'grid min-h-14 cursor-default gap-1 border-b border-l-2 border-b-line py-2.5 pr-3 pl-2.5 outline-offset-[-2px] transition-colors',
                selected
                  ? 'border-l-accent bg-accent-soft'
                  : 'border-l-transparent hover:bg-row-hover',
              )}
            >
              <span className="flex min-w-0 items-center gap-2">
                <span
                  className={cn(
                    'truncate text-sm font-semibold',
                    repo && repo.availability !== 'available'
                      ? 'text-muted'
                      : 'text-ink',
                  )}
                >
                  {itemName(item)}
                </span>
                <RepoTags
                  local={!!repo}
                  remote={item.kind === 'remote' || !!repo?.remoteId}
                  compact
                />
              </span>
              <span className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1">
                {item.kind === 'local' ? (
                  <>
                    <BranchLabel repo={item.repo} />
                    <TreeChip repo={item.repo} />
                    <SyncChip repo={item.repo} />
                  </>
                ) : (
                  <>
                    <span className="font-mono text-[0.78125rem] text-muted">
                      {item.remote.defaultBranch}
                    </span>
                    <RemoteStatus remote={item.remote} />
                  </>
                )}
              </span>
            </li>
          );
        })}
      </ul>
      <div className="sticky bottom-0 bg-surface px-2.5 pb-2">
        <Pager label="Repository pages" onPage={setPage} {...paged} />
      </div>
    </>
  );
}

export function RepositoriesPage({
  initialShow,
  initialScope,
}: {
  initialShow: Show;
  initialScope: RepoScope;
}) {
  useNow();
  const { navigate } = useNavigation();
  const openRepo = useOpenRepo();
  const repos = useRepositories();
  const ui = useWorkspaceUi();
  const { data: auth } = useAuthStatus();
  const { data: settings } = useSettings();
  const signIn = useSignIn();
  const signedIn = auth?.status === 'authenticated' && !settings?.localOnly;
  const overview = useRemoteOverview();
  const remoteList = useRemoteList('updated', signedIn);
  const refreshAll = useRefreshRepositories();
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<Show>(initialShow);
  const [scope, setScope] = useState<RepoScope>(initialScope);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [measure, width] = useWidth();

  const all = useMemo(() => repos.data ?? [], [repos.data]);
  const remotes = useMemo(
    () => remoteList.data?.pages.flatMap((page) => page.repositories) ?? [],
    [remoteList.data],
  );
  const items = useMemo(() => repoItems(all, remotes), [all, remotes]);
  const shown = useMemo(
    () => items.filter((item) => matches(item, scope, show, query)),
    [items, scope, show, query],
  );
  const counts = useMemo(
    () =>
      Object.fromEntries(
        (['all', 'changed', 'ahead', 'behind', 'problems'] as Show[]).map(
          (key) => [
            key,
            items.filter((item) => matches(item, scope, key, '')).length,
          ],
        ),
      ) as Record<Show, number>,
    [items, scope],
  );

  const layout = settings?.repositoriesLayout ?? 'auto';
  const split = layout !== 'centered' && width >= SPLIT_MIN[layout];
  const narrowSplit = layout === 'split' && width > 0 && !split;
  const selected =
    shown.find((item) => item.key === selectedKey) ?? shown[0] ?? null;
  const more = signedIn && remoteList.hasNextPage;
  const remoteStat = remoteContext(overview.data, overview.isError);
  const pickScope = (next: RepoScope) => {
    setScope(next);
    setSelectedKey(null);
  };
  const open = (item: RepoItem) =>
    item.kind === 'local'
      ? openRepo(item.repo.id)
      : navigate({ name: 'remote-repository', id: item.remote.id });

  const aside =
    ui.panel === 'create' ? (
      <CreatePanel onClose={() => ui.setPanel(null)} />
    ) : ui.panel === 'clone' ? (
      <ClonePanel onClose={() => ui.setPanel(null)} />
    ) : undefined;

  const header = (
    <>
      <Button onClick={() => ui.setPanel('clone')}>
        <CloudDownload />
        Clone
      </Button>
      <Button variant="primary" onClick={() => ui.setPanel('create')}>
        <Plus />
        New repository
      </Button>
    </>
  );

  const remoteWanted = scope === 'remote' || scope === 'linked';
  const resetKey = `${scope}:${show}:${query}`;
  const body = () => {
    if (repos.isPending) return <Loading label="Loading your repositories…" />;
    if (repos.isError)
      return (
        <EmptyState
          art={<OfflineArt />}
          title="Couldn't load your repositories"
          action={
            <Button
              variant="primary"
              pending={repos.isFetching}
              onClick={() => void repos.refetch()}
            >
              Try again
            </Button>
          }
        >
          gitdesk couldn't read its local list, so nothing here would be
          current.
        </EmptyState>
      );
    if (remoteWanted && settings?.localOnly)
      return (
        <EmptyState
          art={<RemoteArt />}
          title="gitdesk is in local-only mode"
          action={
            <Button
              onClick={() =>
                navigate({
                  name: 'settings',
                  section: 'general',
                  row: 'local-only',
                })
              }
            >
              Open settings
            </Button>
          }
        >
          Remote repositories need an account connection.
        </EmptyState>
      );
    if (remoteWanted && !signedIn)
      return (
        <EmptyState
          art={<RemoteArt />}
          title="Sign in to see remote repositories"
          action={
            <Button
              variant="primary"
              pending={signIn.isPending}
              onClick={() => signIn.mutate()}
            >
              Sign in
            </Button>
          }
        >
          Remote repositories live in your gitdesk account. Local ones keep
          working while you're signed out.
        </EmptyState>
      );
    if (remoteWanted && remoteList.isPending)
      return <Loading label="Loading remote repositories…" />;
    if (!items.length && !(signedIn && remoteList.isPending))
      return (
        <EmptyState
          art={<RepositoriesArt />}
          title="No repositories yet"
          action={
            <Button variant="primary" onClick={() => ui.setPanel('create')}>
              New repository
            </Button>
          }
        >
          Add a folder that uses Git, or create a new repository here or in your
          account.
        </EmptyState>
      );
    if (!shown.length)
      return (
        <EmptyState
          art={<NoResultsArt />}
          title={
            query ? `No repositories match "${query}"` : 'Nothing in this view'
          }
          action={
            <Button
              onClick={() => {
                setQuery('');
                setShow('all');
                setScope('all');
              }}
            >
              Clear filters
            </Button>
          }
        >
          Try part of the name or description, or show all repositories.
        </EmptyState>
      );
    if (split && selected)
      return (
        <div className="grid grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
          <div className="sticky top-0 max-h-[calc(100dvh-8rem)] self-start overflow-auto border-r border-line">
            <RepoList
              items={shown}
              resetKey={resetKey}
              selectedKey={selected.key}
              onPick={(item) => setSelectedKey(item.key)}
              onOpen={open}
              picking
            />
          </div>
          <div className="min-w-0 border-t border-line py-6 pl-8">
            <RepositoryInspector item={selected} />
          </div>
        </div>
      );
    if (narrowSplit)
      return (
        <>
          <RepoList
            items={shown}
            resetKey={resetKey}
            selectedKey={null}
            onPick={open}
            onOpen={open}
            picking={false}
          />
          <p className="mt-3 text-xs text-muted">
            The split layout needs a wider window. Here a row opens its page.
          </p>
        </>
      );
    return <RepoTable items={shown} resetKey={resetKey} />;
  };

  return (
    <Page
      crumbs={[{ label: 'Code' }, { label: 'Repositories' }]}
      actions={header}
      width="full"
      aside={aside}
    >
      <div ref={measure} className="@container">
        <div className={cn(!split && 'mx-auto max-w-(--content-max)')}>
          <AddNotice />
          <PageTitle title="Repositories">
            Folders on this computer and repositories in your gitdesk account. A
            linked repository counts as both local and remote.
          </PageTitle>
          <div
            role="group"
            aria-label="Show repositories"
            className="mb-6 grid grid-cols-2 border-y border-line @min-[640px]:grid-cols-4 [&>button:nth-child(-n+2)]:border-b @min-[640px]:[&>button:nth-child(-n+2)]:border-b-0 [&>button:nth-child(3)]:border-l-0 [&>button:nth-child(3)]:pl-0 @min-[640px]:[&>button:nth-child(3)]:border-l @min-[640px]:[&>button:nth-child(3)]:pl-5"
          >
            <Stat
              value={`${items.length}${more ? '+' : ''}`}
              label="All"
              context={
                signedIn && remoteList.isPending
                  ? 'Loading remote repositories…'
                  : 'Each repository once'
              }
              pressed={scope === 'all'}
              onSelect={() => pickScope('all')}
            />
            <Stat
              value={String(all.length)}
              label="Local"
              context="Registered on this computer"
              pressed={scope === 'local'}
              onSelect={() => pickScope('local')}
            />
            <Stat
              value={remoteStat.value}
              label="Remote"
              muted={remoteStat.muted}
              context={remoteStat.context}
              pressed={scope === 'remote'}
              onSelect={() => pickScope('remote')}
            />
            <Stat
              value={String(all.filter((repo) => repo.remoteId).length)}
              label="Linked"
              context="Local folder with a gitdesk remote"
              pressed={scope === 'linked'}
              onSelect={() => pickScope('linked')}
            />
          </div>

          {items.length > 0 && (
            <div className="mb-4 flex flex-wrap items-center gap-3">
              <label className="field flex h-8 w-64 items-center gap-2 px-2.5 text-muted">
                <Search aria-hidden className="size-4 shrink-0" />
                <span className="sr-only">Search repositories</span>
                <input
                  type="search"
                  value={query}
                  onChange={(event) => setQuery(event.target.value)}
                  onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
                  placeholder="Search name, description or path"
                  className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-ink outline-none placeholder:text-muted"
                />
              </label>
              <Segmented
                label="State"
                value={show}
                onChange={setShow}
                options={[
                  { value: 'all', label: 'Any state' },
                  { value: 'changed', label: `Changed ${counts.changed}` },
                  { value: 'ahead', label: `Ahead ${counts.ahead}` },
                  { value: 'behind', label: `Behind ${counts.behind}` },
                  { value: 'problems', label: `Problems ${counts.problems}` },
                ]}
              />
              <Button
                variant="ghost"
                size="sm"
                className="ml-auto"
                pending={refreshAll.isPending || remoteList.isRefetching}
                onClick={() => {
                  refreshAll.mutate(null);
                  if (signedIn) void remoteList.refetch();
                }}
              >
                {!(refreshAll.isPending || remoteList.isRefetching) && (
                  <RefreshCw />
                )}
                Refresh all
              </Button>
            </div>
          )}

          {signedIn && remoteList.isError && (
            <InlineStatus
              tone="danger"
              className="mb-4"
              action={
                <Button
                  size="sm"
                  pending={remoteList.isFetching}
                  onClick={() => void remoteList.refetch()}
                >
                  Try again
                </Button>
              }
            >
              {ipcErrorMessage(
                remoteList.error,
                "Couldn't load your remote repositories.",
              )}{' '}
              Local repositories are listed as usual.
            </InlineStatus>
          )}

          {body()}

          {more && shown.length > 0 && (
            <Button
              size="sm"
              className="mt-4"
              pending={remoteList.isFetchingNextPage}
              onClick={() => void remoteList.fetchNextPage()}
            >
              Load more from your account
            </Button>
          )}
        </div>
      </div>
    </Page>
  );
}
