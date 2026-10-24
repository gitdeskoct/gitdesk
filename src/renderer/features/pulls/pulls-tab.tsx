import { GitPullRequest, Plus, Search } from 'lucide-react';
import {
  useDeferredValue,
  useEffect,
  useState,
  type KeyboardEvent,
} from 'react';
import type { PullRequest, PullStatus } from '../../../shared/pulls';
import type { RepositorySummary } from '../../../shared/repos';
import {
  NoResultsArt,
  OfflineArt,
  PullRequestsArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { Segmented } from '../../components/ui/segmented';
import { Loading } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { usePullList } from '../../lib/pull-queries';
import { useAuthStatus, useSettings, useSignIn } from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { Stat } from '../home/stats-strip';
import { NewPullRequest } from './new-pull-request';
import { PullPreview } from './pull-preview';
import {
  BranchPair,
  MergeabilityChip,
  PullStateChip,
  ReviewChip,
  StoreTag,
  Tag,
  plural,
} from './pull-bits';

const STATUS_WORDS: Record<PullStatus, string> = {
  open: 'Open',
  merged: 'Merged',
  closed: 'Closed',
};

// Under 860px of workspace (1100px for Auto) the split layout falls back to the list.
const SPLIT_MIN = { split: 860, auto: 1100 } as const;

function meta(pull: PullRequest): string {
  const parts = [
    pull.status === 'merged' && pull.mergedAt
      ? `merged ${relativeTime(pull.mergedAt)}`
      : pull.status === 'closed' && pull.closedAt
        ? `closed ${relativeTime(pull.closedAt)}`
        : `updated ${relativeTime(pull.updatedAt)}`,
  ];
  if (pull.comments) parts.push(plural(pull.comments, 'comment'));
  return parts.join(' · ');
}

export function PullsTab({
  repo,
  width,
}: {
  repo: RepositorySummary;
  width: number;
}) {
  const { navigate } = useNavigation();
  const { data: settings } = useSettings();
  const { data: auth } = useAuthStatus();
  const signIn = useSignIn();
  const [status, setStatus] = useState<PullStatus>('open');
  const [search, setSearch] = useState('');
  const q = useDeferredValue(search.trim());
  const [creating, setCreating] = useState(false);
  const [selected, setSelected] = useState<string | null>(null);
  const list = usePullList(repo.id, status, q);
  const pages = list.data?.pages ?? [];
  const pulls = pages.flatMap((page) => page.pulls);
  const counts = pages[0]?.counts;
  const store = pages[0]?.store ?? (repo.remoteId ? 'account' : 'local');
  const chosen = settings?.pullRequestsLayout ?? 'auto';
  const split =
    chosen !== 'centered' &&
    width >= SPLIT_MIN[chosen === 'split' ? 'split' : 'auto'];
  const current = pulls.find((p) => p.id === selected) ?? pulls[0] ?? null;
  const open = (pull: PullRequest) =>
    navigate({ name: 'pull-request', repoId: repo.id, id: pull.id });

  // Selection follows the list: a filter that hides the selected row selects the first one.
  useEffect(() => {
    if (selected && !pulls.some((p) => p.id === selected)) setSelected(null);
  }, [pulls, selected]);

  if (creating)
    return (
      <div className="@container min-h-0 flex-1 overflow-auto px-6 pb-10 min-[1100px]:px-10">
        <div className="mx-auto max-w-(--content-max)">
          <NewPullRequest
            repo={repo}
            store={store}
            onCancel={() => setCreating(false)}
            onCreated={(pull) => {
              setCreating(false);
              open(pull);
            }}
          />
        </div>
      </div>
    );

  const newButton = (
    <Button
      variant="primary"
      size={split ? 'sm' : 'md'}
      onClick={() => setCreating(true)}
    >
      <Plus />
      {split ? 'New' : 'New pull request'}
    </Button>
  );

  let body;
  if (list.isPending) body = <Loading label="Loading pull requests…" />;
  else if (list.isError) {
    const signedOut = auth?.status !== 'authenticated' && !!repo.remoteId;
    body = (
      <EmptyState
        art={<OfflineArt />}
        title={
          signedOut
            ? 'Sign in to see these pull requests'
            : "Couldn't load the pull requests"
        }
        className="border-t border-line"
        action={
          signedOut ? (
            <Button pending={signIn.isPending} onClick={() => signIn.mutate()}>
              Sign in
            </Button>
          ) : (
            <Button
              pending={list.isFetching}
              onClick={() => void list.refetch()}
            >
              Try again
            </Button>
          )
        }
      >
        {ipcErrorMessage(list.error, 'The pull requests did not load.')}
      </EmptyState>
    );
  } else if (!pulls.length) {
    const none = counts && counts.open + counts.merged + counts.closed === 0;
    body = q ? (
      <EmptyState
        art={<NoResultsArt />}
        title={`Nothing matches "${q}"`}
        className="border-t border-line"
        action={<Button onClick={() => setSearch('')}>Clear search</Button>}
      >
        No {STATUS_WORDS[status].toLowerCase()} pull request has that in its
        title, number or branch.
      </EmptyState>
    ) : none ? (
      <EmptyState
        art={<PullRequestsArt />}
        title="No pull requests yet"
        className="border-t border-line"
        action={
          <Button variant="primary" onClick={() => setCreating(true)}>
            New pull request
          </Button>
        }
      >
        A pull request compares one branch with another so you can review it
        before merging.
      </EmptyState>
    ) : (
      <EmptyState
        art={<PullRequestsArt />}
        title={`No ${STATUS_WORDS[status].toLowerCase()} pull requests`}
        className="border-t border-line"
        action={<Button onClick={() => setStatus('open')}>Show open</Button>}
      >
        {status === 'open'
          ? 'Every pull request here is merged or closed.'
          : `Pull requests show here once they are ${status}.`}
      </EmptyState>
    );
  }

  const more = list.hasNextPage && (
    <Button
      size="sm"
      className="mt-3"
      pending={list.isFetchingNextPage}
      onClick={() => void list.fetchNextPage()}
    >
      Load 25 more
    </Button>
  );

  const searchField = (
    <label className="field flex h-9 min-w-0 flex-1 items-center gap-2 px-3 text-muted @min-[640px]:max-w-105">
      <Search aria-hidden className="size-4 shrink-0" />
      <span className="sr-only">Search pull requests</span>
      <input
        type="search"
        value={search}
        onChange={(event) => setSearch(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && setSearch('')}
        placeholder="Search by title, number or branch"
        className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-ink outline-none placeholder:text-muted"
      />
    </label>
  );

  if (split) {
    const index = current ? pulls.indexOf(current) : -1;
    const onKey = (event: KeyboardEvent) => {
      const next =
        event.key === 'ArrowDown'
          ? index + 1
          : event.key === 'ArrowUp'
            ? index - 1
            : null;
      if (event.key === 'Enter' && current) open(current);
      if (next === null || !pulls[next]) return;
      event.preventDefault();
      setSelected(pulls[next]!.id);
      document.getElementById(`pull-option-${pulls[next]!.id}`)?.focus();
    };
    return (
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(19rem,23rem)_minmax(0,1fr)]">
        <div className="@container flex min-h-0 flex-col border-r border-line">
          <div className="flex flex-wrap items-center gap-2 border-b border-line px-4 py-3">
            <Segmented
              label="State"
              value={status}
              onChange={setStatus}
              options={(['open', 'merged', 'closed'] as const).map((value) => ({
                value,
                label: counts
                  ? `${STATUS_WORDS[value]} ${counts[value]}`
                  : STATUS_WORDS[value],
              }))}
            />
            <span className="ml-auto">{newButton}</span>
            {searchField}
          </div>
          <div className="min-h-0 flex-1 overflow-auto">
            {body ?? (
              <div
                role="listbox"
                aria-label={`${STATUS_WORDS[status]} pull requests`}
                onKeyDown={onKey}
              >
                {pulls.map((pull) => (
                  <button
                    key={pull.id}
                    id={`pull-option-${pull.id}`}
                    type="button"
                    role="option"
                    aria-selected={pull === current}
                    tabIndex={pull === current ? 0 : -1}
                    onClick={() => setSelected(pull.id)}
                    onDoubleClick={() => open(pull)}
                    className={cn(
                      'block w-full border-b border-l-2 border-line border-l-transparent px-4 py-3 text-left focus-visible:outline-offset-[-2px]',
                      pull === current
                        ? 'border-l-accent bg-accent-soft'
                        : 'hover:bg-row-hover',
                    )}
                  >
                    <span className="block truncate text-[0.84375rem] font-semibold text-ink">
                      {pull.title}{' '}
                      <span className="font-normal text-muted">
                        #{pull.number}
                      </span>
                    </span>
                    <BranchPair
                      source={pull.sourceRef}
                      target={pull.targetRef}
                      className="mt-0.5 max-w-full text-muted"
                    />
                    <span className="mt-1.5 flex flex-wrap gap-x-3 gap-y-1">
                      {pull.status === 'open' ? (
                        <ReviewChip pull={pull} />
                      ) : (
                        <PullStateChip pull={pull} />
                      )}
                      <MergeabilityChip pull={pull} />
                    </span>
                  </button>
                ))}
                <div className="px-4 pb-4">{more}</div>
              </div>
            )}
          </div>
        </div>
        <div className="min-h-0 overflow-auto px-8 py-6">
          {current ? (
            <PullPreview
              repo={repo}
              pull={current}
              onOpen={() => open(current)}
            />
          ) : null}
        </div>
      </div>
    );
  }

  return (
    <div className="@container min-h-0 flex-1 overflow-auto px-6 pb-10 min-[1100px]:px-10">
      <div className="mx-auto max-w-(--content-max)">
        <div
          role="group"
          aria-label="Filter by state"
          className="grid grid-cols-3 border-b border-line"
        >
          {(['open', 'merged', 'closed'] as const).map((value) => (
            <Stat
              key={value}
              value={counts ? String(counts[value]) : '–'}
              label={STATUS_WORDS[value]}
              muted={!counts}
              context={
                value === 'open'
                  ? 'Waiting to be merged or closed'
                  : value === 'merged'
                    ? 'Merged into their target'
                    : 'Closed without merging'
              }
              pressed={status === value}
              onSelect={() => setStatus(value)}
            />
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-3 pt-5 pb-3">
          {searchField}
          <span className="ml-auto">{newButton}</span>
        </div>
        {body ?? (
          <ul
            aria-label={`${STATUS_WORDS[status]} pull requests`}
            className="border-t border-line"
          >
            {pulls.map((pull) => (
              <li key={pull.id} className="border-b border-line">
                <button
                  type="button"
                  onClick={() => open(pull)}
                  className="flex w-full flex-wrap items-start gap-x-3 gap-y-1.5 px-1.5 py-3 text-left hover:bg-row-hover focus-visible:outline-offset-[-2px]"
                >
                  <GitPullRequest
                    aria-hidden
                    className={cn(
                      'mt-0.5 size-4 shrink-0',
                      pull.status === 'open' ? 'text-success' : 'text-muted',
                    )}
                  />
                  <span className="min-w-0 flex-[1_1_18rem]">
                    <span className="flex items-baseline gap-2">
                      <span className="truncate text-sm font-semibold text-ink">
                        {pull.title}
                      </span>
                      <span className="shrink-0 text-[0.8125rem] text-muted">
                        #{pull.number}
                      </span>
                      {pull.isDraft && <Tag>Draft</Tag>}
                    </span>
                    <span className="mt-0.5 flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs text-muted">
                      <BranchPair
                        source={pull.sourceRef}
                        target={pull.targetRef}
                        className="max-w-full"
                      />
                      <span aria-hidden>·</span>
                      {meta(pull)}
                    </span>
                  </span>
                  {pull.status === 'open' ? (
                    <ReviewChip pull={pull} />
                  ) : (
                    <PullStateChip pull={pull} />
                  )}
                  <MergeabilityChip pull={pull} className="w-32" />
                </button>
              </li>
            ))}
          </ul>
        )}
        {more}
        {!list.isPending && !list.isError && (
          <p className="mt-4 flex flex-wrap items-center gap-2 text-xs text-muted">
            <StoreTag store={store} />
            {store === 'account'
              ? 'Stored in your gitdesk account. Git work happens on this computer.'
              : 'Stored on this computer, because this repository is not linked to your account.'}
          </p>
        )}
      </div>
    </div>
  );
}
