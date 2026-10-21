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
  CloudDownload,
  FolderOpen,
  Plus,
  RefreshCw,
  Search,
} from 'lucide-react';
import { useMemo, useState } from 'react';
import type { RepositorySummary } from '../../../shared/repos';
import {
  NoResultsArt,
  OfflineArt,
  RepositoriesArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { EmptyState } from '../../components/ui/empty-state';
import { Segmented } from '../../components/ui/segmented';
import { Spinner } from '../../components/ui/spinner';
import { Loading } from '../../components/ui/status';
import { useToast } from '../../components/ui/toast';
import { cn } from '../../lib/cn';
import { relativeTime, useNow } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  changeCount,
  isProblem,
  syncState,
  treeState,
} from '../../lib/repo-status';
import {
  usePinRepository,
  useRefreshRepositories,
  useRemoveRepository,
  useRepositories,
} from '../../lib/queries';
import type { RepoShow } from '../../app/navigation';
import { useWorkspaceUi } from '../../app/workspace-ui';
import { AddNotice } from '../home/workspace-sections';
import { Page } from '../shell/page';
import { ClonePanel } from './clone-panel';
import { CreatePanel } from './create-panel';
import { RemotePanel } from './remote-panel';
import { RemoveConfirm, useOpenRepo } from './repo-row';
import {
  RepoContextMenu,
  RepoMenuButton,
  useRepoActions,
} from './repo-actions';
import { BranchLabel, SyncChip, TreeChip } from './status';

type Show = RepoShow;

const features = tableFeatures({
  rowSortingFeature,
  rowSelectionFeature,
  sortedRowModel: createSortedRowModel(),
  sortFns: { alphanumeric: sortFn_alphanumeric, basic: sortFn_basic },
});

const column = createColumnHelper<typeof features, RepositorySummary>();

// Sort keys: what each column means to a person scanning the table, not its display text.
const columns = column.columns([
  column.accessor('name', {
    id: 'name',
    header: 'Name',
    sortFn: 'alphanumeric',
  }),
  column.accessor((repo) => repo.status?.branch ?? '', {
    id: 'branch',
    header: 'Branch',
    sortFn: 'alphanumeric',
  }),
  column.accessor(
    (repo) =>
      (treeState(repo) === 'conflict' ? 10_000 : 0) + changeCount(repo.status),
    {
      id: 'tree',
      header: 'Working tree',
      sortFn: 'basic',
      sortDescFirst: true,
    },
  ),
  column.accessor(
    (repo) => (repo.status?.ahead ?? 0) + (repo.status?.behind ?? 0),
    {
      id: 'upstream',
      header: 'Upstream',
      sortFn: 'basic',
      sortDescFirst: true,
    },
  ),
  column.accessor((repo) => repo.lastOpenedAt ?? repo.addedAt, {
    id: 'opened',
    header: 'Last opened',
    sortFn: 'basic',
    sortDescFirst: true,
  }),
]);

function matches(repo: RepositorySummary, show: Show, query: string): boolean {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  const haystack =
    `${repo.name} ${repo.displayPath} ${repo.status?.branch ?? ''} ${repo.description ?? ''}`.toLowerCase();
  if (!words.every((word) => haystack.includes(word))) return false;
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

function Row({
  repo,
  selected,
  onSelect,
}: {
  repo: RepositorySummary;
  selected: boolean;
  onSelect: (selected: boolean) => void;
}) {
  const openRepo = useOpenRepo();
  const [confirming, setConfirming] = useState(false);
  const { actions, busy } = useRepoActions(repo, () => setConfirming(true));
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
          <td className="max-w-0 py-3 pr-4">
            <button
              type="button"
              onClick={() => openRepo(repo.id)}
              className="block max-w-full rounded-sm text-left"
            >
              <span
                className={cn(
                  'block truncate text-sm font-semibold hover:underline',
                  missing ? 'text-muted' : 'text-ink',
                )}
              >
                {repo.name}
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
            <RepoMenuButton repo={repo} actions={actions} />
          </td>
        </tr>
      </RepoContextMenu>
      {confirming && (
        <tr>
          <td colSpan={7} className="p-0">
            <RemoveConfirm repo={repo} onCancel={() => setConfirming(false)} />
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

export function RepositoriesPage({ initialShow }: { initialShow: Show }) {
  useNow();
  const repos = useRepositories();
  const ui = useWorkspaceUi();
  const refreshAll = useRefreshRepositories();
  const [query, setQuery] = useState('');
  const [show, setShow] = useState<Show>(initialShow);
  const [sorting, setSorting] = useState<SortingState>([
    { id: 'opened', desc: true },
  ]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});

  const all = repos.data ?? [];
  const data = useMemo(
    () => all.filter((repo) => matches(repo, show, query)),
    [all, show, query],
  );
  const counts = useMemo(
    () =>
      Object.fromEntries(
        (['all', 'changed', 'ahead', 'behind', 'problems'] as Show[]).map(
          (key) => [key, all.filter((repo) => matches(repo, key, '')).length],
        ),
      ) as Record<Show, number>,
    [all],
  );

  const table = useTable(
    {
      features,
      columns,
      data,
      getRowId: (repo) => repo.id,
      state: { sorting, rowSelection },
      onSortingChange: setSorting,
      onRowSelectionChange: setRowSelection,
      enableSortingRemoval: false,
    },
    (state) => ({ sorting: state.sorting, rowSelection: state.rowSelection }),
  );

  const rows = table.getRowModel().rows;
  const selected = rows
    .filter((row) => row.getIsSelected())
    .map((row) => row.original);
  const aside =
    ui.panel === 'create' ? (
      <CreatePanel onClose={() => ui.setPanel(null)} />
    ) : ui.panel === 'remote' ? (
      <RemotePanel onClose={() => ui.setPanel(null)} />
    ) : ui.panel === 'clone' ? (
      <ClonePanel onClose={() => ui.setPanel(null)} />
    ) : undefined;

  const header = (
    <>
      <Button onClick={() => ui.setPanel('clone')}>
        <CloudDownload />
        Clone
      </Button>
      <Button onClick={() => ui.setPanel('create')}>
        <Plus />
        Create
      </Button>
      <Button variant="primary" pending={ui.adding} onClick={ui.addRepository}>
        {!ui.adding && <FolderOpen />}
        Open repository
      </Button>
    </>
  );

  return (
    <Page
      crumbs={[{ label: 'Code' }, { label: 'Repositories' }]}
      actions={header}
      width="full"
      aside={aside}
    >
      <AddNotice />
      <h1 className="text-xl font-semibold tracking-[-0.02em] text-ink">
        Repositories
      </h1>
      <p className="mt-1 mb-6 text-sm text-muted">
        {all.length
          ? `${all.length} on this computer. Status comes from Git; ahead and behind compare with the last fetched upstream.`
          : 'Repositories you open or create appear here.'}
      </p>

      {repos.isPending ? (
        <Loading label="Loading your repositories…" />
      ) : repos.isError ? (
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
      ) : !all.length ? (
        <EmptyState
          art={<RepositoriesArt />}
          title="No repositories yet"
          action={
            <Button
              variant="primary"
              pending={ui.adding}
              onClick={ui.addRepository}
            >
              Open repository
            </Button>
          }
        >
          Open a folder that uses Git, or create a new repository.
        </EmptyState>
      ) : (
        <>
          <div className="mb-4 flex flex-wrap items-center gap-3">
            <label className="field flex h-8 w-64 items-center gap-2 px-2.5 text-muted">
              <Search aria-hidden className="size-4 shrink-0" />
              <span className="sr-only">Filter repositories</span>
              <input
                type="search"
                value={query}
                onChange={(event) => {
                  setQuery(event.target.value);
                  // Hidden rows must not stay selected for a bulk action.
                  setRowSelection({});
                }}
                onKeyDown={(event) => event.key === 'Escape' && setQuery('')}
                placeholder="Filter by name, path or branch"
                className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-ink outline-none placeholder:text-muted"
              />
            </label>
            <Segmented
              label="Show"
              value={show}
              onChange={(next) => {
                setShow(next);
                setRowSelection({});
              }}
              options={[
                { value: 'all', label: `All ${counts.all}` },
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
              pending={refreshAll.isPending}
              onClick={() => refreshAll.mutate(null)}
            >
              {!refreshAll.isPending && <RefreshCw />}
              Refresh all
            </Button>
          </div>

          {selected.length > 0 && (
            <BulkBar selected={selected} onDone={() => setRowSelection({})} />
          )}

          {rows.length ? (
            <div className="overflow-x-auto">
              <table className="w-full min-w-[760px] border-collapse text-sm">
                <thead>
                  <tr className="border-b border-line">
                    <th scope="col" className="w-10 py-2.5 pl-3 text-left">
                      <Checkbox
                        aria-label="Select all shown"
                        checked={
                          table.getIsAllRowsSelected()
                            ? true
                            : table.getIsSomeRowsSelected()
                              ? 'indeterminate'
                              : false
                        }
                        onCheckedChange={(next) =>
                          table.toggleAllRowsSelected(next === true)
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
                  {rows.map((row) => (
                    <Row
                      key={row.id}
                      repo={row.original}
                      selected={row.getIsSelected()}
                      onSelect={(next) => row.toggleSelected(next)}
                    />
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <EmptyState
              art={<NoResultsArt />}
              title={
                query
                  ? `No repositories match "${query}"`
                  : 'Nothing in this view'
              }
              action={
                <Button
                  onClick={() => {
                    setQuery('');
                    setShow('all');
                  }}
                >
                  Clear filter
                </Button>
              }
            >
              Try part of the folder name, or show all repositories.
            </EmptyState>
          )}
        </>
      )}
    </Page>
  );
}
