import { useState } from 'react';
import type { RepositorySummary } from '../../../shared/repos';
import type { LocalBranch } from '../../../shared/workspace';
import { BranchesArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { Tooltip } from '../../components/ui/tooltip';
import { useBranchOverview } from '../../lib/branch-queries';
import { usePullList } from '../../lib/pull-queries';
import { useSettings } from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { plural } from '../pulls/pull-bits';
import { ChartTable } from '../repository/analytics';
import { Section, SummaryStrip } from '../repository/history';

const DAY_MS = 24 * 60 * 60_000;

type State =
  | 'up-to-date'
  | 'ahead'
  | 'behind'
  | 'diverged'
  | 'no-upstream'
  | 'gone';
const STATES: { key: State; label: string }[] = [
  { key: 'up-to-date', label: 'Up to date' },
  { key: 'ahead', label: 'Ahead' },
  { key: 'behind', label: 'Behind' },
  { key: 'diverged', label: 'Diverged' },
  { key: 'no-upstream', label: 'No upstream' },
  { key: 'gone', label: 'Upstream missing' },
];

function stateOf(b: LocalBranch): State {
  if (!b.upstream) return 'no-upstream';
  if (b.gone) return 'gone';
  if (b.ahead && b.behind) return 'diverged';
  if (b.ahead) return 'ahead';
  if (b.behind) return 'behind';
  return 'up-to-date';
}

// Branch health for Overview: counts from Git's own refs on this computer, compared with each
// branch's upstream as of the last fetch. Pull requests are counted from their own record.
export function BranchHealth({ repo }: { repo: RepositorySummary }) {
  const overview = useBranchOverview(repo.id, repo.statusAt);
  const { data: settings } = useSettings();
  const pulls = usePullList(repo.id, 'open', '');
  const { navigate } = useNavigation();
  const [tables, setTables] = useState(false);
  const list = overview.data;
  if (!list) return null;
  const staleDays = settings?.branchStaleDays ?? 90;
  const stale = list.local.filter(
    (b) =>
      staleDays > 0 && b.at !== null && Date.now() - b.at > staleDays * DAY_MS,
  ).length;
  const merged = new Set(list.merged);
  const target = list.target?.name ?? null;
  const open = pulls.data?.pages[0]?.counts.open;
  const groups = STATES.map((state) => ({
    ...state,
    branches: list.local
      .filter((b) => stateOf(b) === state.key)
      .map((b) => b.name),
  }));
  const max = Math.max(1, ...groups.map((g) => g.branches.length));
  const attention = list.local.length - groups[0]!.branches.length;
  const unpublished = groups.find((g) => g.key === 'no-upstream')!.branches
    .length;
  return (
    <>
      <Section
        id="branch-counts-heading"
        title="Branches"
        meta="From Git on this computer"
      >
        <div className="@container">
          <SummaryStrip
            cells={[
              {
                label: 'Local branches',
                value: String(list.local.length),
                context: 'On this computer',
              },
              {
                label: 'Remote-tracking',
                value: String(list.remote.length),
                context: repo.status?.fetchedAt
                  ? 'Seen by the last fetch'
                  : 'Not fetched yet',
              },
              target
                ? {
                    label: `Unmerged into ${target}`,
                    value: String(
                      list.local.filter((b) => !merged.has(b.name)).length,
                    ),
                    context: `Local branches ${target} lacks`,
                  }
                : {
                    label: 'Unmerged',
                    value: 'No base',
                    context: 'Nothing to compare against',
                    word: true,
                  },
              open === undefined
                ? {
                    label: 'Open pull requests',
                    value: 'Not loaded',
                    context: 'Sign in for account records',
                    word: true,
                  }
                : {
                    label: 'Open pull requests',
                    value: String(open),
                    context: 'From the pull request record',
                  },
              staleDays > 0
                ? {
                    label: 'Stale',
                    value: String(stale),
                    context: `No commits in ${staleDays} days`,
                  }
                : {
                    label: 'Stale',
                    value: 'Off',
                    context: 'Settings › Git',
                    word: true,
                  },
            ]}
          />
        </div>
      </Section>
      <Section
        id="branch-health-heading"
        title="Which branches need attention?"
        meta={
          <Button
            size="sm"
            variant={tables ? 'secondary' : 'ghost'}
            aria-pressed={tables}
            onClick={() => setTables(!tables)}
          >
            {tables ? 'Hide table' : 'Show as table'}
          </Button>
        }
      >
        {!list.local.length ? (
          <EmptyState
            compact
            className="border-t border-line"
            art={<BranchesArt />}
            title="No branches yet"
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
            A branch needs a commit to point at, so this chart fills after the
            first one.
          </EmptyState>
        ) : (
          <>
            <p className="mb-3 text-[0.8125rem] text-muted">
              {attention
                ? `${plural(attention, 'local branch', 'local branches')} of ${list.local.length} need a push, a pull or a decision.`
                : `All ${plural(list.local.length, 'local branch', 'local branches')} match their upstream.`}{' '}
              {unpublished
                ? `${plural(unpublished, 'was', 'were')} never published, so ${unpublished === 1 ? 'its' : 'their'} commits exist only on this computer. `
                : ''}
              Counts compare each branch with its upstream as of the last fetch.
            </p>
            <div
              role="group"
              aria-label="Local branches by state"
              className="grid gap-2"
            >
              {groups.map((group) => {
                const label = `${group.label}: ${plural(group.branches.length, 'branch', 'branches')}`;
                return (
                  <Tooltip
                    key={group.key}
                    label={group.branches.join(', ') || 'None'}
                    side="top"
                  >
                    <button
                      type="button"
                      aria-label={label}
                      className="grid cursor-default grid-cols-[8.5rem_minmax(0,1fr)_2.5rem] items-center gap-3 rounded-[4px] text-left focus-visible:outline-offset-2"
                    >
                      <span className="text-[0.8125rem] text-ink">
                        {group.label}
                      </span>
                      <span className="h-3.5 overflow-hidden rounded-[4px] bg-control">
                        <span
                          className="block h-full rounded-[4px] bg-chart-1"
                          style={{
                            width: `${(group.branches.length / max) * 100}%`,
                          }}
                        />
                      </span>
                      <span className="text-right text-[0.8125rem] font-semibold text-ink tabular-nums">
                        {group.branches.length}
                      </span>
                    </button>
                  </Tooltip>
                );
              })}
            </div>
            {tables && (
              <ChartTable
                caption="Local branches by state, as of the last fetch"
                head={['State', 'Branches', 'Count']}
                rows={groups.map((g) => [
                  g.label,
                  g.branches.join(', ') || '—',
                  g.branches.length,
                ])}
              />
            )}
          </>
        )}
      </Section>
    </>
  );
}
