import { useState } from 'react';
import {
  SYNC_PAGE,
  type AccountPush,
  type SyncActivityPage as Page_,
} from '../../../shared/sync';
import { Check, CircleAlert } from 'lucide-react';
import {
  NoResultsArt,
  OfflineArt,
  SyncArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { Pager } from '../../components/ui/pager';
import { Segmented } from '../../components/ui/segmented';
import { Loading } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import { relativeTime, useNow } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAccountPushes,
  useAccountPushStats,
  useSyncActivity,
} from '../../lib/sync-queries';
import { useAuthStatus, useSettings } from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { Axis, Bar, ChartTable, scaleTop } from '../repository/analytics';
import { Page, PageTitle } from '../shell/page';
import { OperationRow } from './sync-rows';

type Filter = 'all' | 'failed' | 'unconfirmed';

const weekName = (start: number, long = false) =>
  new Intl.DateTimeFormat(
    undefined,
    long
      ? { day: 'numeric', month: 'long' }
      : { day: 'numeric', month: 'short' },
  ).format(new Date(start));

// Did the pushes reach the server? One bar pair per week: local weeks for this computer, UTC
// weeks for the account, whose records span every device.
function PushChart({
  weeks,
  account = false,
}: {
  weeks: Page_['weeks'];
  account?: boolean;
}) {
  const [table, setTable] = useState(false);
  const confirmed = weeks.reduce((sum, w) => sum + w.confirmed, 0);
  const other = weeks.reduce((sum, w) => sum + w.other, 0);
  const top = scaleTop(Math.max(...weeks.map((w) => w.confirmed + w.other), 0));
  return (
    <figure className="m-0 min-w-0">
      <h2 className="text-[0.9375rem] font-semibold text-ink">
        Did your pushes reach the server?
      </h2>
      <div className="mt-1.5 mb-3 flex flex-wrap gap-4 text-xs text-muted">
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="size-2.5 rounded-[2px] bg-chart-1" />
          Confirmed
        </span>
        <span className="inline-flex items-center gap-1.5">
          <i aria-hidden className="size-2.5 rounded-[2px] bg-chart-2" />
          Not confirmed, refused or failed
        </span>
        <Button
          variant="link"
          className="ml-auto text-xs"
          onClick={() => setTable(!table)}
        >
          {table ? 'Show as chart' : 'Show as table'}
        </Button>
      </div>
      {table ? (
        <ChartTable
          caption="Pushes per week"
          head={['Week of', 'Confirmed', 'Not confirmed']}
          rows={weeks.map((w) => [
            weekName(w.start, true),
            w.confirmed,
            w.other,
          ])}
        />
      ) : (
        <>
          <div className="grid h-36 grid-cols-[2rem_minmax(0,1fr)] gap-2">
            <Axis labels={[String(top), String(top / 2), '0']} />
            <div className="grid h-full grid-cols-8 items-end gap-3 border-b border-line-strong">
              {weeks.map((w) => (
                <div
                  key={w.start}
                  className="flex h-full items-end justify-center gap-1"
                >
                  <Bar
                    label={`Week of ${weekName(w.start, true)}: ${w.confirmed} confirmed`}
                    height={(w.confirmed / top) * 100}
                    className="bg-chart-1"
                    top
                  />
                  <Bar
                    label={`Week of ${weekName(w.start, true)}: ${w.other} not confirmed`}
                    height={(w.other / top) * 100}
                    className="bg-chart-2"
                    top
                  />
                </div>
              ))}
            </div>
          </div>
          <div className="mt-1.5 ml-10 grid grid-cols-8 gap-3 text-center text-[0.71875rem] text-muted">
            {weeks.map((w, i) => (
              <span
                key={w.start}
                className={cn(
                  'truncate',
                  i % 2 === 1 && 'invisible @min-[720px]:visible',
                )}
              >
                {weekName(w.start)}
              </span>
            ))}
          </div>
        </>
      )}
      <figcaption className="mt-2.5 text-[0.8125rem] text-muted">
        {confirmed + other
          ? `${confirmed} of ${confirmed + other} pushes in the last 8 weeks were confirmed${other ? `; ${other} ${other === 1 ? 'was' : 'were'} not.` : '.'}${account ? ' A push counts once the server finds its commit.' : ' A push to your gitdesk remote counts once the server finds the commit; one to another provider, once that remote accepts it.'}`
          : account
            ? 'No pushes to your gitdesk remotes in the last 8 weeks.'
            : 'No pushes from this computer in the last 8 weeks.'}{' '}
        {account &&
          'Weeks are UTC, counted by your account across every device.'}
      </figcaption>
    </figure>
  );
}

// The account's record of pushes to its Git URLs, from every device, a cursor page at a time.
function AccountActivity() {
  const [result, setResult] = useState<'all' | 'unverified'>('all');
  const pushes = useAccountPushes(result, true);
  const stats = useAccountPushStats(true);
  const events = pushes.data?.pages.flatMap((p) => p.events) ?? [];

  if (pushes.isPending || stats.isPending)
    return <Loading label="Loading your account's pushes…" />;
  if (pushes.isError || stats.isError)
    return (
      <EmptyState
        art={<OfflineArt />}
        title="Couldn't load your account's pushes"
        action={
          <Button
            pending={pushes.isFetching || stats.isFetching}
            onClick={() => {
              void pushes.refetch();
              void stats.refetch();
            }}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(
          pushes.error ?? stats.error,
          "The gitdesk server didn't answer.",
        )}
      </EmptyState>
    );
  if (!events.length && result === 'all')
    return (
      <EmptyState
        art={<SyncArt />}
        title="No pushes recorded yet"
        action={
          <Button
            pending={pushes.isFetching || stats.isFetching}
            onClick={() => {
              void pushes.refetch();
              void stats.refetch();
            }}
          >
            Check again
          </Button>
        }
      >
        Pushes to your gitdesk remotes, from any computer, appear here once the
        server has checked them.
      </EmptyState>
    );
  return (
    <>
      <PushChart
        account
        weeks={stats.data.weeks.map((w) => ({
          start: w.start,
          confirmed: w.confirmed,
          other: w.unverified,
        }))}
      />
      <div className="mt-10 mb-2 flex flex-wrap items-center gap-3">
        <h2 className="flex-1 text-[0.9375rem] font-semibold text-ink">
          Pushes your account recorded
        </h2>
        <Segmented
          label="Show"
          value={result}
          onChange={setResult}
          options={[
            { value: 'all', label: 'All' },
            { value: 'unverified', label: 'Not confirmed' },
          ]}
        />
      </div>
      {events.length ? (
        <>
          <ul className="border-t border-line">
            {events.map((event) => (
              <AccountRow key={event.operationId} event={event} />
            ))}
          </ul>
          {pushes.hasNextPage && (
            <div className="pt-3">
              <Button
                size="sm"
                pending={pushes.isFetchingNextPage}
                onClick={() => void pushes.fetchNextPage()}
              >
                Load 20 more
              </Button>
            </div>
          )}
        </>
      ) : (
        <EmptyState
          compact
          className="border-t border-line"
          art={<NoResultsArt />}
          title="Every push is confirmed"
          action={
            <Button size="sm" onClick={() => setResult('all')}>
              Show all
            </Button>
          }
        >
          The server found the commit of every push it recorded.
        </EmptyState>
      )}
    </>
  );
}

function AccountRow({ event }: { event: AccountPush }) {
  const branch = event.ref.replace(/^refs\/heads\//, '');
  const moved = event.tip && event.tip !== event.newOid;
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 border-b border-line py-2.5 text-[0.8125rem]">
      {event.result === 'confirmed' ? (
        <Check aria-hidden className="mt-0.5 size-4 text-success" />
      ) : (
        <CircleAlert aria-hidden className="mt-0.5 size-4 text-warning" />
      )}
      <span className="min-w-0">
        <span className="font-medium text-ink">Pushed {branch}</span>
        <span className="text-muted"> · {event.repositoryName}</span>
        <span className="block truncate font-mono text-xs text-muted">
          {event.oldOid ? `${event.oldOid.slice(0, 7)}..` : ''}
          {event.newOid.slice(0, 7)}
          {moved && (
            <span className="font-sans">
              {' '}
              · the branch has since moved to {event.tip!.slice(0, 7)}
            </span>
          )}
        </span>
      </span>
      <span className="flex flex-col items-end gap-1 text-xs text-muted">
        <span className="whitespace-nowrap">
          {relativeTime(event.createdAt)}
        </span>
        <span className="inline-flex h-5 items-center rounded-[4px] border border-line bg-sunken px-1.5 text-[0.71875rem] font-medium whitespace-nowrap text-ink">
          {event.result === 'confirmed'
            ? 'Confirmed by server'
            : 'Not confirmed'}
        </span>
      </span>
    </li>
  );
}

export function SyncActivityPage() {
  useNow();
  const { navigate } = useNavigation();
  const { data: auth } = useAuthStatus();
  const { data: settings } = useSettings();
  const canUseAccount =
    auth?.status === 'authenticated' && !settings?.localOnly;
  const [scope, setScope] = useState<'computer' | 'account'>('computer');
  const showAccount = canUseAccount && scope === 'account';
  const [filter, setFilter] = useState<Filter>('all');
  const [page, setPage] = useState(1);
  const activity = useSyncActivity(filter, (page - 1) * SYNC_PAGE);
  const data = activity.data;
  const pages = data ? Math.max(1, Math.ceil(data.total / SYNC_PAGE)) : 1;

  let body;
  if (activity.isPending) body = <Loading label="Loading sync activity…" />;
  else if (activity.isError)
    body = (
      <EmptyState
        art={<OfflineArt />}
        title="Couldn't load sync activity"
        action={
          <Button
            pending={activity.isFetching}
            onClick={() => void activity.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(
          activity.error,
          "This computer's records didn't load.",
        )}
      </EmptyState>
    );
  else if (!data!.total && filter === 'all')
    body = (
      <EmptyState
        art={<SyncArt />}
        title="No syncs yet"
        action={
          <Button onClick={() => navigate({ name: 'repositories' })}>
            Open a repository
          </Button>
        }
      >
        Fetches, pulls and pushes you run from gitdesk appear here, with the
        server's confirmation for each push to your gitdesk remote.
      </EmptyState>
    );
  else
    body = (
      <>
        <PushChart weeks={data!.weeks} />
        <div className="mt-10 mb-2 flex flex-wrap items-center gap-3">
          <h2 className="flex-1 text-[0.9375rem] font-semibold text-ink">
            History
          </h2>
          <Segmented
            label="Show"
            value={filter}
            onChange={(next) => {
              setFilter(next);
              setPage(1);
            }}
            options={[
              { value: 'all', label: 'All' },
              { value: 'failed', label: 'Failed' },
              { value: 'unconfirmed', label: 'Not confirmed' },
            ]}
          />
        </div>
        {data!.items.length ? (
          <>
            <ul className="border-t border-line">
              {data!.items.map((op) => (
                <OperationRow key={op.id} op={op} showRepository />
              ))}
            </ul>
            <Pager
              label="Sync activity pages"
              page={page}
              pages={pages}
              from={(page - 1) * SYNC_PAGE + 1}
              to={Math.min(page * SYNC_PAGE, data!.total)}
              total={data!.total}
              onPage={setPage}
            />
          </>
        ) : (
          <EmptyState
            compact
            className="border-t border-line"
            art={<NoResultsArt />}
            title={
              filter === 'failed'
                ? 'No failed syncs'
                : 'Every push is confirmed'
            }
            action={
              <Button size="sm" onClick={() => setFilter('all')}>
                Show all
              </Button>
            }
          >
            {filter === 'failed'
              ? 'Nothing failed in the history gitdesk keeps.'
              : 'No push is waiting for the server to confirm it.'}
          </EmptyState>
        )}
      </>
    );

  return (
    <Page crumbs={[{ label: 'Sync activity' }]}>
      <PageTitle
        title="Sync activity"
        actions={
          canUseAccount && (
            <Segmented
              label="Whose syncs"
              value={scope}
              onChange={setScope}
              options={[
                { value: 'computer', label: 'This computer' },
                { value: 'account', label: 'Your account' },
              ]}
            />
          )
        }
      >
        {showAccount
          ? 'Every push to your gitdesk remotes from any computer, as the server recorded and checked it.'
          : 'Every fetch, pull and push gitdesk ran on this computer, newest first. Kept for half a year.'}
      </PageTitle>
      <div className="@container">
        {showAccount ? <AccountActivity /> : body}
      </div>
    </Page>
  );
}
