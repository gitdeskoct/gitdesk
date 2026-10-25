import {
  ArrowDownToLine,
  CircleAlert,
  Clock,
  CloudDownload,
  CloudUpload,
  GitCompare,
  TriangleAlert,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { RepositorySummary } from '../../../shared/repos';
import {
  RECOVERY,
  type PullStrategy,
  type SyncOperation,
  type SyncOverview,
} from '../../../shared/sync';
import {
  BranchesArt,
  OfflineArt,
  RemoteArt,
  SyncArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { JobProgress } from '../../components/ui/job-progress';
import { LongValue } from '../../components/ui/long-value';
import { ConnectionStrength } from '../../components/ui/network';
import { Loading } from '../../components/ui/status';
import { useToast } from '../../components/ui/toast';
import { cn } from '../../lib/cn';
import { relativeTime, useNow } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAuthStatus,
  useRemoteRepository,
  useRemotes,
  useSettings,
} from '../../lib/queries';
import {
  useCheckPush,
  useCheckRemote,
  useSyncOverview,
} from '../../lib/sync-queries';
import { useNavigation } from '../../app/navigation';
import { ChoiceList } from '../pulls/choice-list';
import { ConflictsView } from '../pulls/merge-tab';
import { plural, shortOid } from '../pulls/pull-bits';
import { sameGitUrl } from '../repository/hosted-remote';
import { Section, SummaryStrip } from '../repository/history';
import { useFetchAction } from '../repository/use-fetch';
import { usePushAction } from '../repository/use-push';
import { CompareView } from './compare-view';
import { PublishForm } from './publish-form';
import { OperationRow } from './sync-rows';
import { usePullAction } from './use-pull';

const STRATEGIES: {
  value: PullStrategy;
  title: string;
  description: (ahead: number) => string;
}[] = [
  {
    value: 'ff-only',
    title: 'Fast-forward only',
    description: () =>
      'Stops when the histories differ. Nothing is rewritten and no merge commit is made.',
  },
  {
    value: 'merge',
    title: 'Merge',
    description: () =>
      'Adds a merge commit to this branch. Conflicts open the conflict screen here.',
  },
  {
    value: 'rebase',
    title: 'Rebase',
    description: (ahead) =>
      `Replays your ${plural(ahead, 'commit')} on top of the upstream. Conflicts open the conflict screen, one commit at a time; Abort puts the branch back.`,
  },
];

// The state in one sentence, then what it means for the next step.
function sentence(sync: SyncOverview): { title: string; detail: string } {
  const branch = sync.branch ?? 'This branch';
  const upstream = sync.upstream ?? 'its upstream';
  const ahead = sync.ahead ?? 0;
  const behind = sync.behind ?? 0;
  switch (sync.state) {
    case 'up-to-date':
      return {
        title: `${branch} is up to date with ${upstream}`,
        detail:
          'As of the last fetch. Check remote asks the server again without downloading anything.',
      };
    case 'ahead':
      return {
        title: `${branch} has ${plural(ahead, 'commit')} to push`,
        detail: `They are on this computer only until you push them to ${upstream}.`,
      };
    case 'behind':
      return {
        title: `${upstream} has ${plural(behind, 'commit')} to pull`,
        detail:
          'They were fetched but are not in your branch yet. Pull brings them in.',
      };
    case 'diverged':
      return {
        title: `${branch} has diverged from ${upstream}`,
        detail: `${plural(ahead, 'commit')} here ${ahead === 1 ? 'is' : 'are'} not on the remote, and ${plural(behind, 'commit')} on the remote ${behind === 1 ? 'is' : 'are'} not here. Pull with Merge or Rebase, then push.`,
      };
    case 'no-upstream':
      if (sync.noCommits)
        return {
          title: `${branch} has no commits yet`,
          detail:
            'Commit your first change on the Changes tab, then publish it from here.',
        };
      return {
        title: `${branch} is only on this computer`,
        detail:
          'It has no branch on a remote yet. Publish it to push it and track it, or track a branch that already exists.',
      };
    // Git can't tell a deleted branch from one that was never pushed (a clone of an empty repository).
    case 'gone':
      return {
        title: `${upstream} isn't on the remote`,
        detail: `It was deleted there, or nothing was pushed to it yet. ${branch} and its commits are still here; publishing it creates the branch again.`,
      };
    default:
      return { title: '', detail: '' };
  }
}

function Band({
  tone,
  icon,
  children,
  action,
}: {
  tone: 'warning' | 'danger' | 'accent' | 'success';
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'mt-3 flex flex-wrap items-center gap-3 px-3 py-2.5 text-[0.8125rem] text-ink',
        {
          warning: 'bg-warning-soft [&>svg]:text-warning',
          danger: 'bg-danger-soft [&>svg]:text-danger',
          accent: 'bg-accent-soft [&>svg]:text-accent',
          success: 'bg-success-soft [&>svg]:text-success',
        }[tone],
      )}
    >
      {icon}
      <span className="min-w-[16rem] flex-1">{children}</span>
      {action}
    </div>
  );
}

// A push whose answer was lost: only the remote can say whether it landed.
function UnknownPush({
  repo,
  op,
}: {
  repo: RepositorySummary;
  op: SyncOperation;
}) {
  const check = useCheckPush(repo.id);
  const toast = useToast();
  return (
    <Band
      tone="accent"
      icon={<CircleAlert aria-hidden className="size-4 shrink-0" />}
      action={
        <Button
          size="sm"
          pending={check.isPending}
          onClick={() =>
            check.mutate(op.id, {
              onSuccess: (result) =>
                toast(
                  result.status === 'completed'
                    ? {
                        tone: 'success',
                        title: `${op.remote}/${op.branch} has the push`,
                      }
                    : result.status === 'unreachable'
                      ? {
                          tone: 'danger',
                          title: 'Still unconfirmed',
                          description: result.message,
                        }
                      : {
                          tone: 'danger',
                          title:
                            result.status === 'not-pushed'
                              ? "The remote didn't take the push"
                              : 'The remote moved to another commit',
                          description:
                            result.status === 'not-pushed'
                              ? 'Push again when you are ready.'
                              : 'Fetch to see it before pushing.',
                        },
                ),
            })
          }
        >
          Check status
        </Button>
      }
    >
      <b className="font-semibold">Push result unknown.</b>{' '}
      {op.message ??
        "The connection ended after the commits were sent, so gitdesk can't tell yet whether the remote took them."}{' '}
      Nothing is pushed again until you check.
    </Band>
  );
}

function RemoteCheck({ repo }: { repo: RepositorySummary }) {
  const check = useCheckRemote(repo.id);
  return (
    <>
      <Button
        variant="ghost"
        pending={check.isPending}
        onClick={() => check.mutate()}
      >
        Check remote
      </Button>
      {check.data && (
        <span className="basis-full text-[0.8125rem] text-muted" role="status">
          {check.data.status === 'same'
            ? 'The remote has nothing new since your last fetch.'
            : check.data.status === 'moved'
              ? `The remote moved${check.data.oid ? ` to ${shortOid(check.data.oid)}` : ''} since your last fetch. Fetch to bring it here.`
              : check.data.message}
        </span>
      )}
      {check.error && (
        <span className="basis-full text-[0.8125rem] text-danger" role="alert">
          {ipcErrorMessage(check.error, "The remote didn't answer the check.")}
        </span>
      )}
    </>
  );
}

function Tracking({
  repo,
  sync,
}: {
  repo: RepositorySummary;
  sync: SyncOverview;
}) {
  const remotes = useRemotes(repo.id, repo.statusAt);
  const { data: auth } = useAuthStatus();
  const hosted = useRemoteRepository(
    repo.remoteId ?? '',
    !!repo.remoteId && auth?.status === 'authenticated',
  ).data?.gitUrl;
  const { navigate } = useNavigation();
  const remote = remotes.data?.find((r) => r.name === sync.remote) ?? null;
  const rows: [string, ReactNode][] = [
    [
      'Remote',
      sync.remote ? (
        <span className="flex items-center gap-2">
          <b className="font-mono text-[0.8125rem] font-semibold">
            {sync.remote}
          </b>
          {hosted && remote && sameGitUrl(remote.fetchUrl, hosted) && (
            <span className="inline-flex h-5 items-center rounded-[4px] border border-line bg-sunken px-1.5 text-[0.71875rem] font-medium">
              gitdesk
            </span>
          )}
          <Button
            variant="link"
            className="text-[0.8125rem]"
            onClick={() =>
              navigate({ name: 'repository', id: repo.id, tab: 'remotes' })
            }
          >
            Remotes tab
          </Button>
        </span>
      ) : (
        <span className="text-muted">None tracked</span>
      ),
    ],
  ];
  if (remote) {
    rows.push([
      remote.pushUrl ? 'Fetch URL' : 'Fetch and push URL',
      <LongValue key="fetch" value={remote.fetchUrl} label="fetch URL" />,
    ]);
    if (remote.pushUrl)
      rows.push([
        'Push URL',
        <LongValue key="push" value={remote.pushUrl} label="push URL" />,
      ]);
  }
  rows.push(
    [
      'Tracking',
      sync.upstream ? (
        <span className="font-mono text-[0.78125rem]">
          {sync.branch} → {sync.upstream}
          {sync.state === 'gone' && (
            <span className="font-sans text-muted">
              {' '}
              (deleted on the remote)
            </span>
          )}
        </span>
      ) : (
        <span className="text-muted">Not tracking a remote branch</span>
      ),
    ],
    [
      'Last fetch',
      sync.fetchedAt ? (
        relativeTime(sync.fetchedAt)
      ) : (
        <span className="text-muted">Not fetched yet</span>
      ),
    ],
    [
      'Last push',
      sync.pushedAt ? (
        relativeTime(sync.pushedAt)
      ) : (
        <span className="text-muted">No push from gitdesk yet</span>
      ),
    ],
    ['Connection', <ConnectionStrength key="net" />],
  );
  return (
    <dl className="grid grid-cols-[minmax(7rem,10rem)_minmax(0,1fr)] gap-x-4 border-t border-line text-[0.8125rem]">
      {rows.map(([label, value]) => (
        <div key={label} className="contents">
          <dt className="border-b border-line py-2.5 text-muted">{label}</dt>
          <dd className="flex min-w-0 items-center border-b border-line py-2.5 text-ink">
            {value}
          </dd>
        </div>
      ))}
    </dl>
  );
}

export function SyncTab({
  repo,
  width,
}: {
  repo: RepositorySummary;
  width: number;
}) {
  useNow();
  const overview = useSyncOverview(repo.id, repo.statusAt);
  const { data: settings } = useSettings();
  const { navigate } = useNavigation();
  const [view, setView] = useState<'status' | 'compare'>('status');
  const [strategy, setStrategy] = useState<PullStrategy | null>(null);
  const pull = usePullAction(repo.id);
  const push = usePushAction(repo.id);
  const fetch = useFetchAction(repo.id, { toast: true });

  if (overview.isPending)
    return <Loading label="Reading this branch's sync state…" />;
  if (overview.isError)
    return (
      <EmptyState
        art={<OfflineArt />}
        title="Couldn't read the sync state"
        action={
          <Button
            pending={overview.isFetching}
            onClick={() => void overview.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(overview.error, 'Git did not answer.')}
      </EmptyState>
    );
  const sync = overview.data;

  if (
    sync.pending?.kind === 'pull' &&
    sync.pending.state === 'conflict_resolution'
  )
    return (
      <div className="@container">
        <ConflictsView
          repo={repo}
          pullSource={sync.pending.remote ?? 'the upstream'}
          pullTarget={sync.pending.branch ?? 'your branch'}
          upstream
        />
      </div>
    );
  if (sync.state === 'no-remote')
    return (
      <EmptyState
        art={<RemoteArt />}
        title="No remote to sync with"
        action={
          <Button
            onClick={() =>
              navigate({ name: 'repository', id: repo.id, tab: 'remotes' })
            }
          >
            Open Remotes
          </Button>
        }
      >
        This repository only exists on this computer. Its remotes, and your
        private gitdesk remote, are on the Remotes tab.
      </EmptyState>
    );
  if (sync.state === 'detached')
    return (
      <EmptyState
        art={<BranchesArt />}
        title="Not on a branch"
        action={
          <Button
            onClick={() =>
              navigate({ name: 'repository', id: repo.id, tab: 'branches' })
            }
          >
            Open Branches
          </Button>
        }
      >
        HEAD points at a commit, not a branch, so there is nothing to pull into
        or push. Switch to a branch first.
      </EmptyState>
    );
  if (view === 'compare')
    return (
      <CompareView repo={repo} width={width} onBack={() => setView('status')} />
    );

  const { title, detail } = sentence(sync);
  const ahead = sync.ahead ?? 0;
  const behind = sync.behind ?? 0;
  const tracked = !!sync.upstream && sync.state !== 'gone';
  const method = strategy ?? settings?.pullStrategy ?? 'ff-only';
  const pushBlocked = sync.state === 'diverged' || sync.state === 'behind';
  // Fast-forward only can't pull diverged histories; the band below says which method can.
  const ffBlocked = sync.state === 'diverged' && method === 'ff-only';
  const pendingPush =
    sync.pending?.kind === 'push' && sync.pending.state === 'unknown'
      ? sync.pending
      : null;
  const pullLabel = [
    'Pull',
    behind > 0 ? String(behind) : null,
    method === 'ff-only' ? null : `with ${method}`,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="pt-5 @container">
      <h2 className="text-[1.125rem] font-semibold tracking-[-0.01em] text-ink">
        {title}
      </h2>
      <p className="mt-1 mb-4 text-sm text-muted">{detail}</p>

      <SummaryStrip
        cells={[
          {
            label: 'To push',
            value: tracked ? String(ahead) : 'None',
            word: !tracked,
            context: tracked
              ? `Commits ${sync.upstream} doesn't have`
              : 'No upstream to compare with',
          },
          {
            label: 'To pull',
            value: tracked ? String(behind) : 'None',
            word: !tracked,
            context: tracked
              ? `Fetched, not in ${sync.branch} yet`
              : 'No upstream to compare with',
          },
          {
            label: 'Changed files',
            value: String(sync.changed),
            context: 'Uncommitted on this computer',
          },
          {
            label: 'Remote last checked',
            value: sync.fetchedAt ? relativeTime(sync.fetchedAt) : 'Never',
            word: true,
            context: sync.stale ? (
              <span className="inline-flex items-center gap-1">
                <Clock aria-hidden className="size-3.5 text-warning" />
                Counts may be out of date
              </span>
            ) : (
              'Counts match that fetch'
            ),
          },
        ]}
      />

      <div className="mt-4 flex flex-wrap items-center gap-2">
        {tracked && (
          <Button
            variant={behind > 0 && !ffBlocked ? 'primary' : 'secondary'}
            pending={pull.running}
            aria-disabled={
              (behind === 0 && !sync.stale) || ffBlocked || undefined
            }
            title={
              ffBlocked
                ? 'Choose Merge or Rebase below: a fast-forward is not possible'
                : behind === 0 && !sync.stale
                  ? 'Nothing to pull as of the last fetch'
                  : undefined
            }
            onClick={() => !pull.running && !ffBlocked && pull.start(method)}
          >
            {!pull.running && <ArrowDownToLine />}
            {pull.running ? 'Pulling' : pullLabel}
          </Button>
        )}
        {tracked && (
          <Button
            variant={ahead > 0 && !pushBlocked ? 'primary' : 'secondary'}
            pending={push.running}
            aria-disabled={pushBlocked || ahead === 0 || undefined}
            title={
              pushBlocked
                ? 'Pull first: the remote has commits this branch does not'
                : ahead === 0
                  ? 'Nothing to push'
                  : undefined
            }
            onClick={() => !pushBlocked && ahead > 0 && push.start()}
          >
            {!push.running && <CloudUpload />}
            {push.running ? 'Pushing' : `Push ${ahead || ''}`.trim()}
          </Button>
        )}
        {sync.remote && (
          <Button
            pending={!!fetch.running}
            onClick={() => fetch.start(sync.remote!)}
          >
            {!fetch.running && <CloudDownload />}
            Fetch {sync.remote}
          </Button>
        )}
        {tracked && (
          <Button onClick={() => setView('compare')}>
            <GitCompare />
            Compare
          </Button>
        )}
        {tracked && <RemoteCheck repo={repo} />}
        {(pull.running || push.running) && (
          <Button
            variant="ghost"
            onClick={pull.running ? pull.cancel : push.cancel}
          >
            Cancel
          </Button>
        )}
      </div>

      {(pull.running || push.running || fetch.running) && (
        <div className="mt-3">
          <JobProgress
            label={pull.running ? 'Pull' : push.running ? 'Push' : 'Fetch'}
            stage={
              (pull.progress ?? push.progress ?? fetch.progress)?.stage ??
              'Connecting'
            }
            right={`${(pull.progress ?? push.progress ?? fetch.progress)?.percent ?? 0}%`}
            percent={
              (pull.progress ?? push.progress ?? fetch.progress)?.percent ?? 0
            }
            progress={pull.progress ?? push.progress ?? fetch.progress}
            network
          />
        </div>
      )}

      {sync.state === 'diverged' && method === 'ff-only' && (
        <Band
          tone="warning"
          icon={<TriangleAlert aria-hidden className="size-4 shrink-0" />}
        >
          <b className="font-semibold">Fast-forward only can't pull this.</b>{' '}
          Both sides have new commits. Choose Merge or Rebase below, then pull.
          gitdesk never force-pushes.
        </Band>
      )}
      {pendingPush && <UnknownPush repo={repo} op={pendingPush} />}
      {pull.stopped && (
        <Band
          tone="danger"
          icon={<X aria-hidden className="size-4 shrink-0" />}
          action={
            <Button size="sm" variant="ghost" onClick={pull.dismiss}>
              Dismiss
            </Button>
          }
        >
          <b className="font-semibold">Didn't pull.</b> {pull.stopped.message}
          {RECOVERY[pull.stopped.code] === 'sign-in' &&
            ' Sign in again from the account menu.'}
          {pull.stopped.files.length > 0 && (
            <span className="mt-1 block font-mono text-[0.78125rem]">
              {pull.stopped.files.join(', ')}
            </span>
          )}
        </Band>
      )}

      {(sync.state === 'no-upstream' || sync.state === 'gone') &&
        !sync.noCommits && (
          <Section id="publish-heading" title="Publish or track">
            <PublishForm repo={repo} sync={sync} />
          </Section>
        )}

      {tracked && (behind > 0 || sync.state === 'diverged' || strategy) && (
        <Section
          id="method-heading"
          title={`How Pull brings in ${sync.upstream}`}
        >
          <ChoiceList
            label="Pull method"
            value={method}
            onChange={setStrategy}
            options={STRATEGIES.map((s) => ({
              value: s.value,
              title: s.title,
              description: s.description(ahead),
            }))}
          />
          <p className="mt-2 text-xs text-muted">
            Your default is{' '}
            {
              STRATEGIES.find(
                (s) => s.value === (settings?.pullStrategy ?? 'ff-only'),
              )?.title
            }
            , from Settings › Sync. A choice here is for this pull.
          </p>
        </Section>
      )}

      <Section id="tracking-heading" title="Tracking">
        <Tracking repo={repo} sync={sync} />
      </Section>

      <Section
        id="recent-sync-heading"
        title="Recent sync"
        meta={
          <Button
            variant="link"
            className="text-[0.8125rem]"
            onClick={() => navigate({ name: 'sync-activity' })}
          >
            All sync activity
          </Button>
        }
      >
        {sync.recent.length ? (
          <ul className="border-t border-line">
            {sync.recent.map((op) => (
              <OperationRow key={op.id} op={op} />
            ))}
          </ul>
        ) : (
          <EmptyState
            compact
            className="border-t border-line"
            art={<SyncArt />}
            title="No syncs yet"
            action={
              sync.remote ? (
                <Button
                  size="sm"
                  pending={!!fetch.running}
                  onClick={() => fetch.start(sync.remote!)}
                >
                  Fetch {sync.remote}
                </Button>
              ) : (
                <Button
                  size="sm"
                  onClick={() => navigate({ name: 'sync-activity' })}
                >
                  Open Sync activity
                </Button>
              )
            }
          >
            Fetches, pulls and pushes you run from gitdesk appear here.
          </EmptyState>
        )}
      </Section>
    </div>
  );
}
