import * as Tabs from '@radix-ui/react-tabs';
import { useQueryClient } from '@tanstack/react-query';
import { CircleX, Copy, GitPullRequest, Pencil, RefreshCw } from 'lucide-react';
import { useState } from 'react';
import type { RepositorySummary } from '../../../shared/repos';
import {
  FolderMissingArt,
  OfflineArt,
  PullRequestsArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { InlineStatus, Loading } from '../../components/ui/status';
import { useToast } from '../../components/ui/toast';
import { relativeTime, useNow } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useConflicts,
  usePullDetail,
  useSetPullStatus,
} from '../../lib/pull-queries';
import { useAuthStatus, useRepositories, useSignIn } from '../../lib/queries';
import { useWidth } from '../../lib/use-width';
import { useNavigation, type PullTab } from '../../app/navigation';
import { RepoMenuButton, type Action } from '../repos/repo-actions';
import { Page } from '../shell/page';
import { FilesTab } from './files-tab';
import { MergeTab } from './merge-tab';
import { OverviewTab } from './overview-tab';
import {
  AuthorBadge,
  BranchPair,
  PROBLEM_WORDS,
  PullStateChip,
  StoreTag,
  Tag,
} from './pull-bits';
import { ActivityTab, CommitsTab } from './pull-history';

const TAB_TRIGGER =
  'h-9 shrink-0 border-b-2 border-transparent px-2.5 text-[0.8125rem] text-muted hover:text-ink focus-visible:outline-offset-[-2px] data-[state=active]:border-accent data-[state=active]:font-semibold data-[state=active]:text-ink';

export function PullRequestPage({
  repoId,
  id,
  tab,
}: {
  repoId: string;
  id: string;
  tab?: PullTab;
}) {
  const { navigate } = useNavigation();
  const repos = useRepositories();
  const repo = repos.data?.find((r) => r.id === repoId);
  const crumbs = [
    {
      label: 'Repositories',
      onSelect: () => navigate({ name: 'repositories' }),
    },
    ...(repo
      ? [
          {
            label: repo.name,
            onSelect: () => navigate({ name: 'repository', id: repo.id }),
          },
          {
            label: 'Pull requests',
            onSelect: () =>
              navigate({ name: 'repository', id: repo.id, tab: 'pulls' }),
          },
        ]
      : []),
    { label: 'Pull request' },
  ];
  if (repos.isPending)
    return (
      <Page crumbs={crumbs}>
        <Loading label="Loading…" />
      </Page>
    );
  if (!repo)
    return (
      <Page crumbs={crumbs}>
        <EmptyState
          art={<FolderMissingArt />}
          title="That repository is no longer in gitdesk"
          action={
            <Button onClick={() => navigate({ name: 'repositories' })}>
              Go to Repositories
            </Button>
          }
        >
          Its pull requests open from the repository once it is added again.
        </EmptyState>
      </Page>
    );
  return (
    <PullView repo={repo} id={id} tab={tab ?? 'overview'} crumbs={crumbs} />
  );
}

function PullView({
  repo,
  id,
  tab,
  crumbs,
}: {
  repo: RepositorySummary;
  id: string;
  tab: PullTab;
  crumbs: { label: string; onSelect?: () => void }[];
}) {
  useNow();
  const { navigate } = useNavigation();
  const { data: auth } = useAuthStatus();
  const signIn = useSignIn();
  const toast = useToast();
  const [measure, width] = useWidth();
  const detail = usePullDetail(repo.id, id, repo.statusAt);
  const qc = useQueryClient();
  const conflicts = useConflicts(repo.id, repo.statusAt);
  const status = useSetPullStatus(repo.id, id);
  const [editing, setEditing] = useState(false);
  const setTab = (next: PullTab) =>
    navigate({ name: 'pull-request', repoId: repo.id, id, tab: next });

  if (detail.isPending)
    return (
      <Page crumbs={crumbs}>
        <Loading label="Comparing the branches…" />
      </Page>
    );
  if (detail.isError) {
    const signedOut = !!repo.remoteId && auth?.status !== 'authenticated';
    const gone = /no longer exists/.test(ipcErrorMessage(detail.error, ''));
    return (
      <Page crumbs={crumbs}>
        <EmptyState
          art={gone ? <PullRequestsArt /> : <OfflineArt />}
          title={
            gone
              ? 'This pull request no longer exists'
              : signedOut
                ? 'Sign in to see this pull request'
                : "Couldn't load this pull request"
          }
          action={
            gone ? (
              <Button
                onClick={() =>
                  navigate({ name: 'repository', id: repo.id, tab: 'pulls' })
                }
              >
                Back to pull requests
              </Button>
            ) : signedOut ? (
              <Button
                pending={signIn.isPending}
                onClick={() => signIn.mutate()}
              >
                Sign in
              </Button>
            ) : (
              <Button
                pending={detail.isFetching}
                onClick={() => void detail.refetch()}
              >
                Try again
              </Button>
            )
          }
        >
          {ipcErrorMessage(detail.error, 'It did not load.')}
        </EmptyState>
      </Page>
    );
  }

  const { pull, comparison, problem } = detail.data;
  const trail = [...crumbs.slice(0, -1), { label: `#${pull.number}` }];
  const conflicted =
    conflicts.data?.operation && conflicts.data.pullId === pull.id;
  const actions: Action[] = [
    ...(pull.status !== 'merged'
      ? [
          {
            key: 'edit',
            label: 'Edit title and description',
            icon: Pencil,
            onSelect: () => {
              setTab('overview');
              setEditing(true);
            },
          },
        ]
      : []),
    {
      key: 'copy',
      label: 'Copy branch name',
      icon: Copy,
      onSelect: () =>
        void navigator.clipboard
          .writeText(pull.sourceRef)
          .then(() => toast({ tone: 'success', title: 'Branch name copied' })),
    },
    ...(pull.status === 'open'
      ? [
          {
            key: 'close',
            label: 'Close without merging',
            icon: CircleX,
            danger: true,
            separatorBefore: true,
            onSelect: () =>
              status.mutate('closed', {
                onSuccess: () =>
                  toast({
                    tone: 'success',
                    title: `Closed #${pull.number}`,
                    description: 'Branches and comments were kept.',
                    action: {
                      label: 'Reopen',
                      altText: 'Reopen the pull request',
                      onClick: () => status.mutate('open'),
                    },
                  }),
                onError: (err) =>
                  toast({
                    tone: 'danger',
                    title: "Didn't close",
                    description: ipcErrorMessage(err, 'Try again.'),
                  }),
              }),
          },
        ]
      : pull.status === 'closed'
        ? [
            {
              key: 'reopen',
              label: 'Reopen',
              icon: GitPullRequest,
              separatorBefore: true,
              onSelect: () =>
                status.mutate('open', {
                  onError: (err) =>
                    toast({
                      tone: 'danger',
                      title: "Didn't reopen",
                      description: ipcErrorMessage(err, 'Try again.'),
                    }),
                }),
            },
          ]
        : []),
  ];
  const header = (
    <>
      <Button
        variant="ghost"
        size="sm"
        pending={detail.isFetching}
        onClick={() => {
          void detail.refetch();
          void qc.invalidateQueries({ queryKey: ['pull-conflicts', repo.id] });
        }}
      >
        {!detail.isFetching && <RefreshCw />}
        Refresh
      </Button>
      <RepoMenuButton name={`pull request #${pull.number}`} actions={actions} />
    </>
  );

  const files = comparison?.files.length ?? 0;
  const commits = comparison?.commits.length ?? 0;
  const padded = 'px-6 min-[1100px]:px-10';
  const scrolling = (children: React.ReactNode) => (
    <div className={`@container min-h-0 flex-1 overflow-auto pb-10 ${padded}`}>
      <div className="mx-auto max-w-(--content-max)">{children}</div>
    </div>
  );
  return (
    <Page crumbs={trail} actions={header} fill>
      <div ref={measure} className="flex min-h-0 flex-1 flex-col">
        <div className={`flex-none pt-4 ${padded}`}>
          <div className="mx-auto max-w-(--content-max)">
            <p className="flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
              <AuthorBadge author={pull.author} size="sm" />#{pull.number} ·
              opened by {pull.author.name} {relativeTime(pull.createdAt)}
              <StoreTag store={pull.store} />
              {pull.isDraft && <Tag>Draft</Tag>}
            </p>
            <h1 className="mt-1.5 text-xl font-semibold tracking-[-0.02em] text-ink [overflow-wrap:anywhere]">
              {pull.title}
            </h1>
            <div className="mt-1 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem]">
              <PullStateChip pull={pull} />
              <BranchPair source={pull.sourceRef} target={pull.targetRef} />
              {pull.latest && (
                <span className="text-xs text-muted">
                  snapshot {pull.latest.version} · compared{' '}
                  {relativeTime(pull.updatedAt)}
                </span>
              )}
            </div>
            {problem && pull.status === 'open' && (
              <InlineStatus tone="warning" className="mt-3">
                <b className="font-semibold">{PROBLEM_WORDS[problem]}.</b>{' '}
                {problem === 'source-missing'
                  ? `${pull.sourceRef} isn't a branch here any more. Restore it, or close this pull request.`
                  : problem === 'target-missing'
                    ? `${pull.targetRef} isn't a branch here any more.`
                    : 'Git cannot compare these branches.'}
              </InlineStatus>
            )}
            {conflicted && tab !== 'merge' && (
              <InlineStatus
                tone="danger"
                className="mt-3"
                action={
                  <Button size="sm" onClick={() => setTab('merge')}>
                    Resolve conflicts
                  </Button>
                }
              >
                A {conflicts.data!.operation} for this pull request stopped on
                conflicts.
              </InlineStatus>
            )}
            {status.isError && (
              <InlineStatus tone="danger" className="mt-3">
                {ipcErrorMessage(status.error, "That didn't change.")}
              </InlineStatus>
            )}
          </div>
        </div>
        <Tabs.Root
          value={tab}
          onValueChange={(next) => setTab(next as PullTab)}
          className="flex min-h-0 flex-1 flex-col"
        >
          <div className={`flex-none ${padded}`}>
            <Tabs.List
              aria-label="Pull request"
              className="mx-auto mt-2 flex max-w-(--content-max) gap-1 overflow-x-auto border-b border-line"
            >
              <Tabs.Trigger value="overview" className={TAB_TRIGGER}>
                Overview
              </Tabs.Trigger>
              <Tabs.Trigger value="files" className={TAB_TRIGGER}>
                Files changed
                <span className="ml-1.5 font-medium text-muted tabular-nums">
                  {files}
                </span>
              </Tabs.Trigger>
              <Tabs.Trigger value="commits" className={TAB_TRIGGER}>
                Commits
                <span className="ml-1.5 font-medium text-muted tabular-nums">
                  {commits}
                </span>
              </Tabs.Trigger>
              <Tabs.Trigger value="activity" className={TAB_TRIGGER}>
                Activity
              </Tabs.Trigger>
              <Tabs.Trigger value="merge" className={TAB_TRIGGER}>
                {pull.status === 'merged' ? 'Revert' : 'Merge'}
              </Tabs.Trigger>
            </Tabs.List>
          </div>
          <Tabs.Content
            value="overview"
            className="flex min-h-0 flex-1 flex-col focus-visible:outline-none"
          >
            {scrolling(
              <OverviewTab
                repo={repo}
                detail={detail.data}
                editing={editing}
                onEditDone={() => setEditing(false)}
              />,
            )}
          </Tabs.Content>
          <Tabs.Content
            value="files"
            className="flex min-h-0 flex-1 flex-col focus-visible:outline-none"
          >
            {width >= 1100 ? (
              <FilesTab
                repo={repo}
                detail={detail.data}
                width={width}
                refreshing={detail.isFetching}
                onRefresh={() => void detail.refetch()}
              />
            ) : (
              scrolling(
                <FilesTab
                  repo={repo}
                  detail={detail.data}
                  width={width}
                  refreshing={detail.isFetching}
                  onRefresh={() => void detail.refetch()}
                />,
              )
            )}
          </Tabs.Content>
          <Tabs.Content
            value="commits"
            className="flex min-h-0 flex-1 flex-col focus-visible:outline-none"
          >
            {scrolling(
              <CommitsTab
                detail={detail.data}
                onShowFiles={() => setTab('files')}
              />,
            )}
          </Tabs.Content>
          <Tabs.Content
            value="activity"
            className="flex min-h-0 flex-1 flex-col focus-visible:outline-none"
          >
            {scrolling(<ActivityTab repo={repo} detail={detail.data} />)}
          </Tabs.Content>
          <Tabs.Content
            value="merge"
            className="flex min-h-0 flex-1 flex-col focus-visible:outline-none"
          >
            {scrolling(<MergeTab repo={repo} detail={detail.data} />)}
          </Tabs.Content>
        </Tabs.Root>
      </div>
    </Page>
  );
}
