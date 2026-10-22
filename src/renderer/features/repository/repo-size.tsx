import { RefreshCw } from 'lucide-react';
import type { RepositorySummary } from '../../../shared/repos';
import { OfflineArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { InlineStatus, Loading } from '../../components/ui/status';
import { Tooltip } from '../../components/ui/tooltip';
import { formatBytes, relativeTime, useNow } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useMeasureRepo, useRepoSize } from '../../lib/queries';

const percent = (part: number, whole: number) =>
  whole > 0 ? Math.round((part / whole) * 100) : 0;

// Where the folder's bytes are: Git's own data, the files in the last commit, and everything else
// on disk (untracked and ignored files, unsaved edits). Measured by main, read only.
export function RepoSizeSection({ repo }: { repo: RepositorySummary }) {
  useNow(30_000);
  const size = useRepoSize(repo.id, repo.statusAt);
  const measure = useMeasureRepo(repo.id, repo.statusAt);
  const data = size.data;

  const again = (
    <Button
      size="sm"
      pending={measure.isPending}
      onClick={() => measure.mutate()}
    >
      {!measure.isPending && <RefreshCw />}
      Measure again
    </Button>
  );

  let body;
  if (size.isPending)
    body = <Loading label="Measuring this repository on disk…" />;
  else if (size.isError || !data)
    body = (
      <EmptyState
        compact
        art={<OfflineArt />}
        title="Couldn't measure this repository"
        action={
          <Button
            size="sm"
            pending={size.isFetching}
            onClick={() => void size.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(size.error, 'The folder could not be read.')}
      </EmptyState>
    );
  else {
    const parts = [
      {
        key: 'git',
        label: 'Git history',
        bytes: data.git,
        fill: 'bg-chart-1',
        context: `.git · ${data.objects.packs} ${data.objects.packs === 1 ? 'pack' : 'packs'}, ${data.objects.loose.toLocaleString()} loose objects`,
      },
      {
        key: 'tracked',
        label: 'Tracked files',
        bytes: data.tracked,
        fill: 'bg-chart-2',
        context: `${data.trackedFiles.toLocaleString()} files in the last commit`,
      },
      {
        key: 'other',
        label: 'Everything else',
        bytes: data.other,
        fill: 'bg-faint',
        context: 'Untracked and ignored files, and unsaved edits',
      },
    ];
    const biggest = parts.reduce((a, b) => (b.bytes > a.bytes ? b : a));
    const largestMax = Math.max(1, ...data.largest.map((f) => f.bytes));
    body = (
      <>
        <div
          role="group"
          aria-label="Repository size"
          className="grid grid-cols-2 border-y border-line @min-[640px]:grid-cols-4"
        >
          <div className="py-3.5 pr-4">
            <div className="text-[1.625rem] leading-8 font-semibold tracking-[-0.02em] text-ink">
              {formatBytes(data.total)}
            </div>
            <div className="text-[0.8125rem] font-medium text-ink">On disk</div>
            <div className="truncate text-xs text-muted">
              {data.workingFiles.toLocaleString()} files in the folder
            </div>
          </div>
          {parts.map((part) => (
            <div key={part.key} className="border-l border-line px-4 py-3.5">
              <div className="text-[1.625rem] leading-8 font-semibold tracking-[-0.02em] text-ink">
                {formatBytes(part.bytes)}
              </div>
              <div className="flex items-center gap-1.5 text-[0.8125rem] font-medium text-ink">
                <span
                  aria-hidden
                  className={`size-2.5 rounded-[2px] ${part.fill}`}
                />
                {part.label}
              </div>
              <div className="truncate text-xs text-muted" title={part.context}>
                {part.context}
              </div>
            </div>
          ))}
        </div>
        <div
          role="img"
          aria-label={parts
            .map((p) => `${p.label} ${percent(p.bytes, data.total)}%`)
            .join(', ')}
          className="mt-3.5 flex h-3 gap-0.5"
        >
          {parts
            .filter((part) => part.bytes > 0)
            .map((part, i, shown) => (
              <Tooltip
                key={part.key}
                label={`${part.label}: ${formatBytes(part.bytes)}, ${percent(part.bytes, data.total)}%`}
                side="top"
              >
                <span
                  className={`${part.fill} ${i === 0 ? 'rounded-l-[4px]' : ''} ${i === shown.length - 1 ? 'rounded-r-[4px]' : ''}`}
                  style={{ flexGrow: part.bytes, flexBasis: 0, minWidth: 3 }}
                />
              </Tooltip>
            ))}
        </div>
        <p className="mt-2 text-[0.8125rem] text-muted">
          {data.total
            ? `${biggest.label} takes the most space, ${percent(biggest.bytes, data.total)}% of the folder. Git history is ${percent(data.git, data.total)}%.`
            : 'The folder is empty.'}
        </p>
        {data.truncated && (
          <InlineStatus className="mt-2">
            The folder is very large, so gitdesk stopped counting at 300,000
            entries or 15 seconds. These are lower bounds.
          </InlineStatus>
        )}
        {data.largest.length > 0 && (
          <>
            <h3 className="mt-5 mb-1.5 text-[0.8125rem] font-semibold text-ink">
              Largest tracked files
            </h3>
            <ol className="border-t border-line">
              {data.largest.map((file) => (
                <li
                  key={file.path}
                  className="grid h-9 grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_4.5rem] items-center gap-3 border-b border-line"
                >
                  <span
                    className="truncate font-mono text-[0.78125rem] text-ink"
                    title={file.path}
                  >
                    {file.path}
                  </span>
                  <span
                    aria-hidden
                    className="block h-2 rounded-r-[4px] bg-chart-2"
                    style={{
                      width: `${Math.max(2, (file.bytes / largestMax) * 100)}%`,
                    }}
                  />
                  <span className="text-right text-xs text-ink tabular-nums">
                    {formatBytes(file.bytes)}
                  </span>
                </li>
              ))}
            </ol>
          </>
        )}
      </>
    );
  }

  return (
    <section aria-labelledby="repo-size-heading" className="@container">
      <div className="mb-2 flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
        <h2
          id="repo-size-heading"
          className="text-[0.9375rem] font-semibold text-ink"
        >
          How much space does it take?
        </h2>
        <span className="flex items-center gap-2.5 text-xs text-muted">
          {data &&
            `Measured ${relativeTime(data.measuredAt)}, updates as files change`}
          {again}
        </span>
      </div>
      {body}
    </section>
  );
}
