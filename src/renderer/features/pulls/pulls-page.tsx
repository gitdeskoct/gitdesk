import { RefreshCw, Search } from 'lucide-react';
import { useState } from 'react';
import {
  NoResultsArt,
  OfflineArt,
  PullRequestsArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { InlineStatus, Loading } from '../../components/ui/status';
import { relativeTime, useNow } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { usePullOverview } from '../../lib/pull-queries';
import { useNavigation } from '../../app/navigation';
import { Page, PageTitle } from '../shell/page';
import {
  BranchPair,
  MergeabilityChip,
  ReviewChip,
  StoreTag,
  Tag,
} from './pull-bits';

// The sidebar's Pull requests: every open pull request, newest activity first, across repositories.
export function PullsPage() {
  useNow();
  const { navigate } = useNavigation();
  const overview = usePullOverview();
  const [search, setSearch] = useState('');
  const q = search.trim().toLowerCase();
  const rows = (overview.data?.rows ?? []).filter(
    ({ pull, repository }) =>
      !q ||
      pull.title.toLowerCase().includes(q) ||
      repository.name.toLowerCase().includes(q) ||
      pull.sourceRef.toLowerCase().includes(q) ||
      `#${pull.number}` === q,
  );
  const header = (
    <Button
      variant="ghost"
      size="sm"
      pending={overview.isFetching}
      onClick={() => void overview.refetch()}
    >
      {!overview.isFetching && <RefreshCw />}
      Refresh
    </Button>
  );

  let body;
  if (overview.isPending)
    body = <Loading label="Loading open pull requests…" />;
  else if (overview.isError)
    body = (
      <EmptyState
        art={<OfflineArt />}
        title="Couldn't load pull requests"
        action={
          <Button
            pending={overview.isFetching}
            onClick={() => void overview.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(overview.error, 'They did not load.')}
      </EmptyState>
    );
  else if (!overview.data.rows.length)
    body = (
      <EmptyState
        art={<PullRequestsArt />}
        title="No open pull requests"
        action={
          <Button onClick={() => navigate({ name: 'repositories' })}>
            Go to Repositories
          </Button>
        }
      >
        Open one from a repository's Pull requests tab to compare a branch
        before you merge it.
      </EmptyState>
    );
  else if (!rows.length)
    body = (
      <EmptyState
        art={<NoResultsArt />}
        title={`Nothing matches "${search.trim()}"`}
        action={<Button onClick={() => setSearch('')}>Clear search</Button>}
      >
        No open pull request has that in its title, branch, number or
        repository.
      </EmptyState>
    );
  else
    body = (
      <div role="table" aria-label="Open pull requests" className="@container">
        <div
          role="row"
          className="hidden grid-cols-[minmax(0,1fr)_11rem_10rem_8rem] gap-4 border-b border-line px-1.5 py-2 text-xs font-medium text-muted @min-[760px]:grid"
        >
          <span role="columnheader">Pull request</span>
          <span role="columnheader">Repository</span>
          <span role="columnheader">Review</span>
          <span role="columnheader">Updated</span>
        </div>
        {rows.map(({ pull, repository }) => (
          <button
            key={pull.id}
            type="button"
            role="row"
            onClick={() =>
              navigate({
                name: 'pull-request',
                repoId: repository.id,
                id: pull.id,
              })
            }
            className="grid w-full gap-x-4 gap-y-1 border-b border-line px-1.5 py-3 text-left hover:bg-row-hover focus-visible:outline-offset-[-2px] @min-[760px]:grid-cols-[minmax(0,1fr)_11rem_10rem_8rem] @min-[760px]:items-center"
          >
            <span role="cell" className="min-w-0">
              <span className="flex items-baseline gap-2">
                <span className="truncate text-sm font-semibold text-ink">
                  {pull.title}
                </span>
                <span className="shrink-0 text-[0.8125rem] text-muted">
                  #{pull.number}
                </span>
                {pull.isDraft && <Tag>Draft</Tag>}
              </span>
              <BranchPair
                source={pull.sourceRef}
                target={pull.targetRef}
                className="max-w-full text-muted"
              />
            </span>
            <span
              role="cell"
              className="flex min-w-0 items-center gap-2 text-[0.8125rem] text-ink"
            >
              <span className="truncate">{repository.name}</span>
              <StoreTag store={pull.store} />
            </span>
            <span role="cell" className="flex flex-col gap-1">
              <ReviewChip pull={pull} />
              <MergeabilityChip pull={pull} />
            </span>
            <span role="cell" className="text-[0.8125rem] text-muted">
              {relativeTime(pull.updatedAt)}
            </span>
          </button>
        ))}
      </div>
    );

  return (
    <Page
      crumbs={[{ label: 'Code' }, { label: 'Pull requests' }]}
      actions={header}
    >
      <PageTitle title="Pull requests">
        Open pull requests in every repository on this computer and in your
        account.
      </PageTitle>
      {overview.data?.unavailable.length ? (
        <InlineStatus tone="warning" className="mb-4">
          Not shown: {overview.data.unavailable.join(', ')}. Their pull requests
          are in your account; sign in or reconnect to load them.
        </InlineStatus>
      ) : null}
      {(overview.data?.rows.length ?? 0) > 0 && (
        <label className="field mb-4 flex h-9 max-w-md items-center gap-2 px-3 text-muted">
          <Search aria-hidden className="size-4 shrink-0" />
          <span className="sr-only">Search open pull requests</span>
          <input
            type="search"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
            onKeyDown={(event) => event.key === 'Escape' && setSearch('')}
            placeholder="Search by title, branch, number or repository"
            className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-ink outline-none placeholder:text-muted"
          />
        </label>
      )}
      {body}
      <p className="mt-4 text-xs text-muted">
        Selecting a row opens it inside its repository.
      </p>
    </Page>
  );
}
