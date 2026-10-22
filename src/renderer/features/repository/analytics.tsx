import { useState, type ReactNode } from 'react';
import type { RepositorySummary } from '../../../shared/repos';
import type {
  AnalyticsRange,
  RepositoryAnalytics,
} from '../../../shared/workspace';
import { CommitsArt, OfflineArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { Segmented } from '../../components/ui/segmented';
import { InlineStatus, Loading } from '../../components/ui/status';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/cn';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useAnalytics } from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { AuthorAvatar } from './author-avatar';
import { Section, SummaryStrip } from './history';

const RANGES: { value: AnalyticsRange; label: string }[] = [
  { value: '4w', label: '4 weeks' },
  { value: '12w', label: '12 weeks' },
  { value: '6m', label: '6 months' },
  { value: '1y', label: '1 year' },
];
const DAYS = ['Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat', 'Sun'];

export const compact = (value: number): string =>
  Math.abs(value) >= 1000
    ? `${(value / 1000).toFixed(Math.abs(value) >= 10_000 ? 0 : 1).replace(/\.0$/, '')}K`
    : String(value);

const bucketLabel = (start: number, bucket: 'week' | 'month') =>
  new Intl.DateTimeFormat(
    undefined,
    bucket === 'week' ? { day: 'numeric', month: 'short' } : { month: 'short' },
  ).format(start);
const bucketName = (start: number, bucket: 'week' | 'month') =>
  bucket === 'week'
    ? `Week of ${new Intl.DateTimeFormat(undefined, { day: 'numeric', month: 'long' }).format(start)}`
    : new Intl.DateTimeFormat(undefined, {
        month: 'long',
        year: 'numeric',
      }).format(start);

// A clean scale top: a round number at or above the largest value, never below 4.
export function scaleTop(max: number): number {
  if (max <= 4) return 4;
  const step = 10 ** Math.floor(Math.log10(max));
  return Math.ceil(max / (step / 2)) * (step / 2);
}

export function ChartTable({
  caption,
  head,
  rows,
}: {
  caption: string;
  head: string[];
  rows: (string | number)[][];
}) {
  return (
    <table className="mt-3 w-full border-t border-line text-[0.8125rem]">
      <caption className="sr-only">{caption}</caption>
      <thead>
        <tr>
          {head.map((cell) => (
            <th
              key={cell}
              scope="col"
              className="py-1.5 pr-4 text-left font-medium text-muted"
            >
              {cell}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, i) => (
          <tr key={i} className="border-t border-line">
            {row.map((cell, j) => (
              <td key={j} className="py-1.5 pr-4 text-ink tabular-nums">
                {cell}
              </td>
            ))}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function Bar({
  label,
  height,
  className,
  top,
}: {
  label: string;
  height: number;
  className: string;
  top: boolean;
}) {
  return (
    <Tooltip label={label} side="top">
      <button
        type="button"
        aria-label={label}
        className="group flex h-full w-full cursor-default justify-center focus-visible:outline-offset-0"
        style={{ alignItems: top ? 'flex-end' : 'flex-start' }}
      >
        <span
          className={cn(
            'block w-full max-w-5 transition-colors',
            height > 0 ? className : 'bg-line-strong',
            top ? 'rounded-t-[4px]' : 'rounded-b-[4px]',
          )}
          style={{ height: height > 0 ? `${Math.max(2, height)}%` : '1px' }}
        />
      </button>
    </Tooltip>
  );
}

export function Axis({ labels }: { labels: string[] }) {
  return (
    <div className="flex flex-col justify-between text-right text-xs text-muted tabular-nums">
      {labels.map((label, i) => (
        <span key={i}>{label}</span>
      ))}
    </div>
  );
}

function XLabels({ data }: { data: RepositoryAnalytics }) {
  return (
    <div
      className="mt-1.5 grid gap-1 text-center text-[0.71875rem] text-muted"
      style={{
        gridTemplateColumns: `repeat(${data.buckets.length}, minmax(0, 1fr))`,
      }}
    >
      {data.buckets.map((b, i) => (
        <span
          key={b.start}
          className={cn(
            'truncate',
            data.buckets.length > 6 &&
              i % 2 === 1 &&
              'invisible @min-[720px]:visible',
          )}
        >
          {bucketLabel(b.start, data.bucket)}
        </span>
      ))}
    </div>
  );
}

function CommitsChart({
  data,
  tables,
}: {
  data: RepositoryAnalytics;
  tables: boolean;
}) {
  const top = scaleTop(Math.max(...data.buckets.map((b) => b.commits)));
  const busiest = data.buckets.reduce((a, b) =>
    b.commits > a.commits ? b : a,
  );
  const quiet = data.buckets.filter((b) => b.commits === 0).length;
  return (
    <figure className="m-0 border-t border-line pt-4">
      <div className="grid h-44 grid-cols-[2rem_minmax(0,1fr)] gap-2">
        <Axis labels={[String(top), String(top / 2), '0']} />
        <div className="relative border-b border-line-strong">
          <span
            aria-hidden
            className="absolute inset-x-0 top-1/2 h-px bg-line"
          />
          <div
            className="relative grid h-full gap-1"
            style={{
              gridTemplateColumns: `repeat(${data.buckets.length}, minmax(0, 1fr))`,
            }}
          >
            {data.buckets.map((b) => (
              <Bar
                key={b.start}
                top
                className="bg-chart-1 group-hover:opacity-85"
                height={(b.commits / top) * 100}
                label={`${bucketName(b.start, data.bucket)}: ${b.commits} ${b.commits === 1 ? 'commit' : 'commits'}`}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-[2rem_minmax(0,1fr)] gap-2">
        <span />
        <XLabels data={data} />
      </div>
      <figcaption className="mt-2.5 text-[0.8125rem] text-muted">
        {busiest.commits
          ? `Busiest: ${busiest.commits} ${busiest.commits === 1 ? 'commit' : 'commits'}, ${bucketName(busiest.start, data.bucket).toLowerCase()}.`
          : 'No commits in this range.'}
        {quiet > 0 && busiest.commits > 0 ? ` ${quiet} with none.` : ''}
      </figcaption>
      {tables && (
        <ChartTable
          caption="Commits per period"
          head={['Period', 'Commits']}
          rows={data.buckets.map((b) => [
            bucketName(b.start, data.bucket),
            b.commits,
          ])}
        />
      )}
    </figure>
  );
}

function ChurnChart({
  data,
  tables,
}: {
  data: RepositoryAnalytics;
  tables: boolean;
}) {
  const top = scaleTop(
    Math.max(1, ...data.buckets.map((b) => Math.max(b.added, b.removed))),
  );
  const biggest = data.buckets.reduce((a, b) =>
    b.added + b.removed > a.added + a.removed ? b : a,
  );
  const columns = {
    gridTemplateColumns: `repeat(${data.buckets.length}, minmax(0, 1fr))`,
  };
  return (
    <figure className="m-0 border-t border-line pt-4">
      <div className="grid h-44 grid-cols-[2.5rem_minmax(0,1fr)] gap-2">
        <Axis labels={[compact(top), '0', compact(top)]} />
        <div className="grid grid-rows-2">
          <div
            className="grid gap-1 border-b border-line-strong"
            style={columns}
          >
            {data.buckets.map((b) => (
              <Bar
                key={b.start}
                top
                className="bg-chart-1"
                height={(b.added / top) * 100}
                label={`${bucketName(b.start, data.bucket)}: ${b.added.toLocaleString()} lines added`}
              />
            ))}
          </div>
          <div className="grid gap-1 pt-0.5" style={columns}>
            {data.buckets.map((b) => (
              <Bar
                key={b.start}
                top={false}
                className="bg-chart-2"
                height={(b.removed / top) * 100}
                label={`${bucketName(b.start, data.bucket)}: ${b.removed.toLocaleString()} lines removed`}
              />
            ))}
          </div>
        </div>
      </div>
      <div className="grid grid-cols-[2.5rem_minmax(0,1fr)] gap-2">
        <span />
        <XLabels data={data} />
      </div>
      <figcaption className="mt-2.5 text-[0.8125rem] text-muted">
        {biggest.added + biggest.removed
          ? `Biggest: +${biggest.added.toLocaleString()} −${biggest.removed.toLocaleString()} lines, ${bucketName(biggest.start, data.bucket).toLowerCase()}.`
          : 'No text lines changed in this range.'}
        {data.skippedLarge.length > 0 &&
          ` ${data.skippedLarge.length} very large ${data.skippedLarge.length === 1 ? 'change is' : 'changes are'} left out, such as ${data.skippedLarge[0]}.`}
      </figcaption>
      {tables && (
        <ChartTable
          caption="Lines added and removed per period"
          head={['Period', 'Added', 'Removed']}
          rows={data.buckets.map((b) => [
            bucketName(b.start, data.bucket),
            b.added,
            b.removed,
          ])}
        />
      )}
    </figure>
  );
}

const HEAT = [
  'bg-(--heat-0)',
  'bg-(--heat-1)',
  'bg-(--heat-2)',
  'bg-(--heat-3)',
  'bg-(--heat-4)',
  'bg-(--heat-5)',
];

function Heatmap({
  data,
  tables,
}: {
  data: RepositoryAnalytics;
  tables: boolean;
}) {
  const max = Math.max(1, ...data.heat.flat());
  const level = (count: number) =>
    count === 0 ? 0 : Math.min(5, Math.ceil((count / max) * 5));
  let peak = { day: 0, hour: 0, count: 0 };
  data.heat.forEach((hours, day) =>
    hours.forEach((count, hour) => {
      if (count > peak.count) peak = { day, hour, count };
    }),
  );
  const weekdays = data.heat
    .slice(0, 5)
    .flat()
    .reduce((a, b) => a + b, 0);
  return (
    <figure className="m-0 border-t border-line pt-4">
      <div
        className="grid max-w-[44rem] grid-cols-[2.5rem_repeat(24,minmax(0,1fr))] gap-0.5 text-[0.71875rem] text-muted"
        aria-hidden
      >
        {data.heat.map((hours, day) => (
          <div key={day} className="contents">
            <span className="self-center">{DAYS[day]}</span>
            {hours.map((count, hour) => (
              <span
                key={hour}
                title={`${DAYS[day]} ${String(hour).padStart(2, '0')}:00: ${count} ${count === 1 ? 'commit' : 'commits'}`}
                className={cn(
                  'aspect-square rounded-[3px]',
                  HEAT[level(count)],
                  count === 0 && 'shadow-[inset_0_0_0_1px_var(--line)]',
                )}
              />
            ))}
          </div>
        ))}
        <span />
        {Array.from({ length: 24 }, (_, hour) => (
          <span key={hour} className="text-center">
            {hour % 6 === 0 ? hour : ''}
          </span>
        ))}
      </div>
      <figcaption className="mt-2.5 text-[0.8125rem] text-muted">
        {peak.count
          ? `Most commits land on ${DAYS[peak.day]} around ${String(peak.hour).padStart(2, '0')}:00. ${Math.round((weekdays / Math.max(1, data.commits)) * 100)}% fall on weekdays.`
          : 'No commits in this range.'}
      </figcaption>
      {tables && (
        <ChartTable
          caption="Commits by weekday and hour"
          head={['Day', '00 to 05', '06 to 11', '12 to 17', '18 to 23']}
          rows={data.heat.map((hours, day) => [
            DAYS[day]!,
            ...[0, 6, 12, 18].map((h) =>
              hours.slice(h, h + 6).reduce((a, b) => a + b, 0),
            ),
          ])}
        />
      )}
    </figure>
  );
}

function TopList({
  items,
  label,
  mono,
}: {
  items: { name: string; count: number; email?: string }[];
  label: (count: number) => string;
  mono?: boolean;
}) {
  const max = Math.max(1, ...items.map((i) => i.count));
  return (
    <ol className="border-t border-line">
      {items.map((item) => (
        <li
          key={item.email ?? item.name}
          className="grid h-9 grid-cols-[minmax(0,1.3fr)_minmax(0,1fr)_2.5rem] items-center gap-3 border-b border-line"
        >
          <span
            className={cn(
              'flex min-w-0 items-center gap-2 text-ink',
              mono ? 'font-mono text-[0.78125rem]' : 'text-[0.8125rem]',
            )}
            title={item.name}
          >
            {item.email !== undefined && (
              <AuthorAvatar name={item.name} email={item.email} size="sm" />
            )}
            <span className="truncate">{item.name || 'Unknown'}</span>
          </span>
          <span
            aria-hidden
            className="block h-2.5 rounded-r-[4px] bg-chart-1"
            style={{ width: `${(item.count / max) * 100}%` }}
          />
          <span className="text-right text-xs text-ink tabular-nums">
            {item.count}
            <span className="sr-only"> {label(item.count)}</span>
          </span>
        </li>
      ))}
    </ol>
  );
}

// Charts built from local history only; nothing here asks the server. Each one is titled with the
// question it answers, has a sentence that answers it, and a table with the same numbers.
export function Analytics({ repo }: { repo: RepositorySummary }) {
  const { navigate } = useNavigation();
  const [range, setRange] = useState<AnalyticsRange>('12w');
  const [tables, setTables] = useState(false);
  const [moreFiles, setMoreFiles] = useState(false);
  const head = repo.status?.headOid ?? null;
  const analytics = useAnalytics(
    repo.id,
    head,
    range,
    repo.availability === 'available',
  );

  let body: ReactNode;
  if (analytics.isPending) body = <Loading label="Reading local history…" />;
  else if (analytics.isError)
    body = (
      <EmptyState
        compact
        art={<OfflineArt />}
        title="Couldn't read the history"
        action={
          <Button
            size="sm"
            pending={analytics.isFetching}
            onClick={() => void analytics.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(analytics.error, 'Git did not answer.')}
      </EmptyState>
    );
  else if (!analytics.data.headOid)
    body = (
      <EmptyState
        compact
        art={<CommitsArt />}
        title="No commits yet"
        action={
          <Button
            size="sm"
            onClick={() =>
              navigate({ name: 'repository', id: repo.id, tab: 'changes' })
            }
          >
            Go to Changes
          </Button>
        }
      >
        These charts fill in once this branch has commits.
      </EmptyState>
    );
  else {
    const data = analytics.data;
    const branch = data.branch ?? 'this branch';
    body = (
      <>
        <SummaryStrip
          cells={[
            {
              label: 'Commits',
              value: compact(data.commits),
              context: `${data.totalCommits.toLocaleString()} on ${branch} in total`,
            },
            {
              label: 'Days with commits',
              value: String(data.activeDays),
              context: `In this range`,
            },
            {
              label: 'Lines added',
              value: `+${compact(data.added)}`,
              context: 'Text files only',
            },
            {
              label: 'Lines removed',
              value: `−${compact(data.removed)}`,
              context: 'Text files only',
            },
            {
              label: 'Files touched',
              value: compact(data.filesTouched),
              context: 'Renames followed',
            },
          ]}
        />
        {data.truncated && (
          <InlineStatus className="mt-3">
            This range holds more than 5,000 commits, so every count is a lower
            bound.
          </InlineStatus>
        )}
        <div className="grid gap-x-9 @min-[900px]:grid-cols-2">
          <Section
            id="chart-commits"
            title={`How often was ${branch} committed to?`}
            meta={`Commits per ${data.bucket}`}
          >
            <CommitsChart data={data} tables={tables} />
          </Section>
          <Section
            id="chart-churn"
            title="How much code changed?"
            meta={`Lines added above the line, removed below, per ${data.bucket}`}
          >
            <div
              aria-label="Legend"
              className="-mt-1 mb-2 flex gap-4 text-xs text-ink"
            >
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2.5 rounded-[2px] bg-chart-1"
                />{' '}
                Added
              </span>
              <span className="inline-flex items-center gap-1.5">
                <span
                  aria-hidden
                  className="size-2.5 rounded-[2px] bg-chart-2"
                />{' '}
                Removed
              </span>
            </div>
            <ChurnChart data={data} tables={tables} />
          </Section>
        </div>
        <Section
          id="chart-heat"
          title="When are commits made?"
          meta="Commits by weekday and hour, local time"
        >
          <Heatmap data={data} tables={tables} />
        </Section>
        <div className="grid gap-x-9 @min-[900px]:grid-cols-2">
          <Section
            id="chart-files"
            title="Which files change most often?"
            meta="Commits that touched each file"
          >
            <TopList
              mono
              items={data.topFiles
                .slice(0, moreFiles ? 20 : 5)
                .map((f) => ({ name: f.path, count: f.commits }))}
              label={(n) => `${n === 1 ? 'commit' : 'commits'}`}
            />
            {data.topFiles.length > 5 && (
              <Button
                size="sm"
                variant="ghost"
                className="mt-2"
                onClick={() => setMoreFiles(!moreFiles)}
              >
                {moreFiles
                  ? 'Show top 5'
                  : `Show top ${Math.min(20, data.topFiles.length)}`}
              </Button>
            )}
          </Section>
          <Section
            id="chart-authors"
            title="Who made these commits?"
            meta="Author names from Git settings, not verified identities"
          >
            <TopList
              items={data.authors.map((a) => ({
                name: a.name,
                email: a.email,
                count: a.commits,
              }))}
              label={(n) => `${n === 1 ? 'commit' : 'commits'}`}
            />
            <p className="mt-2 text-[0.8125rem] text-muted">
              The same person can appear twice when their name differs between
              commits.
            </p>
          </Section>
        </div>
      </>
    );
  }

  return (
    <div className="@container">
      <div className="mt-6 flex flex-wrap items-center gap-x-4 gap-y-2">
        <Segmented
          label="Time range"
          value={range}
          options={RANGES}
          onChange={setRange}
        />
        <span className="min-w-0 flex-1 text-[0.8125rem] text-muted">
          Commits reachable from{' '}
          <b className="font-mono text-[0.78125rem] font-semibold text-ink">
            {repo.status?.branch ?? 'HEAD'}
          </b>{' '}
          by commit date, local time. Merges count once and add no lines.
        </span>
        <Button
          size="sm"
          variant={tables ? 'secondary' : 'ghost'}
          aria-pressed={tables}
          onClick={() => setTables(!tables)}
        >
          {tables ? 'Hide tables' : 'Show as tables'}
        </Button>
      </div>
      <div
        className={cn(
          'mt-4',
          analytics.isFetching && analytics.data && 'opacity-70',
        )}
      >
        {body}
      </div>
    </div>
  );
}
