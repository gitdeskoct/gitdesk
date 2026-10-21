import { FolderOpen, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { ChangedFile, RepositorySummary } from '../../../shared/repos';
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
  useRepositories,
  useRepositoryChanges,
  useRevealRepository,
} from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import {
  fileManagerLabel,
  RepoMenuButton,
  useRepoActions,
} from '../repos/repo-actions';
import { RemoveConfirm } from '../repos/repo-row';
import { BranchLabel, SyncChip, TreeChip } from '../repos/status';
import { Page, PageTitle } from '../shell/page';

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

function Details({ repo }: { repo: RepositorySummary }) {
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
        {repo.remoteId
          ? 'Linked to your account · private'
          : 'Not linked to your account'}
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
      <dt className="text-muted">Added</dt>
      <dd className="text-ink">
        {relativeTime(repo.addedAt)}
        {repo.lastOpenedAt && ` · opened ${relativeTime(repo.lastOpenedAt)}`}
      </dd>
    </dl>
  );
}

// The workspace for one registered repository. Commit and diff views arrive in a later feature;
// this page shows what Git reports and links out to the folder.
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
  const refresh = useRefreshRepositories();
  const reveal = useRevealRepository();
  const locate = useLocateRepository();
  const [confirming, setConfirming] = useState(false);
  const { actions, busy } = useRepoActions(repo, () => setConfirming(true));

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
            variant="ghost"
            size="sm"
            pending={reveal.isPending}
            onClick={() => reveal.mutate(repo.id)}
          >
            {!reveal.isPending && <FolderOpen />}
            {fileManagerLabel()}
          </Button>
        </>
      )}
      <RepoMenuButton repo={repo} actions={actions} />
    </>
  );
  const problem = reveal.error ?? locate.error;
  const notices = (
    <>
      {confirming && (
        <div className="mb-6">
          <RemoveConfirm
            repo={repo}
            onCancel={() => setConfirming(false)}
            onRemoved={() => navigate({ name: 'repositories' })}
          />
        </div>
      )}
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
            ? `It was at ${repo.displayPath} and has been moved or deleted since.`
            : `The folder at ${repo.displayPath} is there, but Git no longer recognises it.`}
        </EmptyState>
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
      <section aria-labelledby="changes-heading">
        <h2
          id="changes-heading"
          className="mb-2 text-[0.9375rem] font-semibold text-ink"
        >
          Changes
        </h2>
        <Changes repo={repo} />
      </section>
      {status && (
        <section aria-labelledby="details-heading" className="mt-9">
          <h2
            id="details-heading"
            className="mb-2 text-[0.9375rem] font-semibold text-ink"
          >
            This repository
          </h2>
          <Details repo={repo} />
        </section>
      )}
      <InlineStatus className="mt-7">
        Commit and diff views come with the next feature. Until then, commit in
        your editor and gitdesk picks it up.
      </InlineStatus>
    </Page>
  );
}
