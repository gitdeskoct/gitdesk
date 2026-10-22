import * as Tabs from '@radix-ui/react-tabs';
import {
  CloudDownload,
  CloudUpload,
  FolderOpen,
  RefreshCw,
} from 'lucide-react';
import { Fragment, useState, type ReactNode } from 'react';
import type {
  RemoteRepository,
  RepositorySummary,
} from '../../../shared/repos';
import {
  FolderMissingArt,
  GitMissingArt,
  NoResultsArt,
  OfflineArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { LongValue } from '../../components/ui/long-value';
import { InlineStatus, Loading } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import { relativeTime, useNow } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAuthStatus,
  useLinkRemote,
  useCopyRepositoryPath,
  useLocateRepository,
  useRefreshRepositories,
  useRemoteRepository,
  useRemotes,
  useRepoPreferences,
  useRepositories,
  useRepositoryHistory,
  useRevealRepository,
  useSettings,
  useWatchRepository,
} from '../../lib/queries';
import { useWidth } from '../../lib/use-width';
import { useNavigation, type RepoTab } from '../../app/navigation';
import {
  fileManagerLabel,
  RepoMenuButton,
  useRepoActions,
} from '../repos/repo-actions';
import { ManageBand, trashName, type ManageMode } from '../repos/manage';
import { SyncChip, TreeChip } from '../repos/status';
import { Page } from '../shell/page';
import { Analytics } from './analytics';
import { BranchPicker, type SwitchOutcome } from './branch-picker';
import { BranchesTab } from './branches-tab';
import { ChangesTab } from './changes-tab';
import { OpenInEditorButton } from './editor-button';
import {
  CommitActivity,
  localSummary,
  RecentCommits,
  REMOTE_STATUS,
  RepoTags,
  Section,
  SummaryStrip,
} from './history';
import { HistoryTab } from './history-tab';
import { RemotesTab } from './remotes-tab';
import { PullAnalytics } from '../pulls/pull-analytics';
import { PullsTab } from '../pulls/pulls-tab';
import { RepoSettingsTab } from './repo-settings-tab';
import { useFetchAction } from './use-fetch';
import { usePushAction } from './use-push';

function upstreamText(repo: RepositorySummary): string {
  const status = repo.status!;
  if (!status.hasRemotes) return 'No remote configured';
  if (!status.upstream) return 'This branch has no upstream';
  if (status.ahead === null || status.behind === null)
    return `${status.upstream} · not found locally, fetch to compare`;
  return `${status.upstream} · ahead ${status.ahead}, behind ${status.behind} at the last fetch`;
}

// Charts and counts read Git history on this computer; nothing here asks the server.
export function History({
  repo,
  compact = false,
}: {
  repo: RepositorySummary;
  compact?: boolean;
}) {
  const refresh = useRefreshRepositories();
  const history = useRepositoryHistory(
    repo.id,
    repo.statusAt,
    repo.availability === 'available',
  );
  if (history.isPending) return <Loading label="Reading commit history…" />;
  if (history.isError)
    return (
      <InlineStatus
        tone="danger"
        className="mt-6"
        action={
          <Button
            size="sm"
            pending={history.isFetching}
            onClick={() => void history.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(
          history.error,
          "Couldn't read this repository's history.",
        )}
      </InlineStatus>
    );
  const data = history.data;
  const checking = refresh.isPending || repo.inspecting;
  return (
    <>
      <SummaryStrip cells={localSummary(repo, data)} />
      {!compact && (
        <Section
          id="activity-heading"
          title={`How often was ${data.branch ?? 'this branch'} committed to?`}
          meta={`Commits per week by commit date, local time, last ${data.weeks.length} weeks`}
        >
          <CommitActivity
            history={data}
            action={
              <Button
                size="sm"
                pending={checking}
                onClick={() => refresh.mutate(repo.id)}
              >
                {!checking && <RefreshCw />}
                Refresh status
              </Button>
            }
          />
        </Section>
      )}
      {data.recent.length > 0 && (
        <Section
          id={compact ? 'inspector-commits' : 'commits-heading'}
          title="Recent commits"
          meta={
            compact
              ? undefined
              : 'Newest first. Author names come from Git settings and are not verified.'
          }
          className={compact ? 'mt-7' : undefined}
        >
          <RecentCommits commits={data.recent} limit={compact ? 3 : 10} />
        </Section>
      )}
    </>
  );
}

function Details({
  repo,
  remote,
}: {
  repo: RepositorySummary;
  remote: RemoteRepository | null;
}) {
  const link = useLinkRemote();
  const { data: auth } = useAuthStatus();
  const status = repo.status!;
  const commit = status.lastCommit;
  return (
    <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 border-t border-line py-3 text-sm">
      <dt className="text-muted">Last commit</dt>
      <dd className="min-w-0 truncate text-ink">
        {commit ? (
          <>
            <span className="font-mono text-[0.78125rem]">
              {commit.oid.slice(0, 7)}
            </span>{' '}
            · {commit.subject} · {relativeTime(commit.at)}
          </>
        ) : (
          'No commits yet'
        )}
      </dd>
      <dt className="text-muted">Upstream</dt>
      <dd className="min-w-0 truncate text-ink">{upstreamText(repo)}</dd>
      <dt className="text-muted">Last fetch</dt>
      <dd className="text-ink">
        {status.fetchedAt
          ? relativeTime(status.fetchedAt)
          : status.hasRemotes
            ? 'Not fetched yet'
            : 'No remote to fetch from'}
      </dd>
      <dt className="text-muted">Remote</dt>
      <dd className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-1 text-ink">
        {!repo.remoteId
          ? 'Not linked to your account'
          : remote
            ? `${REMOTE_STATUS[remote.status].label} · ${remote.name} in your account`
            : 'Linked to your account'}
        {!repo.remoteId && auth?.status === 'authenticated' && (
          <Button
            variant="link"
            className="text-[0.8125rem]"
            pending={link.isPending}
            onClick={() => link.mutate(repo.id)}
          >
            Create private remote
          </Button>
        )}
      </dd>
      {link.isError && (
        <dd className="col-start-2">
          <InlineStatus tone="danger">
            {ipcErrorMessage(link.error, "The remote wasn't created.")}
          </InlineStatus>
        </dd>
      )}
      {repo.remoteId && (
        <>
          <dt className="text-muted">Visibility</dt>
          <dd className="text-ink">
            Private · only your signed-in account can see it
          </dd>
          {remote && (
            <>
              <dt className="text-muted">Default branch</dt>
              <dd className="font-mono text-[0.78125rem] text-ink">
                {remote.defaultBranch}
              </dd>
            </>
          )}
          <dt className="text-muted">Remote ID</dt>
          <dd className="truncate font-mono text-[0.78125rem] text-muted">
            {repo.remoteId}
          </dd>
        </>
      )}
      <dt className="text-muted">Added</dt>
      <dd className="text-ink">
        {relativeTime(repo.addedAt)}
        {repo.lastOpenedAt && ` · opened ${relativeTime(repo.lastOpenedAt)}`}
      </dd>
    </dl>
  );
}

// Four actions that each touch one thing, so none can be mistaken for another.
function RemoveOrDelete({
  repo,
  remote,
  mode,
  setMode,
  onGone,
}: {
  repo: RepositorySummary;
  remote: RemoteRepository | null;
  mode: ManageMode | null;
  setMode: (mode: ManageMode | null) => void;
  onGone: () => void;
}) {
  const present = repo.availability === 'available';
  const rows: {
    mode: ManageMode;
    title: string;
    text: string;
    button: string;
    danger?: boolean;
  }[] = [];
  if (repo.remoteId)
    rows.push({
      mode: 'unlink',
      title: 'Disconnect remote',
      text: 'Unlinks this folder from its remote. Files, history, Git settings and the remote stay as they are.',
      button: 'Disconnect',
    });
  rows.push({
    mode: 'remove',
    title: 'Remove from gitdesk',
    text: 'Takes it off your list. The folder and its history stay on disk, and you can add it again.',
    button: 'Remove',
  });
  if (present)
    rows.push({
      mode: 'trash',
      title: `Move folder to ${trashName()}`,
      text: `Moves the whole folder, including its Git history.${repo.remoteId ? ' The remote is not touched.' : ''}`,
      button: `Move to ${trashName()}`,
      danger: true,
    });
  if (remote)
    rows.push({
      mode: 'delete-remote',
      title: 'Delete remote repository',
      text: 'Deletes it and its stored data from your account. This folder stays untouched.',
      button: 'Delete remote',
      danger: true,
    });
  return (
    <div className="border-t border-line">
      {rows.map((row) => (
        <Fragment key={row.mode}>
          <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-b border-line py-3.5">
            <div className="min-w-64 flex-1">
              <div className="text-sm font-semibold text-ink">{row.title}</div>
              <p className="mt-0.5 text-[0.8125rem] leading-relaxed text-muted">
                {row.text}
              </p>
            </div>
            <Button
              size="sm"
              variant={row.danger ? 'danger' : 'secondary'}
              aria-expanded={mode === row.mode}
              onClick={() => setMode(mode === row.mode ? null : row.mode)}
            >
              {row.button}
            </Button>
          </div>
          {mode === row.mode && (
            <ManageBand
              mode={row.mode}
              repo={repo}
              remote={remote}
              onClose={() => setMode(null)}
              onGone={onGone}
            />
          )}
        </Fragment>
      ))}
    </div>
  );
}

// The workspace for one registered repository: what Git reports here, and what the account holds.
export function RepositoryPage({ id, tab }: { id: string; tab?: RepoTab }) {
  const { navigate } = useNavigation();
  const repos = useRepositories();
  const repo = repos.data?.find((r) => r.id === id);
  const crumbs = [
    {
      label: 'Repositories',
      onSelect: () => navigate({ name: 'repositories' }),
    },
    { label: repo?.name ?? 'Repository' },
  ];

  if (repos.isPending)
    return (
      <Page crumbs={crumbs}>
        <Loading label="Loading the repository…" />
      </Page>
    );
  if (repos.isError)
    return (
      <Page crumbs={crumbs}>
        <EmptyState
          art={<OfflineArt />}
          title="Couldn't load your repositories"
          action={
            <Button
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
  if (!repo)
    return (
      <Page crumbs={crumbs}>
        <EmptyState
          art={<NoResultsArt />}
          title="This repository isn't in gitdesk"
          action={
            <Button onClick={() => navigate({ name: 'repositories' })}>
              Go to Repositories
            </Button>
          }
        >
          It was removed from the list; its folder on disk was not touched.
        </EmptyState>
      </Page>
    );
  return <RepositoryView repo={repo} crumbs={crumbs} tab={tab} />;
}

const TABS: { value: RepoTab; label: string }[] = [
  { value: 'changes', label: 'Changes' },
  { value: 'history', label: 'History' },
  { value: 'branches', label: 'Branches' },
  { value: 'pulls', label: 'Pull requests' },
  { value: 'remotes', label: 'Remotes' },
  { value: 'overview', label: 'Overview' },
  { value: 'settings', label: 'Settings' },
];

// What a switch attempt came to, in words, next to the branch it was about.
function SwitchNotice({
  outcome,
  onClose,
  onChanges,
}: {
  outcome: SwitchOutcome;
  onClose: () => void;
  onChanges: () => void;
}) {
  const close = (
    <Button size="sm" variant="ghost" onClick={onClose}>
      Dismiss
    </Button>
  );
  if ('error' in outcome)
    return (
      <InlineStatus tone="danger" action={close}>
        {outcome.error}
      </InlineStatus>
    );
  const { result, target } = outcome;
  if (result.status === 'switched') return null;
  if (result.reason === 'local-changes')
    return (
      <div
        role="status"
        className="grid gap-2 bg-warning-soft px-3 py-3 text-[0.8125rem] text-ink"
      >
        <InlineStatus tone="warning">
          Git didn't switch to{' '}
          <b className="font-mono font-semibold">{target}</b>: switching would
          overwrite your edits{result.files.length ? ' to these files' : ''}.
          Commit or stash them first. gitdesk never discards them to switch.
        </InlineStatus>
        {result.files.length > 0 && (
          <ul className="ml-6 font-mono text-[0.78125rem]">
            {result.files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        )}
        <div className="ml-6 flex gap-2">
          <Button size="sm" className="bg-surface" onClick={onChanges}>
            Go to Changes
          </Button>
          {close}
        </div>
      </div>
    );
  const words = {
    'other-worktree': `${target} is checked out in another worktree, so Git won't check it out here too.`,
    operation:
      'A merge or rebase is in progress. Finish or abort it in your editor or terminal first.',
    exists: `A local branch named ${target} already exists. Switch to it instead.`,
    'not-found': `${target} isn't there any more. The branch list was refreshed.`,
  }[result.reason];
  return (
    <InlineStatus tone="warning" action={close}>
      {words}
    </InlineStatus>
  );
}

function FetchButton({ repo }: { repo: RepositorySummary }) {
  const remotes = useRemotes(repo.id, repo.statusAt);
  const prefs = useRepoPreferences(repo.id);
  const action = useFetchAction(repo.id, { toast: true });
  const names = remotes.data?.map((r) => r.name) ?? [];
  const remote =
    (prefs.data?.defaultRemote && names.includes(prefs.data.defaultRemote)
      ? prefs.data.defaultRemote
      : names.includes('origin')
        ? 'origin'
        : names[0]) ?? null;
  if (!repo.status?.hasRemotes || !remote) return null;
  return action.running ? (
    <Button
      size="sm"
      onClick={action.cancel}
      aria-label={`Cancel fetching ${remote}`}
    >
      <CloudDownload />
      {action.progress ? `${action.progress.percent}%` : 'Fetching'} · Cancel
    </Button>
  ) : (
    <Button size="sm" onClick={() => action.start(remote)}>
      <CloudDownload />
      Fetch {remote}
    </Button>
  );
}

// Pushes the current branch; the count is what its upstream doesn't have yet.
function PushButton({ repo }: { repo: RepositorySummary }) {
  const action = usePushAction(repo.id);
  const status = repo.status;
  if (!status?.hasRemotes || !status.branch) return null;
  const ahead = status.upstream ? (status.ahead ?? 0) : null;
  if (action.running)
    return (
      <Button size="sm" onClick={action.cancel} aria-label="Cancel push">
        <CloudUpload />
        {action.progress ? `${action.progress.percent}%` : 'Pushing'} · Cancel
      </Button>
    );
  return (
    <Button
      size="sm"
      onClick={action.start}
      title={
        ahead === null
          ? `Pushes ${status.branch} and sets its upstream`
          : `${ahead} ${ahead === 1 ? 'commit' : 'commits'} to push`
      }
    >
      <CloudUpload />
      Push{ahead ? ` ${ahead}` : ''}
    </Button>
  );
}

// A successful switch needs no notice: the branch label already says where you are.
const keepNotice = (next: SwitchOutcome) =>
  'result' in next && next.result.status === 'switched' ? null : next;

function RepositoryView({
  repo,
  crumbs,
  tab: routeTab,
}: {
  repo: RepositorySummary;
  crumbs: { label: string; onSelect?: () => void }[];
  tab?: RepoTab;
}) {
  useNow();
  const { navigate } = useNavigation();
  const { data: auth } = useAuthStatus();
  const { data: settings } = useSettings();
  const prefs = useRepoPreferences(repo.id);
  const refresh = useRefreshRepositories();
  const reveal = useRevealRepository();
  const locate = useLocateRepository();
  const copyPath = useCopyRepositoryPath();
  const remoteQuery = useRemoteRepository(
    repo.remoteId ?? '',
    !!repo.remoteId && auth?.status === 'authenticated',
  );
  const remote = remoteQuery.data ?? null;
  const [mode, setMode] = useState<ManageMode | null>(null);
  const [outcome, setOutcome] = useState<SwitchOutcome | null>(null);
  const { actions, busy } = useRepoActions(repo, setMode, remote);
  const [measure, width] = useWidth();
  const gone = () => navigate({ name: 'repositories' });

  const present = repo.availability === 'available';
  useWatchRepository(repo.id, present);
  const checking = refresh.isPending || repo.inspecting;
  const tab = routeTab ?? prefs.data?.openOn ?? 'changes';
  const chosen =
    prefs.data && prefs.data.layout !== 'global'
      ? prefs.data.layout
      : (settings?.workspaceLayout ?? 'auto');
  // Auto splits from 960px of workspace; Split asks for 700px, then becomes one column.
  const split =
    chosen !== 'centered' && width >= (chosen === 'split' ? 700 : 960);
  const layout = split
    ? 'split'
    : chosen !== 'centered' && width > 0 && width < 700
      ? 'narrow'
      : 'centered';

  const header = (
    <>
      {present && (
        <>
          <Button
            variant="ghost"
            size="sm"
            pending={checking}
            onClick={() => refresh.mutate(repo.id)}
          >
            {!checking && <RefreshCw />}
            Refresh
          </Button>
          <OpenInEditorButton repoId={repo.id} path={null} />
          <Button
            size="sm"
            pending={reveal.isPending}
            onClick={() => reveal.mutate(repo.id)}
          >
            {!reveal.isPending && <FolderOpen />}
            {fileManagerLabel()}
          </Button>
        </>
      )}
      <RepoMenuButton name={repo.name} actions={actions} />
    </>
  );
  const problem = reveal.error ?? locate.error;
  const notices = (
    <>
      {mode === 'rename' && (
        <div className="mt-3">
          <ManageBand
            mode={mode}
            repo={repo}
            remote={remote}
            onClose={() => setMode(null)}
            onGone={gone}
          />
        </div>
      )}
      {problem && (
        <InlineStatus tone="danger" className="mt-3">
          {ipcErrorMessage(problem, "That didn't work. Try again.")}
        </InlineStatus>
      )}
    </>
  );

  if (!present)
    return (
      <Page crumbs={crumbs} actions={header}>
        {notices}
        <EmptyState
          art={
            repo.availability === 'missing' ? (
              <FolderMissingArt />
            ) : (
              <GitMissingArt />
            )
          }
          title={
            repo.availability === 'missing'
              ? `${repo.name}'s folder can't be found`
              : `${repo.name} is no longer a Git repository`
          }
          action={
            <Button
              variant="primary"
              pending={locate.isPending}
              onClick={() => locate.mutate(repo.id)}
            >
              Locate folder
            </Button>
          }
        >
          {repo.availability === 'missing'
            ? `It was at ${repo.displayPath}. It may be on a drive that isn't connected. The registration stays until you remove it.`
            : `The folder at ${repo.displayPath} is there, but Git no longer recognises it.`}
        </EmptyState>
        {mode && mode !== 'rename' && (
          <ManageBand
            mode={mode}
            repo={repo}
            remote={remote}
            onClose={() => setMode(null)}
            onGone={gone}
          />
        )}
      </Page>
    );

  const status = repo.status;
  const changeCount = status
    ? status.staged + status.unstaged + status.untracked + status.conflicts
    : null;
  const padded = 'px-6 min-[1100px]:px-10';
  const column = cn(
    padded,
    !split && 'mx-auto w-full max-w-[calc(var(--content-max)+5rem)]',
  );
  // Tabs that read as a document scroll in a centered column; Changes and History own their panes.
  const scrolling = (children: ReactNode) => (
    <div className={cn('min-h-0 flex-1 overflow-auto pb-10', padded)}>
      <div className="mx-auto max-w-(--content-max)">{children}</div>
    </div>
  );
  const tabContent = 'flex min-h-0 flex-1 flex-col focus-visible:outline-none';

  return (
    <Page crumbs={crumbs} actions={header} fill>
      <div ref={measure} className="flex min-h-0 flex-1 flex-col">
        <div className={cn('flex-none pt-3', column)}>
          {/* One row: identity on the left, branch and sync on the right; it wraps on narrow windows. */}
          <div className="flex flex-wrap items-center gap-x-4 gap-y-1.5">
            <div className="flex min-w-0 flex-[1_1_22rem] items-baseline gap-2.5">
              <h1 className="shrink-0 truncate text-[1.0625rem] font-semibold tracking-[-0.015em] text-ink">
                {repo.name}
              </h1>
              <RepoTags local remote={!!repo.remoteId} />
              <span className="flex min-w-0 items-center gap-1 text-xs text-muted">
                {repo.description && (
                  <span className="max-w-[40%] shrink-0 truncate">
                    {repo.description} ·
                  </span>
                )}
                <LongValue
                  value={repo.displayPath}
                  label="path"
                  copy={() => copyPath.mutateAsync(repo.id)}
                />
              </span>
            </div>
            <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
              <BranchPicker
                repo={repo}
                onOutcome={(next) => setOutcome(keepNotice(next))}
              />
              <TreeChip repo={repo} />
              <SyncChip repo={repo} />
              <span className="text-xs whitespace-nowrap text-muted">
                {busy ??
                  (status?.fetchedAt
                    ? `Fetched ${relativeTime(status.fetchedAt)}`
                    : status?.hasRemotes
                      ? 'Not fetched yet'
                      : repo.statusAt
                        ? `Status from ${relativeTime(repo.statusAt)}`
                        : '')}
              </span>
              <FetchButton repo={repo} />
              <PushButton repo={repo} />
            </div>
          </div>
          {notices}
          {repo.error && (
            <InlineStatus tone="danger" className="mt-3">
              {repo.error}
            </InlineStatus>
          )}
          {status && (status.conflicts > 0 || status.operation) && (
            <InlineStatus
              tone={status.conflicts > 0 ? 'danger' : 'warning'}
              className="mt-3"
            >
              {status.operation
                ? `A ${status.operation} is in progress${status.conflicts ? ` with ${status.conflicts} unresolved ${status.conflicts === 1 ? 'conflict' : 'conflicts'}` : ''}. Finish or abort it in your editor or terminal, then refresh.`
                : `${status.conflicts} ${status.conflicts === 1 ? 'file has' : 'files have'} unresolved conflicts. Resolve them in your editor, then mark them resolved on Changes.`}
            </InlineStatus>
          )}
          {remote && remote.status !== 'ready' && (
            <InlineStatus tone="warning" className="mt-3">
              {REMOTE_STATUS[remote.status].label}:{' '}
              {REMOTE_STATUS[remote.status].detail}
            </InlineStatus>
          )}
          {outcome && (
            <div className="mt-3">
              <SwitchNotice
                outcome={outcome}
                onClose={() => setOutcome(null)}
                onChanges={() => {
                  setOutcome(null);
                  navigate({ name: 'repository', id: repo.id, tab: 'changes' });
                }}
              />
            </div>
          )}
        </div>

        <Tabs.Root
          value={tab}
          onValueChange={(next) =>
            navigate({ name: 'repository', id: repo.id, tab: next as RepoTab })
          }
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className={cn('flex-none', column)}>
            <Tabs.List
              aria-label="Repository views"
              className="mt-2 flex gap-1 overflow-x-auto border-b border-line"
            >
              {TABS.map((item) => (
                <Tabs.Trigger
                  key={item.value}
                  value={item.value}
                  className="h-9 shrink-0 border-b-2 border-transparent px-2.5 text-[0.8125rem] text-muted hover:text-ink focus-visible:outline-offset-[-2px] data-[state=active]:border-accent data-[state=active]:font-semibold data-[state=active]:text-ink"
                >
                  {item.label}
                  {item.value === 'changes' &&
                    changeCount !== null &&
                    changeCount > 0 && (
                      <span className="ml-1.5 font-medium text-muted tabular-nums">
                        {changeCount}
                      </span>
                    )}
                </Tabs.Trigger>
              ))}
            </Tabs.List>
          </div>
          <Tabs.Content value="changes" className={tabContent}>
            <ChangesTab repo={repo} layout={layout} />
          </Tabs.Content>
          <Tabs.Content value="history" className={tabContent}>
            <HistoryTab
              repo={repo}
              layout={layout === 'narrow' ? 'centered' : layout}
            />
          </Tabs.Content>
          <Tabs.Content value="branches" className={tabContent}>
            {scrolling(
              <BranchesTab
                repo={repo}
                onOutcome={(next) => setOutcome(keepNotice(next))}
              />,
            )}
          </Tabs.Content>
          <Tabs.Content value="pulls" className={tabContent}>
            <PullsTab repo={repo} width={width} />
          </Tabs.Content>
          <Tabs.Content value="remotes" className={tabContent}>
            {scrolling(<RemotesTab repo={repo} />)}
          </Tabs.Content>
          <Tabs.Content value="overview" className={tabContent}>
            {scrolling(
              <>
                <Analytics repo={repo} />
                <PullAnalytics repo={repo} />
                {status && (
                  <Section id="details-heading" title="This repository">
                    <Details repo={repo} remote={remote} />
                  </Section>
                )}
                <Section
                  id="manage-heading"
                  title="Remove or delete"
                  meta="Each action touches one thing only"
                >
                  <RemoveOrDelete
                    repo={repo}
                    remote={remote}
                    mode={mode === 'rename' ? null : mode}
                    setMode={setMode}
                    onGone={gone}
                  />
                </Section>
              </>,
            )}
          </Tabs.Content>
          <Tabs.Content value="settings" className={tabContent}>
            {scrolling(<RepoSettingsTab repo={repo} />)}
          </Tabs.Content>
        </Tabs.Root>
      </div>
    </Page>
  );
}
