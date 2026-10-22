import { FolderOpen, RefreshCw } from 'lucide-react';
import { Fragment, useState } from 'react';
import type {
  ChangedFile,
  RemoteRepository,
  RepositorySummary,
} from '../../../shared/repos';
import {
  FolderMissingArt,
  GitMissingArt,
  NoResultsArt,
  OfflineArt,
  RepositoriesArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { InlineStatus, Loading } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import { relativeTime, useNow } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAuthStatus,
  useLinkRemote,
  useLocateRepository,
  useRefreshRepositories,
  useRemoteRepository,
  useRepositories,
  useRepositoryChanges,
  useRepositoryHistory,
  useRevealRepository,
} from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import {
  fileManagerLabel,
  RepoMenuButton,
  useRepoActions,
} from '../repos/repo-actions';
import { ManageBand, trashName, type ManageMode } from '../repos/manage';
import { BranchLabel, SyncChip, TreeChip } from '../repos/status';
import { Page, PageTitle } from '../shell/page';
import {
  CommitActivity,
  localSummary,
  RecentCommits,
  REMOTE_STATUS,
  RepoTags,
  Section,
  SummaryStrip,
} from './history';

const KIND_LABEL: Record<ChangedFile['kind'], string> = {
  staged: 'Staged',
  modified: 'Not staged',
  untracked: 'Untracked',
  conflict: 'Conflict',
};

function upstreamText(repo: RepositorySummary): string {
  const status = repo.status!;
  if (!status.hasRemotes) return 'No remote configured';
  if (!status.upstream) return 'This branch has no upstream';
  if (status.ahead === null || status.behind === null)
    return `${status.upstream} · not found locally, fetch to compare`;
  return `${status.upstream} · ahead ${status.ahead}, behind ${status.behind} at the last fetch`;
}

function Changes({ repo }: { repo: RepositorySummary }) {
  const refresh = useRefreshRepositories();
  const changes = useRepositoryChanges(
    repo.id,
    repo.statusAt,
    repo.status !== null,
  );
  if (!repo.status) return <Loading label="Checking this repository…" />;
  if (changes.isPending) return <Loading label="Reading changes…" />;
  if (changes.isError)
    return (
      <EmptyState
        compact
        art={<OfflineArt />}
        title="Couldn't read the changes"
        action={
          <Button
            size="sm"
            pending={changes.isFetching}
            onClick={() => void changes.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(changes.error, 'Git did not answer.')}
      </EmptyState>
    );
  const { files, truncated } = changes.data;
  if (!files.length)
    return (
      <EmptyState
        compact
        art={<RepositoriesArt />}
        title="Working tree is clean"
        className="border-t border-line"
        action={
          <Button
            size="sm"
            pending={refresh.isPending || repo.inspecting}
            onClick={() => refresh.mutate(repo.id)}
          >
            {!(refresh.isPending || repo.inspecting) && <RefreshCw />}
            Refresh status
          </Button>
        }
      >
        Edits you save in this folder show up here after the next status check.
      </EmptyState>
    );
  return (
    <>
      <ul className="border-t border-line">
        {files.map((file, index) => (
          <li
            // A path can appear twice: once staged, once not.
            key={`${file.kind}:${file.path}:${index}`}
            className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-line px-2 py-2"
          >
            <span
              aria-label={KIND_LABEL[file.kind]}
              className={cn(
                'grid h-5 w-5.5 place-items-center rounded-[4px] bg-control font-mono text-[0.71875rem] font-semibold text-ink',
                file.kind === 'conflict' && 'bg-danger-soft',
              )}
            >
              {file.code}
            </span>
            <span
              className="truncate font-mono text-[0.78125rem] text-ink"
              title={file.path}
            >
              {file.path}
            </span>
            <span className="text-xs text-muted">{KIND_LABEL[file.kind]}</span>
          </li>
        ))}
      </ul>
      {truncated && (
        <p className="mt-2 text-xs text-muted">
          Showing the first {files.length} changes. Your editor or terminal
          shows the rest.
        </p>
      )}
    </>
  );
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
export function RepositoryPage({ id }: { id: string }) {
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
  return <RepositoryView repo={repo} crumbs={crumbs} />;
}

function RepositoryView({
  repo,
  crumbs,
}: {
  repo: RepositorySummary;
  crumbs: { label: string; onSelect?: () => void }[];
}) {
  useNow();
  const { navigate } = useNavigation();
  const { data: auth } = useAuthStatus();
  const refresh = useRefreshRepositories();
  const reveal = useRevealRepository();
  const locate = useLocateRepository();
  const remoteQuery = useRemoteRepository(
    repo.remoteId ?? '',
    !!repo.remoteId && auth?.status === 'authenticated',
  );
  const remote = remoteQuery.data ?? null;
  const [mode, setMode] = useState<ManageMode | null>(null);
  const { actions, busy } = useRepoActions(repo, setMode, remote);
  const gone = () => navigate({ name: 'repositories' });

  const present = repo.availability === 'available';
  const checking = refresh.isPending || repo.inspecting;
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
  // Renaming opens at the top. Confirmations open in Remove or delete, beside their explanation;
  // each one takes focus, which scrolls it into view when it was chosen from the menu.
  const menuBand = mode === 'rename' && (
    <div className="mb-6">
      <ManageBand
        mode={mode}
        repo={repo}
        remote={remote}
        onClose={() => setMode(null)}
        onGone={gone}
      />
    </div>
  );
  const notices = (
    <>
      {menuBand}
      {problem && (
        <InlineStatus tone="danger" className="mb-6">
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
  return (
    <Page crumbs={crumbs} actions={header}>
      {notices}
      <PageTitle title={repo.name}>
        {repo.description ? `${repo.description} · ` : ''}
        <span className="font-mono text-[0.8125rem]">{repo.displayPath}</span>
      </PageTitle>
      <div className="-mt-3 mb-7 flex flex-wrap items-center gap-x-4.5 gap-y-2">
        <RepoTags local remote={!!repo.remoteId} />
        <BranchLabel repo={repo} />
        <TreeChip repo={repo} />
        <SyncChip repo={repo} />
        {busy ? (
          <span className="text-xs text-muted">{busy}</span>
        ) : (
          repo.statusAt && (
            <span className="text-xs text-muted">
              Status from {relativeTime(repo.statusAt)}
            </span>
          )
        )}
      </div>
      {repo.error && (
        <InlineStatus tone="danger" className="mb-6">
          {repo.error}
        </InlineStatus>
      )}
      {status && (status.conflicts > 0 || status.operation) && (
        <InlineStatus
          tone={status.conflicts > 0 ? 'danger' : 'warning'}
          className="mb-6"
        >
          {status.operation
            ? `A ${status.operation} is in progress${status.conflicts ? ` with ${status.conflicts} unresolved ${status.conflicts === 1 ? 'conflict' : 'conflicts'}` : ''}. Finish or abort it in your editor or terminal, then refresh.`
            : `${status.conflicts} ${status.conflicts === 1 ? 'file has' : 'files have'} unresolved conflicts. Resolve them, then refresh.`}
        </InlineStatus>
      )}
      {remote && remote.status !== 'ready' && (
        <InlineStatus tone="warning" className="mb-6">
          {REMOTE_STATUS[remote.status].label}:{' '}
          {REMOTE_STATUS[remote.status].detail}
        </InlineStatus>
      )}
      <div className="@container">
        <History repo={repo} />
      </div>
      <Section
        id="changes-heading"
        title="Changes"
        meta="Working tree, not committed"
      >
        <Changes repo={repo} />
      </Section>
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
      <InlineStatus className="mt-9">
        Diff views and committing come with a later feature. Until then, commit
        in your editor and gitdesk picks it up.
      </InlineStatus>
    </Page>
  );
}
