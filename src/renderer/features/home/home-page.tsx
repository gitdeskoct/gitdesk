import * as Tabs from '@radix-ui/react-tabs';
import { CloudDownload, FolderOpen, Plus } from 'lucide-react';
import { useMemo, useState } from 'react';
import type { AuthStatus } from '../../../shared/ipc';
import { NoResultsArt, RepositoriesArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { InlineStatus, Loading } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import {
  byRecent,
  needsAttention,
  syncState,
  treeState,
  workspaceStats,
} from '../../lib/repo-status';
import {
  useGitIdentity,
  useRemoteOverview,
  useRepositories,
  useSettings,
} from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { useWorkspaceUi } from '../../app/workspace-ui';
import { CreatePanel } from '../repos/create-panel';
import { RemotePanel } from '../repos/remote-panel';
import { RepoRow } from '../repos/repo-row';
import { accountOf } from '../shell/account-menu';
import { Page, PageTitle } from '../shell/page';
import { StatsStrip, type StatFilter } from './stats-strip';
import { ActivityList, AddNotice, AttentionList } from './workspace-sections';

type Tab = 'recent' | 'pinned' | 'attention';

const today = () =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(Date.now());

function plural(count: number, one: string, many: string) {
  return `${count} ${count === 1 ? one : many}`;
}

// Before the first commit Git needs a name and email; say so here instead of failing later.
function GitReadiness() {
  const { navigate } = useNavigation();
  const identity = useGitIdentity();
  if (identity.isPending || (identity.data?.available && identity.data.name && identity.data.email))
    return null;
  const missingGit = identity.isError || !identity.data?.available;
  return (
    <InlineStatus
      tone="warning"
      className="mb-6"
      action={
        <Button
          size="sm"
          onClick={() =>
            navigate({ name: 'settings', section: 'git', row: 'git-identity' })
          }
        >
          {missingGit ? 'See how to install' : 'Set up'}
        </Button>
      }
    >
      {missingGit
        ? "Git isn't installed, so repositories can't be read or created."
        : 'Set your commit identity before your first commit.'}
    </InlineStatus>
  );
}

export function HomePage({ status }: { status: AuthStatus }) {
  const { data: settings } = useSettings();
  const repos = useRepositories();
  const remote = useRemoteOverview();
  const ui = useWorkspaceUi();
  const [tab, setTab] = useState<Tab>('recent');
  const [filter, setFilter] = useState<StatFilter>('all');

  const list = useMemo(() => repos.data ?? [], [repos.data]);
  const stats = useMemo(() => workspaceStats(list), [list]);
  const attention = useMemo(() => needsAttention(list), [list]);
  const density = settings?.dashboardDensity ?? 'comfortable';
  const layout = settings?.dashboardLayout ?? 'auto';
  const account = accountOf(status);

  const shown = useMemo(() => {
    let rows = [...list].sort(byRecent);
    if (filter === 'changed')
      rows = rows.filter((r) => ['changed', 'conflict'].includes(treeState(r)));
    else if (filter === 'ahead')
      rows = rows.filter((r) => ['ahead', 'diverged'].includes(syncState(r)));
    else if (tab === 'pinned') rows = rows.filter((r) => r.pinned);
    else if (tab === 'attention') {
      const ids = new Set(attention.map((a) => a.repo.id));
      rows = rows.filter((r) => ids.has(r.id));
    } else rows.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    return rows.slice(0, density === 'compact' ? 14 : 8);
  }, [list, filter, tab, attention, density]);

  const summary = !list.length
    ? 'Open a repository to start your workspace.'
    : stats.changed || stats.ahead
      ? [
          stats.changed && `${plural(stats.changed, 'repository has', 'repositories have')} local changes`,
          stats.ahead && `${plural(stats.ahead, 'branch is', 'branches are')} ahead of its upstream`,
        ]
          .filter(Boolean)
          .join(' and ') + '.'
      : 'Everything is committed and nothing is waiting to push.';

  const aside =
    ui.panel === 'create' ? (
      <CreatePanel onClose={() => ui.setPanel(null)} />
    ) : ui.panel === 'remote' ? (
      <RemotePanel onClose={() => ui.setPanel(null)} />
    ) : undefined;

  const actions = (
    <>
      <Button variant="primary" pending={ui.adding} onClick={ui.addRepository}>
        {!ui.adding && <FolderOpen />}
        Open repository
      </Button>
      <Button onClick={() => ui.setPanel('create')}>
        <Plus />
        Create
      </Button>
      <Button onClick={() => ui.setPanel('remote')}>
        <CloudDownload />
        Remote
      </Button>
    </>
  );

  if (repos.isPending)
    return (
      <Page crumbs={[{ label: 'Home' }]} aside={aside}>
        <Loading label="Loading your repositories…" />
      </Page>
    );

  if (!list.length)
    return (
      <Page crumbs={[{ label: 'Home' }]} aside={aside}>
        <GitReadiness />
        <AddNotice />
        <EmptyState
          art={<RepositoriesArt />}
          title="Add your first repository"
          action={
            <Button variant="primary" pending={ui.adding} onClick={ui.addRepository}>
              {!ui.adding && <FolderOpen />}
              Open repository
            </Button>
          }
        >
          Open a folder that already uses Git. gitdesk finds the repository root, even if you
          pick a subfolder.
        </EmptyState>
      </Page>
    );

  const split = layout !== 'centered';
  const repoList = (
    <section aria-labelledby="repos-heading">
      <h2 id="repos-heading" className="sr-only">
        Repositories
      </h2>
      <Tabs.Root value={filter === 'all' ? tab : ''} onValueChange={(next) => {
        setFilter('all');
        setTab(next as Tab);
      }}>
        <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
          <Tabs.List
            aria-label="Show"
            className="inline-flex gap-0.5 rounded-sm bg-control p-0.5"
          >
            {(
              [
                ['recent', 'Recent', null],
                ['pinned', 'Pinned', list.filter((r) => r.pinned).length],
                ['attention', 'Needs attention', attention.length],
              ] as const
            ).map(([value, label, count]) => (
              <Tabs.Trigger
                key={value}
                value={value}
                className="flex h-7 items-center gap-1.5 rounded-[4px] px-3 text-[0.8125rem] text-muted hover:text-ink focus-visible:outline-offset-0 data-[state=active]:bg-thumb data-[state=active]:font-medium data-[state=active]:text-ink data-[state=active]:shadow-[0_1px_2px_rgb(20_22_26/0.12)]"
              >
                {label}
                {count !== null && (
                  <span className="text-xs font-normal text-muted tabular-nums">{count}</span>
                )}
              </Tabs.Trigger>
            ))}
          </Tabs.List>
          <ViewAll />
        </div>
      </Tabs.Root>
      {filter !== 'all' && filter !== 'remote' && (
        <p className="mb-2 flex items-center gap-2 text-[0.8125rem] text-muted">
          Showing repositories {filter === 'changed' ? 'with changes' : 'with commits to push'}.
          <Button variant="link" className="text-[0.8125rem]" onClick={() => setFilter('all')}>
            Show all
          </Button>
        </p>
      )}
      {shown.length ? (
        <ul className="border-t border-line">
          {shown.map((repo) => (
            <RepoRow key={repo.id} repo={repo} density={density} />
          ))}
        </ul>
      ) : (
        <EmptyState
          compact
          art={<NoResultsArt />}
          title={
            tab === 'pinned' && filter === 'all'
              ? 'Nothing pinned yet'
              : 'Nothing here right now'
          }
          className="border-t border-line"
          action={
            <Button
              size="sm"
              onClick={() => {
                setFilter('all');
                setTab('recent');
              }}
            >
              Show recent
            </Button>
          }
        >
          {tab === 'pinned' && filter === 'all'
            ? 'Pin a repository from its menu to keep it at the top.'
            : 'No repository matches this view.'}
        </EmptyState>
      )}
    </section>
  );

  return (
    <Page crumbs={[{ label: 'Home' }]} width={split ? 'wide' : 'page'} aside={aside}>
      <div className="@container">
        <GitReadiness />
        <AddNotice />
        <PageTitle
          eyebrow={today()}
          title={account ? `Good to see you, ${account.displayName.split(/\s+/)[0]}` : 'Your workspace'}
          actions={actions}
        >
          {summary}
        </PageTitle>
        <div className="mb-9">
          <StatsStrip
            stats={stats}
            remote={remote.data}
            filter={filter}
            onFilter={(next) =>
              next === 'remote' ? ui.setPanel('remote') : setFilter(next)
            }
          />
        </div>
        <div
          className={cn(
            'grid gap-x-10 gap-y-10',
            layout === 'split' && '@min-[900px]:grid-cols-[minmax(0,1fr)_300px]',
            layout === 'auto' && '@min-[1120px]:grid-cols-[minmax(0,1fr)_320px]',
          )}
        >
          {repoList}
          {split ? (
            <aside aria-label="Next steps" className="grid content-start gap-9">
              <section aria-labelledby="attention-heading">
                <h2 id="attention-heading" className="mb-2 text-[0.9375rem] font-semibold text-ink">
                  Needs attention
                </h2>
                {attention.length ? (
                  <AttentionList items={attention} limit={5} />
                ) : (
                  <p className="border-t border-line pt-3 text-[0.8125rem] text-muted">
                    Nothing is waiting. Every repository is committed and in step with its
                    upstream.
                  </p>
                )}
              </section>
              <section aria-labelledby="activity-heading">
                <h2 id="activity-heading" className="mb-2 text-[0.9375rem] font-semibold text-ink">
                  Recent activity
                </h2>
                <ActivityList />
              </section>
            </aside>
          ) : (
            attention.length > 0 && (
              <section aria-labelledby="attention-heading">
                <div className="mb-2 flex items-baseline justify-between gap-3">
                  <h2 id="attention-heading" className="text-[0.9375rem] font-semibold text-ink">
                    Needs attention
                  </h2>
                  <span className="text-xs text-muted">From Git status, not guessed</span>
                </div>
                <AttentionList items={attention} />
              </section>
            )
          )}
        </div>
      </div>
    </Page>
  );
}

function ViewAll() {
  const { navigate } = useNavigation();
  return (
    <Button
      variant="link"
      className="text-[0.8125rem]"
      onClick={() => navigate({ name: 'repositories' })}
    >
      View all repositories
    </Button>
  );
}
