import { CloudDownload, FolderOpen } from 'lucide-react';
import type { RepositorySummary } from '../../../shared/repos';
import { RemoteArt, OfflineArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { JobProgress } from '../../components/ui/job-progress';
import { LongValue } from '../../components/ui/long-value';
import { InlineStatus, Loading } from '../../components/ui/status';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAuthStatus,
  useLinkRemote,
  useRemotes,
  useRemoteRepository,
  useRevealRepository,
  useSettings,
} from '../../lib/queries';
import { fileManagerLabel } from '../repos/repo-actions';
import { Section } from './history';
import { HostedRemoteSection, sameGitUrl } from './hosted-remote';
import { useFetchAction } from './use-fetch';
import { AutoLinkBand, MoveSection } from '../sync/move-section';

const PROTOCOL: Record<string, string> = {
  https: 'HTTPS',
  http: 'HTTP, unencrypted',
  ssh: 'SSH',
  git: 'Git protocol, unencrypted',
  file: 'Local path',
  other: 'Other transport',
};

// The repository's own Git remotes, from its config, and the account link kept by gitdesk.
export function RemotesTab({ repo }: { repo: RepositorySummary }) {
  const remotes = useRemotes(repo.id, repo.statusAt);
  const action = useFetchAction(repo.id);
  const link = useLinkRemote();
  const reveal = useRevealRepository();
  const { data: auth } = useAuthStatus();
  const { data: settings } = useSettings();
  const signedIn = auth?.status === 'authenticated';
  const hosted = useRemoteRepository(
    repo.remoteId ?? '',
    !!repo.remoteId && signedIn,
  ).data?.gitUrl;

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
                <b className="flex min-w-0 items-center gap-1.5 font-mono text-[0.8125rem] font-semibold text-ink">
                  <span className="truncate">{entry.name}</span>
                  {hosted && sameGitUrl(entry.fetchUrl, hosted) && (
                    <span className="inline-flex h-5 items-center rounded-[4px] border border-line bg-sunken px-1.5 font-sans text-[0.71875rem] font-medium">
                      gitdesk
                    </span>
                  )}
                </b>
                <div className="min-w-0">
                  <LongValue
                    value={entry.fetchUrl}
                    label="remote URL"
                    className="text-[0.78125rem] text-ink"
                  />
                  <div className="text-xs text-muted">
                    {PROTOCOL[entry.protocol]}
                    {hosted && sameGitUrl(entry.fetchUrl, hosted)
                      ? ' · signed in through your account'
                      : ''}
                  </div>
                  {entry.pushUrl && (
                    <div className="flex min-w-0 items-center gap-1 text-xs text-muted">
                      <span className="shrink-0">Pushes to</span>
                      <LongValue value={entry.pushUrl} label="push URL" />
                    </div>
                  )}
                </div>
                {running ? (
                  <span className="flex gap-1.5">
                    <Button size="sm" pending>
                      Fetching
                    </Button>
                    <Button size="sm" variant="ghost" onClick={action.cancel}>
                      Cancel
                    </Button>
                  </span>
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
      <AutoLinkBand repo={repo} />
      <Section
        id="git-remotes-heading"
        title="Git remotes"
        meta="From this repository's Git config. Fetch never merges into your branch."
        className="mt-6"
      >
        {body}
        <MoveSection repo={repo} />
      </Section>
      <HostedRemoteSection
        repo={repo}
        gitRemotes={remotes.data}
        tokenLifetime={settings?.hostingTokenLifetime ?? 3600}
      />
    </>
  );
}
