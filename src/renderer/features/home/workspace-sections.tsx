import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  Clock,
  CloudDownload,
  CloudOff,
  CloudUpload,
  Cloud,
  FolderOpen,
  FolderPlus,
  FolderX,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Link2,
  Pencil,
  Undo2,
  Unlink,
  type LucideIcon,
} from 'lucide-react';
import { useState } from 'react';
import type {
  LocalActivity,
  RemoteActivity,
  RemoteOverview,
  RepositorySummary,
} from '../../../shared/repos';
import { ActivityArt, OfflineArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { Pager, usePage } from '../../components/ui/pager';
import { InlineStatus, Loading } from '../../components/ui/status';
import { useToast } from '../../components/ui/toast';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { changeCount, type Attention } from '../../lib/repo-status';
import {
  useInitializeRepository,
  useLocateRepository,
  useRefreshRemote,
  useRepositoryActivity,
} from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { useWorkspaceUi } from '../../app/workspace-ui';
import { RemoveConfirm } from '../repos/manage';
import { useOpenRepo } from '../repos/repo-row';

const count = (n: number | null | undefined, one: string, many: string) =>
  `${n ?? 0} ${n === 1 ? one : many}`;

const ATTENTION: Record<
  Attention['kind'],
  {
    icon: LucideIcon;
    tone: string;
    text: (repo: RepositorySummary) => string;
    detail: string;
  }
> = {
  missing: {
    icon: FolderX,
    tone: 'text-danger',
    text: (r) => `${r.name}'s folder can't be found`,
    detail: 'It was moved or deleted.',
  },
  'not-a-repo': {
    icon: CircleAlert,
    tone: 'text-danger',
    text: (r) => `${r.name} is no longer a Git repository`,
    detail: 'The folder is there, but Git does not recognise it.',
  },
  error: {
    icon: CircleAlert,
    tone: 'text-danger',
    text: (r) => `Git couldn't read ${r.name}`,
    detail: 'Open it for details.',
  },
  conflict: {
    icon: GitMerge,
    tone: 'text-danger',
    text: (r) =>
      `${r.name} has ${count(r.status?.conflicts, 'unresolved conflict', 'unresolved conflicts')}`,
    detail: 'Resolve them before you commit.',
  },
  operation: {
    icon: GitMerge,
    tone: 'text-warning',
    text: (r) => `A ${r.status?.operation} is in progress in ${r.name}`,
    detail: 'Finish or abort it in your terminal.',
  },
  diverged: {
    icon: GitBranch,
    tone: 'text-warning',
    text: (r) => `${r.name} has diverged from its upstream`,
    detail: 'Both sides have commits the other lacks.',
  },
  behind: {
    icon: ArrowDown,
    tone: 'text-warning',
    text: (r) =>
      `${r.name} is ${count(r.status?.behind, 'commit', 'commits')} behind its upstream`,
    detail: 'Compared with the last fetched upstream.',
  },
  changed: {
    icon: Pencil,
    tone: 'text-warning',
    text: (r) =>
      `${r.name} has ${count(changeCount(r.status), 'uncommitted change', 'uncommitted changes')}`,
    detail: 'Staged, modified or untracked files.',
  },
  ahead: {
    icon: ArrowUp,
    tone: 'text-accent',
    text: (r) =>
      `${r.name} has ${count(r.status?.ahead, 'commit', 'commits')} to push`,
    detail: 'Ahead of its known upstream.',
  },
  'no-upstream': {
    icon: CloudOff,
    tone: 'text-muted',
    text: (r) =>
      `${r.status?.branch ?? 'This branch'} in ${r.name} has no upstream`,
    detail: "The repository has a remote, but this branch isn't tracking it.",
  },
};

function AttentionRow({ repo, kind }: Attention) {
  const openRepo = useOpenRepo();
  const locate = useLocateRepository();
  const toast = useToast();
  const [confirming, setConfirming] = useState(false);
  const entry = ATTENTION[kind];
  const lost = kind === 'missing' || kind === 'not-a-repo';
  return (
    <li className="border-b border-line">
      <div className="flex items-center gap-3 py-2.5">
        <entry.icon aria-hidden className={`size-4 shrink-0 ${entry.tone}`} />
        <div className="min-w-0 flex-1">
          <div className="truncate text-[0.84375rem] font-medium text-ink">
            {entry.text(repo)}
          </div>
          <div className="truncate text-xs text-muted">{entry.detail}</div>
        </div>
        {lost ? (
          <div className="flex gap-1.5">
            <Button
              size="sm"
              pending={locate.isPending}
              onClick={() =>
                locate.mutate(repo.id, {
                  onError: (err) =>
                    toast({
                      tone: 'danger',
                      title: "Couldn't use that folder",
                      description: ipcErrorMessage(
                        err,
                        'Pick the folder that holds the repository.',
                      ),
                    }),
                })
              }
            >
              Locate
            </Button>
            <Button
              size="sm"
              variant="ghost"
              onClick={() => setConfirming(true)}
            >
              Remove
            </Button>
          </div>
        ) : (
          <Button size="sm" onClick={() => openRepo(repo.id)}>
            Open
          </Button>
        )}
      </div>
      {confirming && (
        <RemoveConfirm repo={repo} onCancel={() => setConfirming(false)} />
      )}
    </li>
  );
}

export function AttentionList({
  items,
  remote,
  pageSize,
}: {
  items: Attention[];
  remote: RemoteOverview | undefined;
  pageSize: number;
}) {
  const refresh = useRefreshRemote();
  const paged = usePage(items, pageSize);
  // Ahead and behind are only as fresh as the last fetch, so stale remote data is itself worth saying.
  const stale = remote && remote.state === 'cached' && remote.fetchedAt;
  return (
    <>
      <ul className="border-t border-line">
        {stale && (
          <li className="flex items-center gap-3 border-b border-line py-2.5">
            <Clock aria-hidden className="size-4 shrink-0 text-warning" />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[0.84375rem] font-medium text-ink">
                Remote details are from {relativeTime(remote.fetchedAt!)}
              </div>
              <div className="truncate text-xs text-muted">
                {remote.error === 'offline'
                  ? "You're offline."
                  : "The server didn't answer."}{' '}
                Counts may have changed since.
              </div>
            </div>
            <Button
              size="sm"
              pending={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              Retry
            </Button>
          </li>
        )}
        {paged.items.map((item) => (
          <AttentionRow key={item.repo.id} {...item} />
        ))}
      </ul>
      <Pager label="Needs attention pages" onPage={paged.setPage} {...paged} />
    </>
  );
}

const LOCAL: Record<
  LocalActivity['type'],
  { icon: LucideIcon; label: string }
> = {
  added: { icon: FolderPlus, label: 'Added to gitdesk' },
  created: { icon: FolderPlus, label: 'Created' },
  cloned: { icon: CloudDownload, label: 'Cloned' },
  opened: { icon: FolderOpen, label: 'Opened' },
  commit: { icon: GitCommitHorizontal, label: 'New commit' },
  checkout: { icon: GitBranch, label: 'Switched to' },
  renamed: { icon: Pencil, label: 'Renamed to' },
  unlinked: { icon: Unlink, label: 'Disconnected from its remote' },
  fetched: { icon: CloudDownload, label: 'Fetched from' },
  pushed: { icon: CloudUpload, label: 'Pushed' },
  'hosted-remote-added': { icon: Link2, label: 'Added the Git URL' },
  'pr-merged': { icon: GitMerge, label: 'Merged pull request' },
  'pr-reverted': { icon: Undo2, label: 'Reverted pull request' },
  'branch-created': { icon: GitBranch, label: 'New branch' },
};

export const REMOTE_ACTIVITY: Record<RemoteActivity['type'], string> = {
  'repository.created': 'Remote created',
  'repository.updated': 'Remote details changed',
  'repository.deleted': 'Remote deleted',
  'repository.provisioned': 'Storage ready',
  'repository.provisioning_failed': 'Storage setup failed',
  'repository.deletion_failed': "Deletion didn't finish",
};

type Entry = {
  key: string;
  name: string;
  icon: LucideIcon;
  text: string;
  at: number;
  source: string;
};

// Local events and the account's events in one list, each labelled with where it happened.
// Settings › Workspace decides which sources show and whether opens count.
export function ActivityList({
  remote,
  pageSize,
  source,
  includeOpens,
}: {
  remote: RemoteOverview | undefined;
  pageSize: number;
  source: 'both' | 'local' | 'account';
  includeOpens: boolean;
}) {
  const activity = useRepositoryActivity();
  const { addRepository, adding } = useWorkspaceUi();
  const { navigate } = useNavigation();

  const entries: Entry[] = [
    ...(source === 'account' ? [] : (activity.data ?? []))
      .filter((item) => includeOpens || item.type !== 'opened')
      .map((item) => ({
        key: `local:${item.id}`,
        name: item.repositoryName,
        icon: LOCAL[item.type].icon,
        text: `${LOCAL[item.type].label}${item.detail ? `: ${item.detail}` : ''}`,
        at: item.at,
        source: 'This computer',
      })),
    ...(source === 'local' ? [] : (remote?.activity ?? [])).map((item) => ({
      key: `remote:${item.id}`,
      name: item.repositoryName,
      icon: Cloud,
      text: REMOTE_ACTIVITY[item.type],
      at: item.createdAt,
      source: 'Your account',
    })),
  ].sort((a, b) => b.at - a.at);
  const paged = usePage(entries, pageSize);

  if (activity.isPending) return <Loading label="Loading activity…" />;
  if (activity.isError)
    return (
      <EmptyState
        compact
        art={<OfflineArt />}
        title="Couldn't load activity"
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
        {ipcErrorMessage(
          activity.error,
          'gitdesk could not read its local activity log.',
        )}
      </EmptyState>
    );

  if (!entries.length)
    return activity.data?.length || remote?.activity.length ? (
      // Something exists but the filters hide it: say so, and offer the way to change them.
      <EmptyState
        compact
        art={<ActivityArt />}
        title="Nothing matches these activity settings"
        action={
          <Button
            size="sm"
            onClick={() =>
              navigate({
                name: 'settings',
                section: 'workspace',
                row: 'activity-source',
              })
            }
          >
            Change activity settings
          </Button>
        }
      >
        {source === 'account'
          ? "Your account hasn't recorded any remote changes yet."
          : 'Opens are hidden, and nothing else has happened yet.'}
      </EmptyState>
    ) : (
      <EmptyState
        compact
        art={<ActivityArt />}
        title="No activity yet"
        action={
          <Button size="sm" pending={adding} onClick={addRepository}>
            Open repository
          </Button>
        }
      >
        New commits, branch switches and remote changes show up here.
      </EmptyState>
    );
  return (
    <>
      <ul className="border-t border-line">
        {paged.items.map((entry) => (
          <li
            key={entry.key}
            className="flex gap-3 border-b border-line py-2.5"
          >
            <entry.icon
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-muted"
            />
            <div className="min-w-0">
              <div className="truncate text-[0.84375rem] font-medium text-ink">
                {entry.name}
              </div>
              <div className="truncate text-xs text-muted" title={entry.text}>
                {entry.text} · {relativeTime(entry.at)} · {entry.source}
              </div>
            </div>
          </li>
        ))}
      </ul>
      <Pager label="Recent activity pages" onPage={paged.setPage} {...paged} />
    </>
  );
}

// The result of the last "Open repository", inline at the top of the page.
export function AddNotice() {
  const { notice, dismissNotice } = useWorkspaceUi();
  const initialize = useInitializeRepository();
  const openRepo = useOpenRepo();
  if (!notice) return null;
  if (notice.kind === 'error')
    return (
      <InlineStatus
        tone="danger"
        className="mb-6"
        action={
          <Button size="sm" variant="ghost" onClick={dismissNotice}>
            Dismiss
          </Button>
        }
      >
        {notice.message}
      </InlineStatus>
    );
  return (
    <InlineStatus
      tone="warning"
      className="mb-6"
      action={
        <div className="flex gap-2">
          <Button
            size="sm"
            pending={initialize.isPending}
            onClick={() =>
              initialize.mutate(notice.token, {
                onSuccess: (repo) => {
                  dismissNotice();
                  openRepo(repo.id);
                },
              })
            }
          >
            Initialize Git here
          </Button>
          <Button size="sm" variant="ghost" onClick={dismissNotice}>
            Dismiss
          </Button>
        </div>
      }
    >
      <span className="font-mono text-[0.8125rem]">{notice.displayPath}</span>{' '}
      isn't a Git repository.
      {initialize.isError && (
        <span className="mt-1 block text-danger">
          {ipcErrorMessage(initialize.error, "Couldn't initialize Git there.")}
        </span>
      )}
    </InlineStatus>
  );
}
