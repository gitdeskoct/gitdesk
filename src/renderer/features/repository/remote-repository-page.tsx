import {
  CircleAlert,
  CircleCheck,
  Clock,
  CloudDownload,
  RefreshCw,
} from 'lucide-react';
import { useState } from 'react';
import {
  ActivityArt,
  NoResultsArt,
  OfflineArt,
  RemoteArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { Pager, usePage } from '../../components/ui/pager';
import { InlineStatus, Loading } from '../../components/ui/status';
import { formatDate, relativeTime, useNow } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAuthStatus,
  useProvisionRemote,
  useRemoteActivity,
  useRemoteRepository,
  useRepositories,
  useSettings,
  useSignIn,
} from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { REMOTE_ACTIVITY } from '../home/workspace-sections';
import { ManageBand, type ManageMode } from '../repos/manage';
import { RepoMenuButton, useRemoteActions } from '../repos/repo-actions';
import { ClonePanel } from '../repos/clone-panel';
import { useOpenRepo } from '../repos/repo-row';
import { Page, PageTitle } from '../shell/page';
import { GitUrlField } from './git-url';
import { REMOTE_STATUS, RepoTags, Section } from './history';

// A repository in the account. Everything shown comes from the server; nothing here touches disk.
export function RemoteRepositoryPage({ id }: { id: string }) {
  useNow();
  const { navigate } = useNavigation();
  const { data: auth } = useAuthStatus();
  const { data: settings } = useSettings();
  const signIn = useSignIn();
  const signedIn = auth?.status === 'authenticated' && !settings?.localOnly;
  const query = useRemoteRepository(id, signedIn);
  const remote = query.data;
  const crumbs = [
    {
      label: 'Repositories',
      onSelect: () => navigate({ name: 'repositories', scope: 'remote' }),
    },
    { label: remote?.name ?? 'Remote repository' },
  ];

  if (settings?.localOnly)
    return (
      <Page crumbs={crumbs}>
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
      </Page>
    );
  if (!signedIn)
    return (
      <Page crumbs={crumbs}>
        <EmptyState
          art={<RemoteArt />}
          title="Sign in to see this repository"
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
      </Page>
    );
  if (query.isPending)
    return (
      <Page crumbs={crumbs}>
        <Loading label="Loading the repository…" />
      </Page>
    );
  if (query.isError) {
    const message = ipcErrorMessage(query.error, '');
    const gone = /no longer exists/i.test(message);
    return (
      <Page crumbs={crumbs}>
        <EmptyState
          art={gone ? <NoResultsArt /> : <OfflineArt />}
          title={
            gone
              ? "This repository isn't in your account"
              : "Couldn't load this repository"
          }
          action={
            gone ? (
              <Button onClick={() => navigate({ name: 'repositories' })}>
                Go to Repositories
              </Button>
            ) : (
              <Button
                pending={query.isFetching}
                onClick={() => void query.refetch()}
              >
                Try again
              </Button>
            )
          }
        >
          {gone
            ? 'It was deleted, or it belongs to another account.'
            : message ||
              'The server did not answer; your local work is unaffected.'}
        </EmptyState>
      </Page>
    );
  }
  return <RemoteView id={id} crumbs={crumbs} />;
}

function RemoteView({
  id,
  crumbs,
}: {
  id: string;
  crumbs: { label: string; onSelect?: () => void }[];
}) {
  const { navigate } = useNavigation();
  const query = useRemoteRepository(id, true);
  const remote = query.data!;
  const activity = useRemoteActivity(id, true);
  const activityPage = usePage(activity.data ?? [], 10);
  const provision = useProvisionRemote();
  const openRepo = useOpenRepo();
  const local = useRepositories().data?.find((r) => r.remoteId === id);
  const [mode, setMode] = useState<ManageMode | null>(null);
  const [cloning, setCloning] = useState(false);
  const { actions } = useRemoteActions(remote, setMode);
  const gone = () => navigate({ name: 'repositories', scope: 'remote' });
  const canClone = !local && remote.status === 'ready' && !!remote.gitUrl;
  const status = REMOTE_STATUS[remote.status];

  const header = (
    <>
      <Button
        variant="ghost"
        size="sm"
        pending={query.isFetching}
        onClick={() => {
          void query.refetch();
          void activity.refetch();
        }}
      >
        {!query.isFetching && <RefreshCw />}
        Refresh
      </Button>
      {canClone && (
        <Button size="sm" variant="primary" onClick={() => setCloning(true)}>
          <CloudDownload />
          Clone to this computer
        </Button>
      )}
      <RepoMenuButton name={remote.name} actions={actions} />
    </>
  );

  return (
    <Page
      crumbs={crumbs}
      actions={header}
      aside={
        cloning ? (
          <ClonePanel initial={remote} onClose={() => setCloning(false)} />
        ) : undefined
      }
    >
      <PageTitle title={remote.name}>
        {remote.description || 'No description.'}
      </PageTitle>
      <div className="-mt-3 mb-7 flex flex-wrap items-center gap-x-4.5 gap-y-2">
        <RepoTags local={!!local} remote />
        <span className="text-xs text-muted">
          Updated {relativeTime(remote.updatedAt)}
        </span>
      </div>

      {remote.status !== 'ready' && (
        <InlineStatus
          tone={remote.status === 'provisioning' ? 'warning' : 'danger'}
          className="mb-6"
          action={
            remote.status === 'deleting' ? (
              <Button
                size="sm"
                variant="danger"
                onClick={() => setMode('delete-remote')}
              >
                Delete again
              </Button>
            ) : (
              <Button
                size="sm"
                variant="primary"
                pending={provision.isPending}
                onClick={() => provision.mutate(remote.id)}
              >
                Retry setup
              </Button>
            )
          }
        >
          <b className="font-semibold">{status.label}.</b> {status.detail}
          {provision.isError && (
            <span className="mt-1 block text-danger">
              {ipcErrorMessage(provision.error, "Setup didn't run.")}
            </span>
          )}
        </InlineStatus>
      )}

      {mode === 'edit-remote' && (
        <div className="mb-6">
          <ManageBand
            mode={mode}
            remote={remote}
            onClose={() => setMode(null)}
          />
        </div>
      )}

      <Section
        id="remote-details"
        title="This repository"
        meta="Stored in your gitdesk account"
        className="mt-0"
      >
        <dl className="grid grid-cols-[9rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 border-t border-line py-3 text-sm">
          <dt className="text-muted">Status</dt>
          <dd className="flex items-center gap-1.5 text-ink">
            {remote.status === 'ready' ? (
              <CircleCheck aria-hidden className="size-3.5 text-success" />
            ) : remote.status === 'provisioning' ? (
              <Clock aria-hidden className="size-3.5 text-warning" />
            ) : (
              <CircleAlert aria-hidden className="size-3.5 text-danger" />
            )}
            {status.label}
          </dd>
          <dt className="text-muted">Git URL</dt>
          <dd className="min-w-0">
            {remote.gitUrl ? (
              <GitUrlField url={remote.gitUrl} />
            ) : (
              <span className="text-muted">
                None yet. The gitdesk server gives one once Git hosting is
                turned on.
              </span>
            )}
          </dd>
          <dt className="text-muted">Visibility</dt>
          <dd className="text-ink">
            Private · only your signed-in account can see it
          </dd>
          <dt className="text-muted">Default branch</dt>
          <dd className="font-mono text-[0.78125rem] text-ink">
            {remote.defaultBranch}
          </dd>
          <dt className="text-muted">Repository ID</dt>
          <dd className="truncate font-mono text-[0.78125rem] text-muted">
            {remote.id}
          </dd>
          <dt className="text-muted">Created</dt>
          <dd className="text-ink">
            {formatDate(remote.createdAt)} · updated{' '}
            {relativeTime(remote.updatedAt)}
          </dd>
        </dl>
      </Section>

      <Section id="remote-local" title="On this computer">
        {local ? (
          <InlineStatus
            className="border-y border-line py-3"
            action={
              <Button size="sm" onClick={() => openRepo(local.id)}>
                Open
              </Button>
            }
          >
            Linked to <b className="font-semibold">{local.name}</b> at{' '}
            <span className="font-mono text-[0.8125rem]">
              {local.displayPath}
            </span>
            .
          </InlineStatus>
        ) : (
          <InlineStatus
            className="border-y border-line py-3"
            action={
              canClone ? (
                <Button size="sm" onClick={() => setCloning(true)}>
                  Clone
                </Button>
              ) : undefined
            }
          >
            {remote.gitUrl
              ? 'No copy on this computer yet. Clone it to work on it here; it stays linked to this repository.'
              : 'No copy on this computer. Without a Git URL this repository holds its name, description and settings only.'}
          </InlineStatus>
        )}
      </Section>

      <Section
        id="remote-activity"
        title="Activity"
        meta="From your account, newest first"
      >
        {activity.isPending ? (
          <Loading label="Loading activity…" />
        ) : activity.isError ? (
          <EmptyState
            compact
            art={<OfflineArt />}
            title="Couldn't load the activity"
            className="border-t border-line"
            action={
              <Button
                size="sm"
                pending={activity.isFetching}
                onClick={() => void activity.refetch()}
              >
                Try again
              </Button>
            }
          >
            {ipcErrorMessage(activity.error, 'The server did not answer.')}
          </EmptyState>
        ) : activity.data.length ? (
          <>
            <ul className="border-t border-line">
              {activityPage.items.map((item) => (
                <li
                  key={item.id}
                  className="flex items-center gap-3 border-b border-line py-2.5 text-[0.84375rem]"
                >
                  <span className="min-w-0 flex-1 truncate font-medium text-ink">
                    {REMOTE_ACTIVITY[item.type]}
                  </span>
                  <span className="shrink-0 text-xs text-muted">
                    {relativeTime(item.createdAt)}
                  </span>
                </li>
              ))}
            </ul>
            <Pager
              label="Activity pages"
              onPage={activityPage.setPage}
              {...activityPage}
            />
          </>
        ) : (
          <EmptyState
            compact
            art={<ActivityArt />}
            title="No activity yet"
            className="border-t border-line"
            action={
              <Button
                size="sm"
                pending={activity.isFetching}
                onClick={() => void activity.refetch()}
              >
                Refresh
              </Button>
            }
          >
            Renames, setup and deletion attempts show up here.
          </EmptyState>
        )}
      </Section>

      <Section id="remote-delete" title="Delete">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-2 border-y border-line py-3.5">
          <div className="min-w-64 flex-1">
            <div className="text-sm font-semibold text-ink">
              Delete remote repository
            </div>
            <p className="mt-0.5 text-[0.8125rem] leading-relaxed text-muted">
              Deletes it and its stored data from your account. Local folders
              aren't affected.
            </p>
          </div>
          <Button
            size="sm"
            variant="danger"
            aria-expanded={mode === 'delete-remote'}
            onClick={() =>
              setMode(mode === 'delete-remote' ? null : 'delete-remote')
            }
          >
            Delete remote
          </Button>
        </div>
        {mode === 'delete-remote' && (
          <ManageBand
            mode={mode}
            remote={remote}
            onClose={() => setMode(null)}
            onGone={gone}
          />
        )}
      </Section>
    </Page>
  );
}
