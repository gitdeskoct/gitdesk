import { useState } from 'react';
import {
  PULL_STAT_RANGES,
  type PullStatRange,
  type PullStats,
} from '../../../shared/pulls';
import type { RepositorySummary } from '../../../shared/repos';
import { PullRequestsArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { Segmented } from '../../components/ui/segmented';
import { InlineStatus, Loading } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { usePullStats } from '../../lib/pull-queries';
import { useAuthStatus } from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { Axis, Bar, ChartTable, scaleTop } from '../repository/analytics';
import { Section, SummaryStrip } from '../repository/history';

const RANGE_WORDS: Record<PullStatRange, string> = {
  '3m': '3 months',
  '6m': '6 months',
  '1y': '1 year',
};

const monthName = (month: string, long = false) => {
  const [year, m] = month.split('-').map(Number);
  return new Intl.DateTimeFormat(
    undefined,
    long ? { month: 'long', year: 'numeric' } : { month: 'short' },
  ).format(new Date(year!, m! - 1, 1));
};

export function duration(ms: number | null): string {
  if (ms === null) return 'None yet';
  const hours = ms / 3_600_000;
  if (hours < 1) return `${Math.max(1, Math.round(ms / 60_000))} min`;
  if (hours < 48)
    return `${hours.toFixed(hours < 10 ? 1 : 0).replace(/\.0$/, '')} hours`;
  return `${(hours / 24).toFixed(1).replace(/\.0$/, '')} days`;
}

function MonthsChart({ stats }: { stats: PullStats }) {
  const top = scaleTop(
    Math.max(...stats.months.flatMap((m) => [m.opened, m.merged]), 0),
  );
  const busiest = [...stats.months].sort((a, b) => b.opened - a.opened)[0];
  const opened = stats.months.reduce((sum, m) => sum + m.opened, 0);
  const merged = stats.months.reduce((sum, m) => sum + m.merged, 0);
  return (
    <figure className="m-0 min-w-0">
      <h3 className="text-[0.875rem] font-semibold text-ink">
        How many pull requests were opened and merged each month?
      </h3>
      <div className="mt-1.5 mb-3 flex gap-4 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="size-2.5 rounded-[2px] bg-chart-1" />
          Opened
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="size-2.5 rounded-[2px] bg-chart-2" />
          Merged
        </span>
      </div>
      <div className="grid h-40 grid-cols-[2rem_minmax(0,1fr)] gap-2">
        <Axis labels={[String(top), String(top / 2), '0']} />
        <div
          className="grid h-full items-end gap-3 border-b border-line-strong"
          style={{
            gridTemplateColumns: `repeat(${stats.months.length}, minmax(0, 1fr))`,
          }}
        >
          {stats.months.map((m) => (
            <div
              key={m.month}
              className="flex h-full items-end justify-center gap-1"
            >
              <Bar
                label={`${monthName(m.month, true)}: ${m.opened} opened`}
                height={(m.opened / top) * 100}
                className="bg-chart-1"
                top
              />
              <Bar
                label={`${monthName(m.month, true)}: ${m.merged} merged`}
                height={(m.merged / top) * 100}
                className="bg-chart-2"
                top
              />
            </div>
          ))}
        </div>
      </div>
      <div
        className="mt-1.5 ml-10 grid gap-3 text-center text-[0.71875rem] text-muted"
        style={{
          gridTemplateColumns: `repeat(${stats.months.length}, minmax(0, 1fr))`,
        }}
      >
        {stats.months.map((m, i) => (
          <span
            key={m.month}
            className={cn(
              'truncate',
              stats.months.length > 6 &&
                i % 2 === 1 &&
                'invisible @min-[720px]:visible',
            )}
          >
            {monthName(m.month)}
          </span>
        ))}
      </div>
      <figcaption className="mt-2.5 text-[0.8125rem] text-muted">
        {opened || merged
          ? `${opened} opened and ${merged} merged.${busiest && busiest.opened ? ` ${monthName(busiest.month, true)} had the most new ones.` : ''}`
          : 'None opened or merged in this range.'}{' '}
        {stats.store === 'account'
          ? 'Months are UTC, counted by your account.'
          : 'Months are local time, counted on this computer.'}
      </figcaption>
    </figure>
  );
}

function StatesChart({ stats }: { stats: PullStats }) {
  const total = stats.counts.open + stats.counts.merged + stats.counts.closed;
  const rows = [
    ['Open', stats.counts.open],
    ['Merged', stats.counts.merged],
    ['Closed', stats.counts.closed],
  ] as const;
  const top = Math.max(...rows.map(([, n]) => n), 1);
  return (
    <figure className="m-0 min-w-0">
      <h3 className="text-[0.875rem] font-semibold text-ink">
        Where do the pull requests stand now?
      </h3>
      <div className="mt-3 grid gap-2">
        {rows.map(([label, n]) => (
          <div
            key={label}
            className="grid grid-cols-[4.5rem_minmax(0,1fr)_2.5rem] items-center gap-2.5 text-[0.8125rem]"
          >
            <span className="text-ink">{label}</span>
            <span className="h-3.5 rounded-[4px] bg-control">
              <span
                className="block h-full rounded-[4px] bg-chart-1"
                style={{ width: `${(n / top) * 100}%` }}
              />
            </span>
            <span className="text-right text-ink tabular-nums">{n}</span>
          </div>
        ))}
      </div>
      <figcaption className="mt-2.5 text-[0.8125rem] text-muted">
        {total
          ? `${stats.counts.merged} of ${total} were merged.`
          : 'No pull requests yet.'}
      </figcaption>
    </figure>
  );
}

// Only what the records hold: counts, months and time to merge. Nothing scores the work.
export function PullAnalytics({ repo }: { repo: RepositorySummary }) {
  const { navigate } = useNavigation();
  const { data: auth } = useAuthStatus();
  const [range, setRange] = useState<PullStatRange>('6m');
  const [tables, setTables] = useState(false);
  const usable = !repo.remoteId || auth?.status === 'authenticated';
  const stats = usePullStats(repo.id, range, usable);

  let body;
  if (!usable)
    body = (
      <InlineStatus>
        This repository's pull requests are in your account. Sign in to see
        their numbers.
      </InlineStatus>
    );
  else if (stats.isPending) body = <Loading label="Counting pull requests…" />;
  else if (stats.isError)
    body = (
      <InlineStatus
        tone="danger"
        action={
          <Button
            size="sm"
            pending={stats.isFetching}
            onClick={() => void stats.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(stats.error, "The numbers didn't load.")}
      </InlineStatus>
    );
  else if (
    stats.data.counts.open +
      stats.data.counts.merged +
      stats.data.counts.closed ===
    0
  )
    body = (
      <EmptyState
        compact
        className="border-t border-line"
        art={<PullRequestsArt />}
        title="No pull requests yet"
        action={
          <Button
            size="sm"
            onClick={() =>
              navigate({ name: 'repository', id: repo.id, tab: 'pulls' })
            }
          >
            Open Pull requests
          </Button>
        }
      >
        Their monthly numbers and time to merge show here once there are some.
      </EmptyState>
    );
  else {
    const s = stats.data;
    body = (
      <div className={cn('@container', stats.isFetching && 'opacity-70')}>
        <SummaryStrip
          cells={[
            {
              label: 'Open',
              value: String(s.counts.open),
              context: 'Waiting to be merged or closed',
            },
            {
              label: 'Merged',
              value: String(s.counts.merged),
              context: 'All time',
            },
            {
              label: 'Median time to merge',
              value: duration(s.medianMergeMs),
              context: `Over ${s.merges} ${s.merges === 1 ? 'merge' : 'merges'} in ${RANGE_WORDS[range]}`,
              word: s.medianMergeMs === null,
            },
            {
              label: 'Open with conflicts',
              value: String(s.openWithConflicts),
              context: 'At their last check',
            },
            {
              label: 'Closed',
              value: String(s.counts.closed),
              context: 'Without merging',
            },
          ]}
        />
        <div className="mt-6 grid gap-x-9 gap-y-8 @min-[760px]:grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)]">
          <MonthsChart stats={s} />
          <StatesChart stats={s} />
        </div>
        {tables && (
          <ChartTable
            caption="Pull requests opened and merged per month"
            head={['Month', 'Opened', 'Merged']}
            rows={s.months.map((m) => [
              monthName(m.month, true),
              m.opened,
              m.merged,
            ])}
          />
        )}
        <p className="mt-3 text-xs text-muted">
          Time to merge runs from opening to the merge on this computer; open
          and closed pull requests are left out.
        </p>
      </div>
    );
  }

  return (
    <Section
      id="pull-analytics"
      title="Pull requests"
      meta={repo.remoteId ? 'From your account' : 'On this computer'}
    >
      <div className="mb-3 flex flex-wrap items-center gap-2.5">
        <Segmented
          label="Range"
          value={range}
          onChange={setRange}
          options={PULL_STAT_RANGES.map((value) => ({
            value,
            label: RANGE_WORDS[value],
          }))}
        />
        <Button
          size="sm"
          variant={tables ? 'secondary' : 'ghost'}
          aria-pressed={tables}
          onClick={() => setTables((t) => !t)}
        >
          Show as tables
        </Button>
      </div>
      {body}
    </Section>
  );
}
