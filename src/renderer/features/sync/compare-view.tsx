import { ArrowLeft, GitBranch } from 'lucide-react';
import { useState } from 'react';
import type { Comparison } from '../../../shared/pulls';
import type { RepositorySummary } from '../../../shared/repos';
import { DiffArt, OfflineArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { Segmented } from '../../components/ui/segmented';
import { InlineStatus, Loading } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useSettings } from '../../lib/queries';
import { useSyncCompare, useSyncFileDiff } from '../../lib/sync-queries';
import { plural, shortOid } from '../pulls/pull-bits';
import { AuthorAvatar } from '../repository/author-avatar';
import { DiffBody } from '../repository/diff-view';

type Side = 'outgoing' | 'incoming';

function Commits({
  title,
  sub,
  comparison,
  empty,
}: {
  title: string;
  sub: string;
  comparison: Comparison | null;
  empty: string;
}) {
  const commits = comparison ? [...comparison.commits].reverse() : [];
  return (
    <section aria-label={title} className="min-w-0 px-5 py-4">
      <h3 className="text-[0.8125rem] font-semibold text-ink">{title}</h3>
      <p className="mt-0.5 mb-2 text-xs text-muted">{sub}</p>
      {commits.length ? (
        <ul>
          {commits.map((commit) => (
            <li
              key={commit.oid}
              className="grid grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-x-2.5 border-b border-line py-2"
            >
              <AuthorAvatar name={commit.author} email={commit.email} />
              <span className="min-w-0">
                <span className="block truncate text-[0.8125rem] text-ink">
                  {commit.subject || '(no message)'}
                </span>
                <span className="block truncate text-xs text-muted">
                  {commit.author} · {relativeTime(commit.at)}
                </span>
              </span>
              <span className="font-mono text-xs text-muted">
                {shortOid(commit.oid)}
              </span>
            </li>
          ))}
          {comparison?.commitsTruncated && (
            <li className="pt-2 text-xs text-muted">
              Showing the newest commits only.
            </li>
          )}
        </ul>
      ) : (
        <p className="text-[0.8125rem] text-muted">{empty}</p>
      )}
    </section>
  );
}

// Split by default: what only this branch has beside what only the upstream has, then the files
// of either side with their diff. Narrow windows stack the two lists.
export function CompareView({
  repo,
  width,
  onBack,
}: {
  repo: RepositorySummary;
  width: number;
  onBack: () => void;
}) {
  const compare = useSyncCompare(repo.id, repo.statusAt, true);
  const { data: settings } = useSettings();
  const [side, setSide] = useState<Side>('outgoing');
  const [picked, setPicked] = useState<string | null>(null);
  const [expanded, setExpanded] = useState(false);
  const data = compare.data;
  const comparison = data
    ? side === 'outgoing'
      ? data.outgoing
      : data.incoming
    : null;
  const files = comparison?.files ?? [];
  const file = files.find((f) => f.path === picked) ?? files[0] ?? null;
  const diff = useSyncFileDiff(
    file
      ? {
          id: repo.id,
          side,
          path: file.path,
          oldPath: file.oldPath,
          context: expanded ? 1_000_000 : (settings?.diffContext ?? 3),
          ignoreWhitespace: settings?.diffIgnoreWhitespace ?? false,
          full: false,
        }
      : null,
    repo.statusAt,
  );

  const header = (
    <div className="mb-3 flex flex-wrap items-center gap-3 pt-5">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft />
        Back to Sync
      </Button>
      <h2 className="flex min-w-0 flex-1 items-center gap-1.5 text-[1rem] font-semibold text-ink">
        <GitBranch aria-hidden className="size-4 text-muted" />
        Compare {repo.status?.branch ?? 'this branch'} with{' '}
        {data?.upstream ?? 'its upstream'}
      </h2>
    </div>
  );
  if (compare.isPending)
    return (
      <>
        {header}
        <Loading label="Reading the commits on both sides…" />
      </>
    );
  if (compare.isError)
    return (
      <>
        {header}
        <EmptyState
          art={<OfflineArt />}
          title="Couldn't compare the branches"
          action={
            <Button
              pending={compare.isFetching}
              onClick={() => void compare.refetch()}
            >
              Try again
            </Button>
          }
        >
          {ipcErrorMessage(compare.error, 'Git did not answer.')}
        </EmptyState>
      </>
    );
  const result = compare.data;
  const outCount = result.outgoing?.commits.length ?? 0;
  const inCount = result.incoming?.commits.length ?? 0;
  if (!outCount && !inCount)
    return (
      <>
        {header}
        <EmptyState
          art={<DiffArt />}
          title="Nothing to compare"
          action={<Button onClick={onBack}>Back to Sync</Button>}
        >
          {repo.status?.branch} and {result.upstream} hold the same commits, as
          of the last fetch.
        </EmptyState>
      </>
    );

  let body;
  if (!file)
    body = (
      <EmptyState
        compact
        art={<DiffArt />}
        title="No file changes on this side"
        action={
          <Button
            size="sm"
            onClick={() =>
              setSide(side === 'outgoing' ? 'incoming' : 'outgoing')
            }
          >
            Show the other side
          </Button>
        }
      >
        Its commits change no files compared with the shared history.
      </EmptyState>
    );
  else if (diff.isPending) body = <Loading label="Reading the diff…" />;
  else if (diff.isError)
    body = (
      <InlineStatus tone="danger">
        {ipcErrorMessage(diff.error, "Couldn't read this file's diff.")}
      </InlineStatus>
    );
  else if (diff.data.status === 'text' && diff.data.hunks.length)
    body = (
      <div className="flex min-h-0 flex-col overflow-hidden rounded-sm border border-line">
        <DiffBody
          diff={diff.data}
          path={file.path}
          settings={settings}
          split={
            settings?.diffLayout === 'split' ||
            (settings?.diffLayout !== 'unified' && width >= 1300)
          }
          onExpand={expanded ? null : () => setExpanded(true)}
          maxHeight="max-h-[60vh]"
        />
      </div>
    );
  else
    body = (
      <InlineStatus>
        {diff.data.status === 'binary'
          ? 'Binary file: no text view.'
          : diff.data.status === 'too-large'
            ? `Too large to show here (+${diff.data.added} −${diff.data.removed}).`
            : 'No text change.'}
      </InlineStatus>
    );

  return (
    <div>
      {header}
      <div
        className={cn(
          'grid border-y border-line',
          width >= 860
            ? 'grid-cols-2 [&>section+section]:border-l'
            : 'grid-cols-1 [&>section+section]:border-t',
          '[&>section]:border-line',
        )}
      >
        <Commits
          title={`Only on ${repo.status?.branch ?? 'this branch'}`}
          sub={`${plural(outCount, 'commit')} to push. On this computer only.`}
          comparison={result.outgoing}
          empty="Nothing to push."
        />
        <Commits
          title={`Only on ${result.upstream}`}
          sub={`${plural(inCount, 'commit')} to pull. Fetched, not in your branch yet.`}
          comparison={result.incoming}
          empty="Nothing to pull."
        />
      </div>
      {(result.outgoing ?? result.incoming)?.mergeBaseOid && (
        <p className="mt-2 text-xs text-muted">
          Shared history ends at{' '}
          <span className="font-mono">
            {shortOid((result.outgoing ?? result.incoming)!.mergeBaseOid)}
          </span>
        </p>
      )}

      <div className="mt-6 flex flex-wrap items-center gap-3">
        <h3 className="flex-1 text-[0.9375rem] font-semibold text-ink">
          Files
        </h3>
        <Segmented
          label="Which side's files"
          value={side}
          onChange={(next) => {
            setSide(next);
            setPicked(null);
            setExpanded(false);
          }}
          options={[
            { value: 'outgoing', label: 'Yours to push' },
            { value: 'incoming', label: 'Incoming' },
          ]}
        />
      </div>
      <div
        className={cn(
          'mt-3 grid gap-4',
          width >= 960 && 'grid-cols-[16rem_minmax(0,1fr)]',
        )}
      >
        {files.length > 0 && (
          <ul aria-label="Changed files" className="border-t border-line">
            {files.map((f) => (
              <li key={f.path} className="border-b border-line">
                <button
                  type="button"
                  aria-current={f === file || undefined}
                  onClick={() => {
                    setPicked(f.path);
                    setExpanded(false);
                  }}
                  className={cn(
                    'grid w-full grid-cols-[minmax(0,1fr)_auto] gap-2 px-2.5 py-2 text-left focus-visible:outline-offset-[-2px]',
                    f === file ? 'bg-accent-soft' : 'hover:bg-row-hover',
                  )}
                >
                  <span
                    className="truncate font-mono text-[0.78125rem] text-ink"
                    title={f.path}
                  >
                    {f.path}
                  </span>
                  <span className="text-xs text-ink tabular-nums">
                    {f.added === null ? 'Binary' : `+${f.added} −${f.removed}`}
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        <div className="min-w-0">{body}</div>
      </div>
    </div>
  );
}
