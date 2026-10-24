import {
  CircleX,
  CloudUpload,
  GitBranch,
  GitCommitHorizontal,
  GitMerge,
  GitPullRequest,
  MessageSquare,
  Pencil,
  RefreshCw,
  ShieldCheck,
  TriangleAlert,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import type {
  PullDetail,
  PullEvent,
  PullEventType,
} from '../../../shared/pulls';
import type { RepositorySummary } from '../../../shared/repos';
import { ActivityArt, CommitsArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { CopyButton } from '../../components/ui/copy-button';
import { EmptyState } from '../../components/ui/empty-state';
import { InlineStatus, Loading } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { usePullActivity } from '../../lib/pull-queries';
import { AuthorAvatar } from '../repository/author-avatar';
import { shortOid } from './pull-bits';

export function CommitsTab({
  detail,
  onShowFiles,
}: {
  detail: PullDetail;
  onShowFiles: () => void;
}) {
  const { comparison, pull } = detail;
  const reviewed = pull.review?.version;
  if (!comparison?.commits.length)
    return (
      <EmptyState
        art={<CommitsArt />}
        title="No commits to show"
        action={<Button onClick={onShowFiles}>Open Files changed</Button>}
      >
        {comparison
          ? 'The target already has every commit on this branch.'
          : 'Git could not compare the branches.'}
      </EmptyState>
    );
  return (
    <div className="pt-5">
      {detail.changedSinceReview && (
        <InlineStatus
          action={
            <Button size="sm" onClick={onShowFiles}>
              Open Files changed
            </Button>
          }
          className="mb-4"
        >
          <b className="font-semibold">
            New commits since your review of snapshot {reviewed}.
          </b>{' '}
          The approval is stale until you review again.
        </InlineStatus>
      )}
      <h2 className="flex items-baseline gap-3 text-[0.9375rem] font-semibold text-ink">
        Commits on{' '}
        <span className="font-mono text-[0.8125rem]">{pull.sourceRef}</span>{' '}
        that{' '}
        <span className="font-mono text-[0.8125rem]">{pull.targetRef}</span>{' '}
        does not have
        <span className="ml-auto text-xs font-normal text-muted">
          Oldest first
        </span>
      </h2>
      <ul className="mt-2 border-t border-line">
        {comparison.commits.map((commit) => (
          <li
            key={commit.oid}
            className="flex items-center gap-3 border-b border-line py-2.5"
          >
            <AuthorAvatar name={commit.author} email={commit.email} size="sm" />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[0.84375rem] font-medium text-ink">
                {commit.subject}
              </p>
              <p className="text-xs text-muted">
                {commit.author} · {relativeTime(commit.at)}
              </p>
            </div>
            <span className="font-mono text-[0.75rem] text-muted">
              {shortOid(commit.oid)}
            </span>
            <CopyButton value={commit.oid} label="commit hash" />
          </li>
        ))}
      </ul>
      {comparison.commitsTruncated && (
        <p className="mt-2 text-xs text-muted">
          Only the 250 newest commits are listed.
        </p>
      )}
      <p className="mt-3 text-xs text-muted">
        Author names come from each commit's Git settings, not from an account.
      </p>
    </div>
  );
}

const DECISION_WORDS: Record<string, string> = {
  approved: 'approved',
  changes_requested: 'requested changes on',
  commented: 'reviewed',
};

// Each event as one sentence, from the facts it carries.
function describe(event: PullEvent): {
  icon: LucideIcon;
  tone?: string;
  text: string;
} {
  const [a, b, c] = (event.detail ?? '').split(':');
  const name = event.actor.name;
  const words: Record<
    PullEventType,
    () => { icon: LucideIcon; tone?: string; text: string }
  > = {
    created: () => ({
      icon: GitPullRequest,
      tone: 'text-success',
      text: `${name} opened this pull request${event.detail ? ` (${event.detail})` : ''}`,
    }),
    edited: () => ({
      icon: Pencil,
      text: event.detail
        ? `${name} renamed it to "${event.detail}"`
        : `${name} edited the details`,
    }),
    closed: () => ({
      icon: CircleX,
      tone: 'text-danger',
      text: `${name} closed it without merging`,
    }),
    reopened: () => ({
      icon: GitPullRequest,
      tone: 'text-success',
      text: `${name} reopened it`,
    }),
    comparison_updated: () => ({
      icon: RefreshCw,
      text: `Comparison updated to snapshot ${a}: source ${shortOid(b ?? '')}, target ${shortOid(c ?? '')}`,
    }),
    mergeability_checked: () => ({
      icon: ShieldCheck,
      tone:
        b === 'conflicts'
          ? 'text-danger'
          : b === 'mergeable'
            ? 'text-success'
            : undefined,
      text:
        b === 'mergeable'
          ? `Checked snapshot ${a}: no conflicts`
          : b === 'conflicts'
            ? `Checked snapshot ${a}: conflicts in ${c} ${c === '1' ? 'file' : 'files'}`
            : `Checked snapshot ${a}: Git could not test the merge`,
    }),
    reviewed: () => ({
      icon:
        a === 'approved'
          ? ShieldCheck
          : a === 'changes_requested'
            ? TriangleAlert
            : MessageSquare,
      tone:
        a === 'approved'
          ? 'text-success'
          : a === 'changes_requested'
            ? 'text-warning'
            : undefined,
      text: `${name} ${DECISION_WORDS[a ?? ''] ?? 'reviewed'} snapshot ${b}`,
    }),
    commented: () => ({
      icon: MessageSquare,
      text: event.detail
        ? `${name} commented on ${event.detail.replace(/:(\d+)$/, ' line $1')}`
        : `${name} commented`,
    }),
    merge_started: () => ({
      icon: GitMerge,
      text: `${name} started merging${a === 'no-ff' ? ' with a merge commit' : ''}`,
    }),
    merge_conflicts: () => ({
      icon: CircleX,
      tone: 'text-danger',
      text: `Merge stopped on ${event.detail} ${event.detail === '1' ? 'conflict' : 'conflicts'}. Nothing was recorded as merged.`,
    }),
    merge_aborted: () => ({ icon: Undo2, text: `${name} aborted the merge` }),
    merge_failed: () => ({
      icon: CircleX,
      tone: 'text-danger',
      text: `The merge failed${event.detail ? `: ${event.detail}` : ''}`,
    }),
    merged: () => ({
      icon: GitMerge,
      text: `${name} merged it as ${shortOid(event.detail ?? '')}`,
    }),
    pushed: () => ({ icon: CloudUpload, text: `Pushed to ${event.detail}` }),
    reverted: () => ({
      icon: Undo2,
      text: `${name} reverted it in ${shortOid(event.detail ?? '')}`,
    }),
    branch_deleted: () => ({
      icon: GitBranch,
      text: `${name} deleted the branch ${event.detail}`,
    }),
  };
  return (
    words[event.type] ??
    (() => ({ icon: GitCommitHorizontal, text: event.type }))
  )();
}

export function ActivityTab({
  repo,
  detail,
}: {
  repo: RepositorySummary;
  detail: PullDetail;
}) {
  const activity = usePullActivity(repo.id, detail.pull.id);
  const events = activity.data?.pages.flatMap((page) => page.events) ?? [];
  if (activity.isPending) return <Loading label="Loading activity…" />;
  if (activity.isError)
    return (
      <EmptyState
        art={<ActivityArt />}
        title="Couldn't load the activity"
        action={
          <Button
            pending={activity.isFetching}
            onClick={() => void activity.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(activity.error, 'The activity did not load.')}
      </EmptyState>
    );
  if (!events.length)
    return (
      <EmptyState
        art={<ActivityArt />}
        title="Nothing recorded yet"
        action={
          <Button
            pending={activity.isFetching}
            onClick={() => void activity.refetch()}
          >
            Refresh
          </Button>
        }
      >
        Reviews, checks, merges and comments show here as they happen.
      </EmptyState>
    );
  return (
    <section aria-labelledby="pr-activity" className="pt-5">
      <h2
        id="pr-activity"
        className="flex items-baseline text-[0.9375rem] font-semibold text-ink"
      >
        What happened, newest first
        <span className="ml-auto text-xs font-normal text-muted">
          {detail.pull.store === 'local'
            ? 'On this computer'
            : 'From your account'}
        </span>
      </h2>
      <ol className="mt-2 border-t border-line">
        {events.map((event) => {
          const { icon: Icon, tone, text } = describe(event);
          return (
            <li
              key={event.id}
              className="flex items-start gap-3 border-b border-line py-2.5 text-[0.8125rem]"
            >
              <Icon
                aria-hidden
                className={cn('mt-0.5 size-4 shrink-0 text-muted', tone)}
              />
              <span className="min-w-0 flex-1 text-ink [overflow-wrap:anywhere]">
                {text}
              </span>
              <span className="shrink-0 text-xs text-muted">
                {relativeTime(event.createdAt)}
              </span>
            </li>
          );
        })}
      </ol>
      {activity.hasNextPage && (
        <Button
          size="sm"
          className="mt-3"
          pending={activity.isFetchingNextPage}
          onClick={() => void activity.fetchNextPage()}
        >
          Load 30 more
        </Button>
      )}
    </section>
  );
}
