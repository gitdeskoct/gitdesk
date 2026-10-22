import { Cloud, HardDrive, Link, Lock } from 'lucide-react';
import type { ReactNode } from 'react';
import type {
  RemoteRepository,
  RepositoryHistory,
  RepositorySummary,
} from '../../../shared/repos';
import { CommitsArt } from '../../components/illustrations';
import { EmptyState } from '../../components/ui/empty-state';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { changeCount } from '../../lib/repo-status';
import { AuthorAvatar } from './author-avatar';

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

const tagClass =
  'inline-flex h-5 items-center gap-1 rounded-[4px] border border-line bg-sunken px-1.5 text-[0.71875rem] font-medium text-ink [&_svg]:size-3 [&_svg]:text-muted';

// Where a repository lives, as words: the same vocabulary as the list's filters.
export function RepoTags({
  local,
  remote,
  compact = false,
}: {
  local: boolean;
  remote: boolean;
  // Rows show one word (Local, Linked or Remote only); every remote is private, so that is left out.
  compact?: boolean;
}) {
  return (
    <span className="inline-flex shrink-0 flex-wrap gap-1.5">
      {local && (!compact || !remote) && (
        <span className={tagClass}>
          <HardDrive aria-hidden />
          Local
        </span>
      )}
      {local && remote && (
        <span className={tagClass}>
          <Link aria-hidden />
          Linked
        </span>
      )}
      {!local && remote && (
        <span className={tagClass}>
          <Cloud aria-hidden />
          Remote only
        </span>
      )}
      {remote && !compact && (
        <span className={tagClass}>
          <Lock aria-hidden />
          Private
        </span>
      )}
    </span>
  );
}

export type SummaryCell = {
  label: string;
  value: string;
  context: ReactNode;
  // A word instead of a number (Not connected): smaller and muted, so it never reads as a count.
  word?: boolean;
};

// The same hairline strip as Home's statistics, but read-only: these numbers describe one
// repository and have nowhere further to go.
export function SummaryStrip({ cells }: { cells: SummaryCell[] }) {
  return (
    <div
      role="group"
      aria-label="Repository summary"
      className="grid grid-cols-2 border-y border-line @min-[720px]:grid-cols-5"
    >
      {cells.map((cell, index) => (
        <div
          key={cell.label}
          className={cn(
            'grid min-w-0 content-start gap-1 border-line py-4 pr-4',
            index % 2 === 1 && 'border-l pl-5',
            index > 1 && 'border-t @min-[720px]:border-t-0',
            index > 0 && '@min-[720px]:border-l @min-[720px]:pl-5',
          )}
        >
          <span
            className={cn(
              'block truncate',
              cell.word
                ? 'text-[0.9375rem] leading-9 font-medium text-muted'
                : 'text-[1.875rem] leading-9 font-semibold tracking-[-0.02em] text-ink',
            )}
          >
            {cell.value}
          </span>
          <span className="text-[0.8125rem] font-medium text-ink">
            {cell.label}
          </span>
          <span className="truncate text-xs text-muted">{cell.context}</span>
        </div>
      ))}
    </div>
  );
}

// Each number comes from Git on this computer. Ahead and behind compare with the last fetched
// upstream, so they say "not connected" rather than zero when there is nothing to compare with.
export function localSummary(
  repo: RepositorySummary,
  history: RepositoryHistory,
): SummaryCell[] {
  const status = repo.status;
  const changes = changeCount(status);
  const parts = status
    ? [
        status.staged && `${status.staged} staged`,
        status.unstaged && `${status.unstaged} modified`,
        status.untracked && `${status.untracked} untracked`,
      ].filter(Boolean)
    : [];
  const compared =
    status?.upstream && status.ahead !== null && status.behind !== null;
  return [
    {
      label: 'Commits',
      value: String(history.commitCount),
      context: history.branch
        ? `Reachable from ${history.branch}`
        : 'From HEAD',
    },
    {
      label: 'Branches',
      value: String(history.localBranches),
      context: 'On this computer',
    },
    {
      label: 'Remote branches',
      value: String(history.remoteBranches),
      context: status?.hasRemotes ? 'From the last fetch' : 'No Git remote set',
    },
    {
      label: 'Changes',
      value: status ? String(changes) : 'Not checked',
      word: !status,
      context: parts.length ? parts.join(', ') : 'Working tree clean',
    },
    compared
      ? {
          label: 'Ahead / behind',
          value: `${status.ahead} / ${status.behind}`,
          context: `Against ${status.upstream}, as of the last fetch`,
        }
      : {
          label: 'Ahead / behind',
          value: 'Not connected',
          word: true,
          context: status?.upstream
            ? 'Upstream not fetched yet'
            : 'This branch tracks no upstream',
        },
  ];
}

const weekLabel = new Intl.DateTimeFormat(undefined, {
  month: 'short',
  day: 'numeric',
});

// Bars are buttons so each week can be reached with the keyboard and read aloud; the table below
// carries the same numbers for screen readers that skip charts.
export function CommitActivity({
  history,
  action,
}: {
  history: RepositoryHistory;
  action: ReactNode;
}) {
  const { weeks } = history;
  if (history.commitCount === 0)
    return (
      <EmptyState
        compact
        art={<CommitsArt />}
        title={`No commits on ${history.branch ?? 'this branch'} yet`}
        className="border-t border-line"
        action={action}
      >
        The weekly chart and recent commits fill in after the first commit.
      </EmptyState>
    );
  const total = weeks.reduce((sum, week) => sum + week.commits, 0);
  const max = Math.max(
    4,
    Math.ceil(Math.max(...weeks.map((w) => w.commits)) / 4) * 4,
  );
  const ticks = [max, max / 2, 0];
  const current = weeks.at(-1)!;
  const atLeast = history.weeksTruncated ? 'At least ' : '';
  const describe = (week: (typeof weeks)[number], index: number) =>
    `Week of ${weekLabel.format(week.start)}${index === weeks.length - 1 ? ', so far' : ''}: ${plural(week.commits, 'commit', 'commits')}`;

  return (
    <figure className="m-0 border-t border-line pt-4">
      <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-x-2">
        <div
          aria-hidden
          className="relative h-40 text-right text-[0.6875rem] text-muted"
        >
          {ticks.map((tick) => (
            <span
              key={tick}
              className="absolute right-0 -translate-y-1/2"
              style={{ top: `${100 - (tick / max) * 100}%` }}
            >
              {tick}
            </span>
          ))}
        </div>
        <div className="relative h-40">
          {ticks.map((tick) => (
            <div
              key={tick}
              aria-hidden
              className="absolute inset-x-0 border-t border-line"
              style={{ top: `${100 - (tick / max) * 100}%` }}
            />
          ))}
          <div
            role="group"
            aria-label={`Commits per week on ${history.branch ?? 'this branch'}`}
            className="relative flex h-full items-end gap-1.5 @min-[560px]:gap-3"
          >
            {weeks.map((week, index) => (
              <Tooltip
                key={week.start}
                label={describe(week, index)}
                side="top"
              >
                <button
                  type="button"
                  aria-label={describe(week, index)}
                  className="group flex h-full min-w-0 flex-1 cursor-default items-end rounded-[4px] focus-visible:outline-offset-1"
                >
                  <span
                    className={cn(
                      'block w-full rounded-t-[4px] transition-colors',
                      week.commits
                        ? 'bg-accent group-hover:bg-accent-hover'
                        : 'h-px bg-line-strong',
                    )}
                    style={
                      week.commits
                        ? { height: `${(week.commits / max) * 100}%` }
                        : undefined
                    }
                  />
                </button>
              </Tooltip>
            ))}
          </div>
        </div>
        <div />
        <div
          aria-hidden
          className="mt-1.5 flex gap-1.5 text-center text-[0.6875rem] text-muted @min-[560px]:gap-3"
        >
          {weeks.map((week, index) => (
            <span
              key={week.start}
              className={cn(
                'min-w-0 flex-1 truncate',
                index % 2 === 1 && 'invisible @min-[720px]:visible',
              )}
            >
              {weekLabel.format(week.start)}
            </span>
          ))}
        </div>
      </div>
      <figcaption className="mt-3 text-[0.8125rem] text-muted">
        {total
          ? `${atLeast}${plural(total, 'commit', 'commits')} in ${weeks.length} weeks, about ${Math.round(total / weeks.length)} a week. This week so far: ${current.commits}.`
          : `No commits on ${history.branch ?? 'this branch'} in the last ${weeks.length} weeks.`}
      </figcaption>
      <table className="sr-only">
        <caption>Commits per week by commit date</caption>
        <thead>
          <tr>
            <th scope="col">Week of</th>
            <th scope="col">Commits</th>
          </tr>
        </thead>
        <tbody>
          {weeks.map((week) => (
            <tr key={week.start}>
              <td>{weekLabel.format(week.start)}</td>
              <td>{week.commits}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </figure>
  );
}

export function RecentCommits({
  commits,
  limit,
}: {
  commits: RepositoryHistory['recent'];
  limit?: number;
}) {
  return (
    <ul className="border-t border-line">
      {commits.slice(0, limit).map((commit) => (
        <li
          key={commit.oid}
          className="flex items-center gap-3 border-b border-line py-2.5"
        >
          <AuthorAvatar name={commit.author} email={commit.email} />
          <div className="min-w-0 flex-1">
            <div
              className="truncate text-[0.84375rem] font-medium text-ink"
              title={commit.subject}
            >
              {commit.subject || '(no message)'}
            </div>
            <div className="truncate text-xs text-muted">
              {commit.author || 'Unknown author'} · {relativeTime(commit.at)}
            </div>
          </div>
          <span className="shrink-0 font-mono text-[0.75rem] text-muted">
            {commit.oid.slice(0, 7)}
          </span>
        </li>
      ))}
    </ul>
  );
}

// The server's lifecycle word for a remote, icon colored, word in ink.
export const REMOTE_STATUS: Record<
  RemoteRepository['status'],
  { label: string; detail: string }
> = {
  ready: { label: 'Ready', detail: 'Storage is set up.' },
  provisioning: {
    label: 'Setting up',
    detail: "Storage setup started and hasn't finished.",
  },
  failed: {
    label: 'Setup failed',
    detail:
      "The repository exists in your account, but its storage isn't ready. Nothing was lost.",
  },
  deleting: {
    label: "Deletion didn't finish",
    detail:
      'Some stored data is still in your account. Delete it again to finish.',
  },
};

export const Section = ({
  id,
  title,
  meta,
  children,
  className,
}: {
  id: string;
  title: string;
  meta?: string;
  children: ReactNode;
  className?: string;
}) => (
  <section aria-labelledby={id} className={cn('mt-10 min-w-0', className)}>
    <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3 gap-y-0.5">
      <h2 id={id} className="text-[0.9375rem] font-semibold text-ink">
        {title}
      </h2>
      {meta && <span className="text-xs text-muted">{meta}</span>}
    </div>
    {children}
  </section>
);
