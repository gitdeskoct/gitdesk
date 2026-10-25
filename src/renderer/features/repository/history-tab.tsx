import { useQueryClient } from '@tanstack/react-query';
import { GitCommitHorizontal } from 'lucide-react';
import { useState, type KeyboardEvent } from 'react';
import type { RepositorySummary } from '../../../shared/repos';
import type { CommitRow } from '../../../shared/workspace';
import {
  CommitsArt,
  DiffArt,
  OfflineArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { CopyButton } from '../../components/ui/copy-button';
import { EmptyState } from '../../components/ui/empty-state';
import { InlineStatus, Loading } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import { formatDate, relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useCommitDetail, useHistoryLog } from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { AuthorAvatar, useMyEmails } from './author-avatar';

function CommitDetailView({
  repoId,
  oid,
  onPick,
}: {
  repoId: string;
  oid: string;
  onPick: (oid: string) => void;
}) {
  const detail = useCommitDetail(repoId, oid);
  const mine = useMyEmails();
  const { navigate } = useNavigation();
  if (detail.isPending) return <Loading label="Reading the commit…" />;
  if (detail.isError)
    return (
      <EmptyState
        compact
        art={<OfflineArt />}
        title="Couldn't read this commit"
        action={
          <Button
            size="sm"
            pending={detail.isFetching}
            onClick={() => void detail.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(detail.error, 'Git did not answer.')}
      </EmptyState>
    );
  const commit = detail.data;
  const [subject = '', ...rest] = commit.message.split('\n');
  const body = rest.join('\n').trim();
  const added = commit.files.reduce((sum, f) => sum + (f.added ?? 0), 0);
  const removed = commit.files.reduce((sum, f) => sum + (f.removed ?? 0), 0);
  return (
    <article aria-labelledby={`commit-${commit.oid}`}>
      <h2
        id={`commit-${commit.oid}`}
        className="text-[1.0625rem] font-semibold tracking-[-0.01em] text-ink"
      >
        {subject || '(no message)'}
      </h2>
      {body && (
        <p className="mt-2 text-sm leading-relaxed whitespace-pre-line text-muted">
          {body}
        </p>
      )}
      <dl className="mt-5 grid grid-cols-[7rem_minmax(0,1fr)] gap-x-4 gap-y-2.5 border-y border-line py-3 text-[0.8125rem]">
        <dt className="text-muted">Commit</dt>
        <dd className="flex min-w-0 items-center gap-2">
          <span className="truncate font-mono text-[0.78125rem] text-ink">
            {commit.oid}
          </span>
          <CopyButton value={commit.oid} label="commit hash" />
        </dd>
        <dt className="text-muted">Author</dt>
        <dd className="flex min-w-0 items-center gap-2 text-ink">
          <AuthorAvatar name={commit.author} email={commit.email} />
          <span className="min-w-0">
            {commit.author || 'Unknown'}{' '}
            <span className="text-muted">
              ·{' '}
              {mine.has(commit.email.toLowerCase())
                ? 'your commit, matched by email'
                : 'from Git settings, not verified'}
            </span>
          </span>
        </dd>
        <dt className="text-muted">Date</dt>
        <dd className="text-ink">
          {formatDate(commit.at)} · {relativeTime(commit.at)}
        </dd>
        <dt className="text-muted">
          {commit.parents.length === 1 ? 'Parent' : 'Parents'}
        </dt>
        <dd className="flex flex-wrap gap-3">
          {commit.parents.length === 0 && (
            <span className="text-muted">None, this is the first commit</span>
          )}
          {commit.parents.map((parent) => (
            <Button
              key={parent}
              variant="link"
              className="font-mono text-[0.78125rem]"
              onClick={() => onPick(parent)}
            >
              {parent.slice(0, 7)}
            </Button>
          ))}
        </dd>
      </dl>
      <div className="mt-5 mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
        <h3 className="text-[0.9375rem] font-semibold text-ink">
          {commit.files.length} {commit.files.length === 1 ? 'file' : 'files'}{' '}
          changed
        </h3>
        <span className="text-xs text-muted">
          <b className="font-semibold text-ink">+{added}</b>{' '}
          <b className="font-semibold text-ink">−{removed}</b> lines
        </span>
      </div>
      {!commit.files.length && commit.parents[0] && (
        <EmptyState
          compact
          className="border-t border-line"
          art={<DiffArt />}
          title="No file changes"
          action={
            <Button size="sm" onClick={() => onPick(commit.parents[0]!)}>
              Open its parent
            </Button>
          }
        >
          This commit changes no files compared with its first parent, like an
          empty commit or a merge that took one side whole.
        </EmptyState>
      )}
      <ul
        className={cn('border-t border-line', !commit.files.length && 'hidden')}
      >
        {commit.files.map((file) => (
          <li
            key={`${file.oldPath ?? ''}:${file.path}`}
            className="grid grid-cols-[minmax(0,1fr)_auto] gap-3 border-b border-line py-2"
          >
            <span className="min-w-0 truncate font-mono text-[0.78125rem] text-ink">
              {/* Opens the file as this commit left it, in Files. */}
              <button
                type="button"
                title={`Open ${file.path} at ${commit.oid.slice(0, 7)} in Files`}
                className="rounded-[4px] text-left hover:underline focus-visible:outline-offset-0"
                onClick={() =>
                  navigate({
                    name: 'repository',
                    id: repoId,
                    tab: 'source',
                    source: { path: file.path, ref: commit.oid },
                  })
                }
              >
                {file.path}
              </button>
              {file.oldPath && (
                <span className="text-muted"> from {file.oldPath}</span>
              )}
            </span>
            <span className="text-xs text-ink tabular-nums">
              {file.added === null ? (
                <span className="text-muted">Binary</span>
              ) : (
                `+${file.added} −${file.removed}`
              )}
            </span>
          </li>
        ))}
      </ul>
      {commit.filesTruncated && (
        <p className="mt-2 text-xs text-muted">Showing the first 500 files.</p>
      )}
    </article>
  );
}

function CommitItem({
  commit,
  selected,
  focusable,
  onSelect,
}: {
  commit: CommitRow;
  selected: boolean;
  focusable: boolean;
  onSelect: () => void;
}) {
  return (
    <li
      role="option"
      aria-selected={selected}
      tabIndex={focusable ? 0 : -1}
      data-oid={commit.oid}
      onClick={onSelect}
      className={cn(
        'grid cursor-default grid-cols-[1.75rem_minmax(0,1fr)] items-center gap-x-2.5 border-b border-line py-2.5 pr-3 pl-3 outline-offset-[-2px] transition-colors',
        selected ? 'bg-accent-soft' : 'hover:bg-row-hover',
      )}
    >
      <AuthorAvatar name={commit.author} email={commit.email} />
      <span className="grid min-w-0 gap-0.5">
        <span className="truncate text-[0.84375rem] font-medium text-ink">
          {commit.subject || '(no message)'}
        </span>
        <span className="truncate text-xs text-muted">
          <span className="font-mono">{commit.oid.slice(0, 7)}</span> ·{' '}
          {commit.author} · {relativeTime(commit.at)}
          {commit.parents.length > 1
            ? ` · ${commit.parents.length} parents`
            : ''}
          {commit.refs.length > 0 && ` · ${commit.refs.join(', ')}`}
        </span>
      </span>
    </li>
  );
}

export function HistoryTab({
  repo,
  layout,
}: {
  repo: RepositorySummary;
  layout: 'split' | 'centered' | 'narrow';
}) {
  const qc = useQueryClient();
  const { navigate } = useNavigation();
  const log = useHistoryLog(repo.id, null);
  const [selected, setSelected] = useState<string | null>(null);
  const commits = log.data?.pages.flatMap((page) => page.commits) ?? [];
  const snapshot = log.data?.pages[0]?.snapshot ?? null;
  const head = repo.status?.headOid ?? null;
  const moved = !!snapshot && !!head && head !== snapshot;
  const current = selected ?? commits[0]?.oid ?? null;

  const showLatest = () => {
    setSelected(null);
    void qc.resetQueries({ queryKey: ['ws-log', repo.id] });
  };
  const move = (event: KeyboardEvent<HTMLUListElement>) => {
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const index = Math.max(
      0,
      commits.findIndex((c) => c.oid === current),
    );
    const next =
      commits[
        Math.min(
          commits.length - 1,
          Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)),
        )
      ];
    if (!next) return;
    setSelected(next.oid);
    requestAnimationFrame(() =>
      document.querySelector<HTMLElement>(`[data-oid="${next.oid}"]`)?.focus(),
    );
  };

  if (log.isPending)
    return (
      <div className="px-6">
        <Loading label="Reading history…" />
      </div>
    );
  if (log.isError)
    return (
      <EmptyState
        art={<OfflineArt />}
        title="Couldn't read the history"
        action={
          /rewritten/i.test(String(log.error)) ? (
            <Button onClick={showLatest}>Show latest</Button>
          ) : (
            <Button pending={log.isFetching} onClick={() => void log.refetch()}>
              Try again
            </Button>
          )
        }
      >
        {ipcErrorMessage(log.error, 'Git did not answer.')}
      </EmptyState>
    );
  if (!commits.length)
    return (
      <EmptyState
        art={<CommitsArt />}
        title="No commits yet"
        action={
          <Button
            onClick={() =>
              navigate({ name: 'repository', id: repo.id, tab: 'changes' })
            }
          >
            Go to Changes
          </Button>
        }
      >
        History starts with your first commit. Stage files on Changes to make
        it.
      </EmptyState>
    );

  const list = (
    <>
      {moved && (
        <InlineStatus
          className="bg-accent-soft px-3 py-2.5"
          action={
            <Button size="sm" className="bg-surface" onClick={showLatest}>
              Show latest
            </Button>
          }
        >
          {repo.status?.branch ?? 'HEAD'} has moved since this list was read.
        </InlineStatus>
      )}
      <p className="border-b border-line px-3 py-2 text-xs text-muted">
        {repo.status?.branch ?? 'HEAD'} at{' '}
        <span className="font-mono">{snapshot?.slice(0, 7)}</span> · newest
        first · 50 at a time
      </p>
      <ul role="listbox" aria-label="Commits" onKeyDown={move}>
        {commits.map((commit) => (
          <CommitItem
            key={commit.oid}
            commit={commit}
            selected={
              layout !== 'centered'
                ? commit.oid === current
                : commit.oid === selected
            }
            focusable={commit.oid === current}
            onSelect={() =>
              setSelected(
                layout === 'centered' && selected === commit.oid
                  ? null
                  : commit.oid,
              )
            }
          />
        ))}
      </ul>
      <div className="flex items-center gap-3 px-3 py-3">
        {log.hasNextPage ? (
          <Button
            size="sm"
            pending={log.isFetchingNextPage}
            onClick={() => void log.fetchNextPage()}
          >
            {!log.isFetchingNextPage && <GitCommitHorizontal />}
            Load 50 more
          </Button>
        ) : (
          <span className="text-xs text-muted">That's the first commit.</span>
        )}
        <span className="text-xs text-muted">Showing {commits.length}</span>
      </div>
    </>
  );

  if (layout === 'centered')
    return (
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-10 min-[1100px]:px-10">
        <div className="mx-auto mt-6 max-w-(--content-max) border-t border-line">
          {list}
          {selected && (
            <div className="mt-6 border-t border-line pt-6">
              <CommitDetailView
                repoId={repo.id}
                oid={selected}
                onPick={setSelected}
              />
            </div>
          )}
        </div>
      </div>
    );

  return (
    <div
      className={cn(
        'grid min-h-0 flex-1',
        layout === 'split'
          ? 'grid-cols-[minmax(20rem,26rem)_minmax(0,1fr)]'
          : 'grid-cols-1',
      )}
    >
      <div
        className={cn(
          'min-h-0 overflow-auto',
          layout === 'split' && 'border-r border-line',
        )}
      >
        {list}
      </div>
      {layout === 'split' && current && (
        <div className="min-h-0 overflow-auto px-8 py-6">
          <CommitDetailView
            repoId={repo.id}
            oid={current}
            onPick={setSelected}
          />
        </div>
      )}
    </div>
  );
}
