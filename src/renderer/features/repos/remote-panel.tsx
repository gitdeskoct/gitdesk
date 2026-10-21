import { Clock, RefreshCw } from 'lucide-react';
import { useEffect, useState } from 'react';
import { OfflineArt, RemoteArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { InlineStatus, Loading } from '../../components/ui/status';
import { relativeTime } from '../../lib/format';
import {
  useRefreshRemote,
  useRemoteOverview,
  useRepositories,
  useSignIn,
} from '../../lib/queries';
import { useWorkspaceUi } from '../../app/workspace-ui';
import { useOpenRepo } from './repo-row';
import { SidePanel } from './side-panel';

// Seconds until main allows the next manual refresh; the button says so instead of failing.
function useWait(until: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until || until <= Date.now()) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

export function RemotePanel({ onClose }: { onClose: () => void }) {
  const overview = useRemoteOverview();
  const refresh = useRefreshRemote();
  const { data: local } = useRepositories();
  const signIn = useSignIn();
  const { setPanel } = useWorkspaceUi();
  const openRepo = useOpenRepo();
  const remote = overview.data;
  const wait = useWait(remote?.nextRefreshAt ?? null);

  const body = () => {
    if (overview.isPending) return <Loading label="Loading remote repositories…" />;
    if (!remote || remote.state === 'signed-out')
      return (
        <EmptyState
          compact
          art={<RemoteArt />}
          title="Sign in to see your remote"
          action={
            <Button size="sm" pending={signIn.isPending} onClick={() => signIn.mutate()}>
              Sign in
            </Button>
          }
        >
          Remote repositories belong to your gitdesk account.
        </EmptyState>
      );
    if (remote.state === 'never')
      return (
        <EmptyState
          compact
          art={<OfflineArt />}
          title={remote.error ? "Can't load your remote" : 'Not loaded yet'}
          action={
            <Button
              size="sm"
              pending={refresh.isPending}
              disabled={wait > 0}
              onClick={() => refresh.mutate()}
            >
              {wait > 0 ? `Try again in ${wait}s` : 'Load now'}
            </Button>
          }
        >
          {remote.error === 'offline'
            ? "You're offline. Local repositories keep working."
            : remote.error
              ? 'The server did not answer. Your local work is unaffected.'
              : 'Automatic refresh is off. Load the list when you want it.'}
        </EmptyState>
      );
    if (!remote.recent.length)
      return (
        <EmptyState
          compact
          art={<RemoteArt />}
          title="No remote repositories yet"
          action={
            <Button size="sm" onClick={() => setPanel('create')}>
              Create repository
            </Button>
          }
        >
          Create one with "Also create a private remote".
        </EmptyState>
      );
    return (
      <ul className="border-t border-line">
        {remote.recent.map((repo) => {
          const linked = local?.find((l) => l.remoteId === repo.id);
          return (
            <li key={repo.id} className="flex items-center gap-3 border-b border-line py-3">
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold text-ink">{repo.name}</div>
                <div className="truncate text-xs text-muted">
                  {repo.description || `Private · updated ${relativeTime(repo.updatedAt)}`}
                </div>
              </div>
              {linked ? (
                <Button
                  size="sm"
                  onClick={() => {
                    onClose();
                    openRepo(linked.id);
                  }}
                >
                  Open
                </Button>
              ) : (
                <span className="text-xs text-muted">Not on this computer</span>
              )}
            </li>
          );
        })}
      </ul>
    );
  };

  return (
    <SidePanel title="Remote repositories" onClose={onClose}>
      <div className="mb-4 flex items-center justify-between gap-3 text-[0.8125rem] text-muted">
        <span className="flex min-w-0 items-center gap-1.5">
          {remote?.state === 'cached' && (
            <Clock aria-hidden className="size-3.5 shrink-0 text-warning" />
          )}
          <span className="truncate">
            {remote?.fetchedAt
              ? `${remote.state === 'cached' ? 'Cached' : 'Updated'} ${relativeTime(remote.fetchedAt)}${remote.total !== null ? ` · ${remote.total} in total` : ''}`
              : 'Your gitdesk account'}
          </span>
        </span>
        {remote && remote.state !== 'signed-out' && (
          <Button
            variant="ghost"
            size="sm"
            pending={refresh.isPending}
            disabled={wait > 0}
            onClick={() => refresh.mutate()}
          >
            {!refresh.isPending && <RefreshCw />}
            {wait > 0 ? `${wait}s` : 'Refresh'}
          </Button>
        )}
      </div>
      {body()}
      {remote?.error === 'rate-limited' && (
        <InlineStatus tone="warning" className="mt-4">
          The server asked gitdesk to slow down. The list refreshes again shortly.
        </InlineStatus>
      )}
      <p className="mt-6 text-[0.8125rem] leading-relaxed text-muted">
        Cloning needs the sync transport, which stores Git objects in R2. It arrives with
        the sync feature; until then this lists your account's repositories and which are
        linked here.
      </p>
    </SidePanel>
  );
}
