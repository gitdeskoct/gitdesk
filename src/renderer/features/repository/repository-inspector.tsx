import { useState, type ReactNode } from 'react';
import type {
  RemoteRepository,
  RepositorySummary,
} from '../../../shared/repos';
import { Button } from '../../components/ui/button';
import { LongValue } from '../../components/ui/long-value';
import { InlineStatus } from '../../components/ui/status';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import type { RepoItem } from '../../lib/repo-status';
import {
  useCopyRepositoryPath,
  useLocateRepository,
  useProvisionRemote,
} from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { ManageBand, type ManageMode } from '../repos/manage';
import {
  RepoMenuButton,
  useRemoteActions,
  useRepoActions,
} from '../repos/repo-actions';
import { useOpenRepo } from '../repos/repo-row';
import { BranchLabel, SyncChip, TreeChip } from '../repos/status';
import { REMOTE_STATUS, RepoTags } from './history';
import { History } from './repository-page';

const dlClass =
  'mt-6 grid grid-cols-[8.5rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 border-y border-line py-3.5 text-sm';

function Heading({
  name,
  description,
  tags,
  actions,
}: {
  name: string;
  description: string | null;
  tags: ReactNode;
  actions: ReactNode;
}) {
  return (
    <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-3">
      <div className="min-w-0">
        <h2 className="truncate text-lg font-semibold tracking-[-0.01em] text-ink">
          {name}
        </h2>
        {description && (
          <p className="mt-1 text-sm leading-relaxed text-muted">
            {description}
          </p>
        )}
        <div className="mt-2.5">{tags}</div>
      </div>
      <div className="flex shrink-0 items-center gap-1.5">{actions}</div>
    </div>
  );
}

function LocalInspector({
  repo,
  remote,
}: {
  repo: RepositorySummary;
  remote: RemoteRepository | null;
}) {
  const openRepo = useOpenRepo();
  const locate = useLocateRepository();
  const copyPath = useCopyRepositoryPath();
  const [mode, setMode] = useState<ManageMode | null>(null);
  const { actions } = useRepoActions(repo, setMode, remote);
  const present = repo.availability === 'available';
  const status = repo.status;
  return (
    <>
      <Heading
        name={repo.name}
        description={repo.description}
        tags={<RepoTags local remote={!!repo.remoteId} />}
        actions={
          <>
            <Button size="sm" onClick={() => openRepo(repo.id)}>
              Open details
            </Button>
            <RepoMenuButton name={repo.name} actions={actions} />
          </>
        }
      />
      {mode && (
        <div className="mt-4">
          <ManageBand
            mode={mode}
            repo={repo}
            remote={remote}
            onClose={() => setMode(null)}
          />
        </div>
      )}
      {!present ? (
        <InlineStatus
          tone="danger"
          className="mt-6"
          action={
            <Button
              size="sm"
              pending={locate.isPending}
              onClick={() => locate.mutate(repo.id)}
            >
              Locate folder
            </Button>
          }
        >
          {repo.availability === 'missing'
            ? `The folder at ${repo.displayPath} can't be found. It may be on a drive that isn't connected.`
            : `${repo.displayPath} is no longer a Git repository.`}
          {locate.isError && (
            <span className="mt-1 block text-danger">
              {ipcErrorMessage(locate.error, "Couldn't use that folder.")}
            </span>
          )}
        </InlineStatus>
      ) : (
        <div className="mt-6 @container">
          <History repo={repo} compact />
        </div>
      )}
      <dl className={dlClass}>
        <dt className="text-muted">Location</dt>
        <dd className="min-w-0 text-[0.78125rem] text-ink">
          <LongValue
            value={repo.displayPath}
            label="path"
            copy={() => copyPath.mutateAsync(repo.id)}
          />
        </dd>
        {present && (
          <>
            <dt className="text-muted">Branch</dt>
            <dd className="min-w-0">
              <BranchLabel repo={repo} />
            </dd>
            <dt className="text-muted">Working tree</dt>
            <dd className="flex flex-wrap gap-x-3.5 gap-y-1">
              <TreeChip repo={repo} />
              <SyncChip repo={repo} />
            </dd>
          </>
        )}
        {status?.lastCommit && (
          <>
            <dt className="text-muted">Last commit</dt>
            <dd className="min-w-0 truncate text-ink">
              {status.lastCommit.subject}{' '}
              <span className="text-muted">
                · {relativeTime(status.lastCommit.at)}
              </span>
            </dd>
          </>
        )}
        <dt className="text-muted">Remote</dt>
        <dd className="text-ink">
          {!repo.remoteId
            ? 'Not linked to your account'
            : remote
              ? `${REMOTE_STATUS[remote.status].label} · ${remote.name}`
              : 'Linked to your account'}
        </dd>
      </dl>
    </>
  );
}

function RemoteInspector({ remote }: { remote: RemoteRepository }) {
  const { navigate } = useNavigation();
  const provision = useProvisionRemote();
  const [mode, setMode] = useState<ManageMode | null>(null);
  const { actions } = useRemoteActions(remote, setMode);
  const status = REMOTE_STATUS[remote.status];
  return (
    <>
      <Heading
        name={remote.name}
        description={remote.description}
        tags={<RepoTags local={false} remote />}
        actions={
          <>
            <Button
              size="sm"
              onClick={() =>
                navigate({ name: 'remote-repository', id: remote.id })
              }
            >
              Open details
            </Button>
            <RepoMenuButton name={remote.name} actions={actions} />
          </>
        }
      />
      {mode && (
        <div className="mt-4">
          <ManageBand
            mode={mode}
            remote={remote}
            onClose={() => setMode(null)}
          />
        </div>
      )}
      {remote.status !== 'ready' && (
        <InlineStatus
          tone={remote.status === 'provisioning' ? 'warning' : 'danger'}
          className="mt-6"
          action={
            remote.status === 'deleting' ? undefined : (
              <Button
                size="sm"
                pending={provision.isPending}
                onClick={() => provision.mutate(remote.id)}
              >
                Retry setup
              </Button>
            )
          }
        >
          <b className="font-semibold">{status.label}.</b> {status.detail}
        </InlineStatus>
      )}
      <dl className={dlClass}>
        <dt className="text-muted">Status</dt>
        <dd className="text-ink">{status.label}</dd>
        <dt className="text-muted">Visibility</dt>
        <dd className="text-ink">Private</dd>
        <dt className="text-muted">Default branch</dt>
        <dd className="font-mono text-[0.78125rem] text-ink">
          {remote.defaultBranch}
        </dd>
        <dt className="text-muted">On this computer</dt>
        <dd className="text-ink">Not cloned</dd>
        <dt className="text-muted">Updated</dt>
        <dd className="text-ink">{relativeTime(remote.updatedAt)}</dd>
      </dl>
    </>
  );
}

// The selected repository beside the list. Same facts as the details page, fewer of them.
export function RepositoryInspector({ item }: { item: RepoItem }) {
  return (
    <section aria-label="Selected repository" className="min-w-0">
      {item.kind === 'local' ? (
        <LocalInspector key={item.key} repo={item.repo} remote={item.remote} />
      ) : (
        <RemoteInspector key={item.key} remote={item.remote} />
      )}
    </section>
  );
}
