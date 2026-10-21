import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  FolderOpen,
  FolderPlus,
  FolderX,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  Pencil,
  type LucideIcon,
} from 'lucide-react';
import type { LocalActivity, RepositorySummary } from '../../../shared/repos';
import { ActivityArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { InlineStatus } from '../../components/ui/status';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { changeCount, type Attention } from '../../lib/repo-status';
import { useInitializeRepository, useRepositoryActivity } from '../../lib/queries';
import { useWorkspaceUi } from '../../app/workspace-ui';
import { useOpenRepo } from '../repos/repo-row';

const ATTENTION: Record<
  Attention['kind'],
  { icon: LucideIcon; tone: string; text: (repo: RepositorySummary) => string; detail: string }
> = {
  missing: {
    icon: FolderX,
    tone: 'text-danger',
    text: (r) => `${r.name}'s folder can't be found`,
    detail: 'It was moved or deleted. Locate it again or remove it from gitdesk.',
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
    text: (r) => `${r.name} has ${r.status?.conflicts} unresolved conflicts`,
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
    text: (r) => `${r.name} is ${r.status?.behind} behind its upstream`,
    detail: 'Compared with the last fetched upstream.',
  },
  changed: {
    icon: Pencil,
    tone: 'text-warning',
    text: (r) => `${r.name} has ${changeCount(r.status)} uncommitted changes`,
    detail: 'Staged, modified or untracked files.',
  },
  ahead: {
    icon: ArrowUp,
    tone: 'text-accent',
    text: (r) => `${r.name} has ${r.status?.ahead} commits to push`,
    detail: 'Ahead of its known upstream.',
  },
};

export function AttentionList({ items, limit = 6 }: { items: Attention[]; limit?: number }) {
  const openRepo = useOpenRepo();
  return (
    <ul className="border-t border-line">
      {items.slice(0, limit).map(({ repo, kind }) => {
        const entry = ATTENTION[kind];
        return (
          <li key={repo.id} className="flex items-center gap-3 border-b border-line py-2.5">
            <entry.icon aria-hidden className={`size-4 shrink-0 ${entry.tone}`} />
            <div className="min-w-0 flex-1">
              <div className="truncate text-[0.84375rem] font-medium text-ink">
                {entry.text(repo)}
              </div>
              <div className="truncate text-xs text-muted">{entry.detail}</div>
            </div>
            <Button size="sm" onClick={() => openRepo(repo.id)}>
              Open
            </Button>
          </li>
        );
      })}
    </ul>
  );
}

const ACTIVITY: Record<LocalActivity['type'], { icon: LucideIcon; label: string }> = {
  added: { icon: FolderPlus, label: 'Added to gitdesk' },
  created: { icon: FolderPlus, label: 'Created' },
  opened: { icon: FolderOpen, label: 'Opened' },
  commit: { icon: GitCommitHorizontal, label: 'New commit' },
};

export function ActivityList() {
  const activity = useRepositoryActivity();
  const { addRepository, adding } = useWorkspaceUi();
  if (activity.isPending) return null;
  if (!activity.data?.length)
    return (
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
        Opens and new commits on this computer show up here.
      </EmptyState>
    );
  return (
    <ul className="border-t border-line">
      {activity.data.slice(0, 6).map((item) => {
        const entry = ACTIVITY[item.type];
        return (
          <li key={item.id} className="flex gap-3 border-b border-line py-2.5">
            <entry.icon aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
            <div className="min-w-0">
              <div className="truncate text-[0.84375rem] font-medium text-ink">
                {item.repositoryName}
              </div>
              <div className="truncate text-xs text-muted" title={item.detail ?? undefined}>
                {entry.label}
                {item.detail ? `: ${item.detail}` : ''} · {relativeTime(item.at)}
              </div>
            </div>
          </li>
        );
      })}
    </ul>
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
  if (notice.kind === 'exists')
    return (
      <InlineStatus
        className="mb-6"
        action={
          <Button size="sm" variant="ghost" onClick={dismissNotice}>
            Dismiss
          </Button>
        }
      >
        {notice.name} was already in gitdesk.
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
      <span className="font-mono text-[0.8125rem]">{notice.displayPath}</span> isn't a
      Git repository.
      {initialize.isError && (
        <span className="mt-1 block text-danger">
          {ipcErrorMessage(initialize.error, "Couldn't initialize Git there.")}
        </span>
      )}
    </InlineStatus>
  );
}
