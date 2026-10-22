import { CloudDownload, FolderOpen, Plus } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import type { AuthStatus } from '../../../shared/ipc';
import {
  NoResultsArt,
  OfflineArt,
  RepositoriesArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { Segmented } from '../../components/ui/segmented';
import { InlineStatus, Loading } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import { useNow } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  byRecent,
  needsAttention,
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
import { ClonePanel } from '../repos/clone-panel';
import { CreatePanel } from '../repos/create-panel';
import { RepoRow } from '../repos/repo-row';
import { accountOf } from '../shell/account-menu';
import { Page, PageTitle } from '../shell/page';
import { StatsStrip } from './stats-strip';
import { ActivityList, AddNotice, AttentionList } from './workspace-sections';

type Tab = 'recent' | 'pinned' | 'attention';

const formatDay = (now: number) =>
  new Intl.DateTimeFormat(undefined, {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  }).format(now);

const count = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

// Before the first commit Git needs a name and email; say so here instead of failing later.
function GitReadiness() {
  const { navigate } = useNavigation();
  const identity = useGitIdentity();
  if (
    identity.isPending ||
    (identity.data?.available && identity.data.name && identity.data.email)
  )
    return null;
  // A failed check is not proof that Git is missing; only main's own answer is.
  if (identity.isError)
    return (
      <InlineStatus
        tone="warning"
        className="mb-6"
        action={
          <Button
            size="sm"
            pending={identity.isFetching}
            onClick={() => void identity.refetch()}
          >
            Check again
          </Button>
        }
      >
        {ipcErrorMessage(
          identity.error,
          "gitdesk couldn't check your Git setup.",
        )}
      </InlineStatus>
    );
  const missingGit = !identity.data?.available;
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

function Section({
  id,
  title,
  meta,
  children,
}: {
  id: string;
  title: string;
  meta?: string;
  children: ReactNode;
}) {
  return (
    // min-w-0 and wrapping keep a narrow side column from being pushed wider than its track.
    <section aria-labelledby={id} className="min-w-0">
      <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
        <h2 id={id} className="text-[0.9375rem] font-semibold text-ink">
          {title}
        </h2>
        {meta && <span className="text-xs text-muted">{meta}</span>}
      </div>
      {children}
    </section>
  );
}

export function HomePage({ status }: { status: AuthStatus }) {
  const now = useNow();
  const { navigate } = useNavigation();
  const { data: settings } = useSettings();
  const repos = useRepositories();
  const remote = useRemoteOverview();
  const ui = useWorkspaceUi();
  const [tab, setTab] = useState<Tab>('recent');

  const list = useMemo(() => repos.data ?? [], [repos.data]);
  const stats = useMemo(() => workspaceStats(list), [list]);
  const attention = useMemo(() => needsAttention(list), [list]);
  const density = settings?.dashboardDensity ?? 'comfortable';
  const layout = settings?.dashboardLayout ?? 'auto';
  const account = accountOf(status);
  const firstName = account?.displayName.trim().split(/\s+/)[0];

  const shown = useMemo(() => {
    const sorted = [...list].sort(byRecent);
    const rows =
      tab === 'pinned'
        ? sorted.filter((r) => r.pinned)
        : tab === 'attention'
          ? attention.map((a) => a.repo)
          : sorted.sort((a, b) => Number(b.pinned) - Number(a.pinned));
    return rows.slice(0, density === 'compact' ? 14 : 8);
  }, [list, tab, attention, density]);

  const summary = !list.length
    ? 'Open a repository to start your workspace.'
    : stats.changed || stats.ahead
      ? [
          stats.changed &&
            `${count(stats.changed, 'repository has', 'repositories have')} local changes`,
          stats.ahead &&
            `${count(stats.ahead, 'branch is', 'branches are')} ahead of ${stats.ahead === 1 ? 'its' : 'their'} upstream`,
        ]
          .filter(Boolean)
          .join(' and ') + '.'
      : stats.unchecked
        ? 'Checking your repositories…'
        : 'Everything is committed and nothing is waiting to push.';

  const aside =
    ui.panel === 'create' ? (
      <CreatePanel onClose={() => ui.setPanel(null)} />
    ) : ui.panel === 'clone' ? (
      <ClonePanel onClose={() => ui.setPanel(null)} />
    ) : undefined;

  const empty = repos.isSuccess && !list.length;
  const actions = (
    <>
      {/* On first run the empty state holds the one primary action. */}
      {!empty && (
        <Button
          variant="primary"
          pending={ui.adding}
          onClick={ui.addRepository}
        >
          {!ui.adding && <FolderOpen />}
          Open repository
        </Button>
      )}
      <Button onClick={() => ui.setPanel('create')}>
        <Plus />
        Create
      </Button>
      <Button onClick={() => ui.setPanel('clone')}>
        <CloudDownload />
        Clone
      </Button>
    </>
  );

  const header = (
    <>
      <GitReadiness />
      <AddNotice />
      <PageTitle
        eyebrow={formatDay(now)}
        title={firstName ? `Good to see you, ${firstName}` : 'Your workspace'}
        actions={actions}
      >
        {repos.isPending
          ? 'Reading your repositories…'
          : repos.isError
            ? undefined
            : summary}
      </PageTitle>
    </>
  );

  if (repos.isError)
    return (
      <Page crumbs={[{ label: 'Home' }]} aside={aside}>
        {header}
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
      </Page>
    );

  if (empty)
    return (
      <Page crumbs={[{ label: 'Home' }]} aside={aside}>
        {header}
        <EmptyState
          art={<RepositoriesArt />}
          title="Add your first repository"
          action={
            <Button
              variant="primary"
              pending={ui.adding}
              onClick={ui.addRepository}
            >
              {!ui.adding && <FolderOpen />}
              Open repository
            </Button>
          }
        >
          Pick a folder that already uses Git, even a subfolder, and gitdesk
          finds its root.
        </EmptyState>
      </Page>
    );

  const split = layout !== 'centered';
  const repoList = (
    <Section id="repos-heading" title="Repositories">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-3">
        <Segmented
          label="Show"
          value={tab}
          onChange={setTab}
          options={[
            { value: 'recent', label: 'Recent' },
            {
              value: 'pinned',
              label: `Pinned ${list.filter((r) => r.pinned).length}`,
            },
            {
              value: 'attention',
              label: `Needs attention ${attention.length}`,
            },
          ]}
        />
        <Button
          variant="link"
          className="text-[0.8125rem]"
          onClick={() => navigate({ name: 'repositories' })}
        >
          View all repositories
        </Button>
      </div>
      {repos.isPending ? (
        <Loading label="Loading your repositories…" />
      ) : shown.length ? (
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
            tab === 'pinned' ? 'Nothing pinned yet' : 'Nothing needs attention'
          }
          className="border-t border-line"
          action={
            <Button size="sm" onClick={() => setTab('recent')}>
              Show recent
            </Button>
          }
        >
          {tab === 'pinned'
            ? 'Pin a repository from its menu to keep it at the top.'
            : 'Every repository is committed and in step with its upstream.'}
        </EmptyState>
      )}
    </Section>
  );

  const pageSize = settings?.homePageSize ?? 6;
  const showAttention = settings?.homeShowAttention ?? true;
  const showActivity = settings?.homeShowActivity ?? true;
  const nextSteps = (
    <>
      {showAttention && (
        <Section
          id="attention-heading"
          title="Needs attention"
          meta="From Git status, not guessed"
        >
          {attention.length || remote.data?.state === 'cached' ? (
            <AttentionList
              items={attention}
              remote={remote.data}
              pageSize={pageSize}
            />
          ) : (
            <EmptyState
              compact
              art={<NoResultsArt />}
              title="Nothing is waiting"
              className="border-t border-line"
              action={
                <Button
                  size="sm"
                  onClick={() => navigate({ name: 'repositories' })}
                >
                  View all repositories
                </Button>
              }
            >
              Every repository is committed and in step with its upstream.
            </EmptyState>
          )}
        </Section>
      )}
      {showActivity && (
        <Section id="activity-heading" title="Recent activity">
          <ActivityList
            remote={remote.data}
            pageSize={pageSize}
            source={settings?.activitySource ?? 'both'}
            includeOpens={settings?.activityIncludeOpens ?? false}
          />
        </Section>
      )}
    </>
  );
  const hasNextSteps = showAttention || showActivity;

  return (
    <Page
      crumbs={[{ label: 'Home' }]}
      width={split && hasNextSteps ? 'wide' : 'page'}
      aside={aside}
    >
      <div className="@container">
        {header}
        <div className="mb-9">
          <StatsStrip
            stats={stats}
            remote={remote.data}
            remoteFailed={remote.isError}
            onRemote={() => navigate({ name: 'repositories', scope: 'remote' })}
          />
        </div>
        <div
          className={cn(
            'grid gap-x-10 gap-y-10',
            hasNextSteps &&
              layout === 'split' &&
              '@min-[900px]:grid-cols-[minmax(0,1fr)_300px]',
            hasNextSteps &&
              layout === 'auto' &&
              '@min-[1120px]:grid-cols-[minmax(0,1fr)_320px]',
          )}
        >
          {repoList}
          {!hasNextSteps ? null : split ? (
            <aside
              aria-label="Next steps"
              className="grid min-w-0 content-start gap-9"
            >
              {nextSteps}
            </aside>
          ) : (
            <div
              className={cn(
                'grid gap-x-10 gap-y-9',
                showAttention && showActivity && '@min-[760px]:grid-cols-2',
              )}
            >
              {nextSteps}
            </div>
          )}
        </div>
      </div>
    </Page>
  );
}
