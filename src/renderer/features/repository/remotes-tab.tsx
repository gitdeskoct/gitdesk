import { CloudDownload, FolderOpen } from 'lucide-react';
import type {
  RemoteRepository,
  RepositorySummary,
} from '../../../shared/repos';
import { RemoteArt, OfflineArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { JobProgress } from '../../components/ui/job-progress';
import { InlineStatus, Loading } from '../../components/ui/status';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAuthStatus,
  useLinkRemote,
  useRemotes,
  useRevealRepository,
} from '../../lib/queries';
import { fileManagerLabel } from '../repos/repo-actions';
import { REMOTE_STATUS, Section } from './history';
import { useFetchAction } from './use-fetch';

const PROTOCOL: Record<string, string> = {
  https: 'HTTPS',
  http: 'HTTP, unencrypted',
  ssh: 'SSH',
  git: 'Git protocol, unencrypted',
  file: 'Local path',
  other: 'Other transport',
};

// The repository's own Git remotes, from its config, and the account link kept by gitdesk.
export function RemotesTab({
  repo,
  remote,
}: {
  repo: RepositorySummary;
  remote: RemoteRepository | null;
}) {
  const remotes = useRemotes(repo.id, repo.statusAt);
  const action = useFetchAction(repo.id);
  const link = useLinkRemote();
  const reveal = useRevealRepository();
  const { data: auth } = useAuthStatus();
  const signedIn = auth?.status === 'authenticated';

  let body;
  if (remotes.isPending)
    body = <Loading label="Reading this repository's remotes…" />;
  else if (remotes.isError)
    body = (
      <EmptyState
        compact
        art={<OfflineArt />}
        title="Couldn't read the remotes"
        action={
          <Button
            size="sm"
            pending={remotes.isFetching}
            onClick={() => void remotes.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(remotes.error, 'Git did not answer.')}
      </EmptyState>
    );
  else if (!remotes.data.length)
    body = (
      <EmptyState
        compact
        className="border-t border-line"
        art={<RemoteArt />}
        title="No remotes configured"
        action={
          signedIn && !repo.remoteId ? (
            <Button
              size="sm"
              pending={link.isPending}
              onClick={() => link.mutate(repo.id)}
            >
              Create private remote
            </Button>
          ) : (
            <Button
              size="sm"
              pending={reveal.isPending}
              onClick={() => reveal.mutate(repo.id)}
            >
              {!reveal.isPending && <FolderOpen />}
              {fileManagerLabel()}
            </Button>
          )
        }
      >
        This repository only exists on this computer. Add a Git remote with git
        remote add in a terminal to fetch from it here.
      </EmptyState>
    );
  else
    body = (
      <ul className="border-t border-line">
        {remotes.data.map((entry) => {
          const running = action.running?.remote === entry.name;
          const result =
            action.result?.remote === entry.name ? action.result : null;
          return (
            <li key={entry.name} className="border-b border-line py-3">
              <div className="grid grid-cols-[minmax(6rem,9rem)_minmax(0,1fr)_auto] items-center gap-x-4 gap-y-1">
                <b className="truncate font-mono text-[0.8125rem] font-semibold text-ink">
                  {entry.name}
                </b>
                <div className="min-w-0">
                  <div
                    className="truncate font-mono text-[0.78125rem] text-ink"
                    title={entry.fetchUrl}
                  >
                    {entry.fetchUrl}
                  </div>
                  <div className="text-xs text-muted">
                    {PROTOCOL[entry.protocol]}
                    {entry.pushUrl && ` · pushes to ${entry.pushUrl}`}
                  </div>
                </div>
                {running ? (
                  <Button size="sm" onClick={action.cancel}>
                    Cancel fetch
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    aria-disabled={!!action.running || undefined}
                    onClick={() => !action.running && action.start(entry.name)}
                  >
                    <CloudDownload />
                    Fetch
                  </Button>
                )}
              </div>
              {running && (
                <div className="mt-3 sm:ml-[calc(9rem+1rem)]">
                  <JobProgress
                    label={`Fetching ${entry.name}`}
                    stage={action.progress?.stage ?? 'Connecting'}
                    right={action.progress ? `${action.progress.percent}%` : ''}
                    percent={action.progress?.percent ?? 0}
                    progress={action.progress}
                    network
                  />
                </div>
              )}
              {entry.hadCredentials && (
                <InlineStatus
                  tone="warning"
                  className="mt-2 sm:ml-[calc(9rem+1rem)]"
                >
                  This URL has a user name or password written into it. gitdesk
                  hides it here, but Git keeps it in plain text in the
                  repository's config. A credential helper keeps it safer.
                </InlineStatus>
              )}
              {result && (
                <InlineStatus
                  tone={result.status === 'fetched' ? 'success' : 'danger'}
                  className="mt-2 sm:ml-[calc(9rem+1rem)]"
                >
                  {result.status === 'fetched'
                    ? 'Fetched. Remote-tracking branches are up to date; your branch and files were not changed.'
                    : result.message}
                </InlineStatus>
              )}
            </li>
          );
        })}
      </ul>
    );

  return (
    <>
      <Section
        id="git-remotes-heading"
        title="Git remotes"
        meta="From this repository's Git config. Fetch never merges into your branch."
        className="mt-6"
      >
        {body}
      </Section>
      <Section
        id="account-link-heading"
        title="Your gitdesk account"
        meta="Metadata only"
      >
        <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 border-y border-line py-3 text-sm">
          <dt className="text-muted">Linked remote</dt>
          <dd className="min-w-0 text-ink">
            {!repo.remoteId
              ? 'Not linked to your account'
              : remote
                ? `${remote.name} · ${REMOTE_STATUS[remote.status].label} · private`
                : 'Linked to your account'}
          </dd>
          <dt className="text-muted">Git transport</dt>
          <dd className="text-ink">
            Not built yet. Fetching from and pushing to gitdesk hosting needs
            the sync service. Fetch from any Git remote above works now.
          </dd>
        </dl>
        {link.isError && (
          <InlineStatus tone="danger" className="mt-3">
            {ipcErrorMessage(link.error, "The remote wasn't created.")}
          </InlineStatus>
        )}
      </Section>
    </>
  );
}
