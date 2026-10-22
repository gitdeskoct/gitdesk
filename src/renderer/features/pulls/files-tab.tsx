import { useMemo, useState } from 'react';
import type { PullDetail, PullFile } from '../../../shared/pulls';
import type { RepositorySummary } from '../../../shared/repos';
import type { DiffLine } from '../../../shared/workspace';
import { DiffArt, NoResultsArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { EmptyState } from '../../components/ui/empty-state';
import { Segmented } from '../../components/ui/segmented';
import { InlineStatus, Loading } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAddComment,
  usePullComments,
  usePullFileDiff,
  useSetViewed,
  useViewedFiles,
} from '../../lib/pull-queries';
import { useSettings, useUpdateSettings } from '../../lib/queries';
import { DiffBody } from '../repository/diff-view';
import { Composer, Thread, groupThreads } from './comments';

const STATUS_LETTER: Record<PullFile['status'], [string, string]> = {
  added: ['A', 'Added'],
  modified: ['M', 'Modified'],
  deleted: ['D', 'Deleted'],
  renamed: ['R', 'Renamed'],
  copied: ['C', 'Copied'],
  type: ['T', 'Type changed'],
};

const WHOLE_FILE = 1_000_000;

type Target = { path: string; side: 'old' | 'new'; line: number };

export function FilesTab({
  repo,
  detail,
  width,
  refreshing,
  onRefresh,
}: {
  repo: RepositorySummary;
  detail: PullDetail;
  width: number;
  refreshing: boolean;
  onRefresh: () => void;
}) {
  const { pull, comparison } = detail;
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const version = pull.latest?.version ?? null;
  const viewed = useViewedFiles(repo.id, pull.id, version);
  const setViewed = useSetViewed(repo.id, pull.id, version ?? 0);
  const comments = usePullComments(repo.id, pull.id, pull.latest?.version ?? 0);
  const add = useAddComment(repo.id, pull.id);
  const [filter, setFilter] = useState('');
  const [picked, setPicked] = useState<string | null>(null);
  const [full, setFull] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [target, setTarget] = useState<Target | null>(null);
  const files = comparison?.files ?? [];
  const shown = files.filter((f) =>
    f.path.toLowerCase().includes(filter.trim().toLowerCase()),
  );
  const file = files.find((f) => f.path === picked) ?? shown[0] ?? null;
  const split = width >= 1100;
  const diffSplit =
    settings?.diffLayout === 'split' ||
    (settings?.diffLayout !== 'unified' && width >= 1300);
  const seen = new Set(viewed.data ?? []);
  const live = pull.status === 'open';
  const diff = usePullFileDiff(
    file && comparison
      ? {
          repoId: repo.id,
          id: pull.id,
          path: file.path,
          oldPath: file.oldPath,
          base: comparison.mergeBaseOid,
          source: comparison.sourceOid,
          context: expanded ? WHOLE_FILE : (settings?.diffContext ?? 3),
          ignoreWhitespace: settings?.diffIgnoreWhitespace ?? false,
          full,
        }
      : null,
  );

  // Threads anchored to a line of this file in the latest comparison, keyed side:line.
  const threads = useMemo(() => {
    const map = new Map<string, ReturnType<typeof groupThreads>>();
    for (const thread of groupThreads(comments.data ?? [])) {
      const at = thread.root.position;
      if (!at || thread.root.outdated || at.path !== file?.path) continue;
      const key = `${at.side}:${at.line}`;
      map.set(key, [...(map.get(key) ?? []), thread]);
    }
    return map;
  }, [comments.data, file?.path]);
  const outdated = groupThreads(comments.data ?? []).filter(
    (t) => t.root.outdated && t.root.anchor?.path === file?.path,
  );

  if (!comparison)
    return (
      <EmptyState
        art={<DiffArt />}
        title="No changes to show"
        action={
          <Button pending={refreshing} onClick={onRefresh}>
            Compare again
          </Button>
        }
      >
        Git could not compare the branches. The Overview tab says why.
      </EmptyState>
    );
  if (!files.length)
    return (
      <EmptyState
        art={<DiffArt />}
        title="No file changes"
        action={
          <Button pending={refreshing} onClick={onRefresh}>
            Compare again
          </Button>
        }
      >
        The commits on this branch don't change any file.
      </EmptyState>
    );

  const slot = (line: DiffLine) => {
    if (!file) return null;
    const keys = [
      ...(line.new !== null ? [`new:${line.new}`] : []),
      ...(line.kind === 'del' && line.old !== null ? [`old:${line.old}`] : []),
    ];
    const here = keys.flatMap((key) => threads.get(key) ?? []);
    const composing =
      target &&
      target.path === file.path &&
      ((target.side === 'new' && target.line === line.new) ||
        (target.side === 'old' &&
          line.kind === 'del' &&
          target.line === line.old));
    if (!here.length && !composing) return null;
    return (
      <div className="grid gap-4">
        {here.map(({ root, replies }) => (
          <Thread
            key={root.id}
            repoId={repo.id}
            pullId={pull.id}
            root={root}
            replies={replies}
            canReply={live}
          />
        ))}
        {composing && (
          <Composer
            label={`Comment on ${target!.side === 'old' ? 'removed ' : ''}line ${target!.line}`}
            placeholder={`Comment on ${target!.side === 'old' ? 'removed ' : ''}line ${target!.line}`}
            submitLabel="Add comment"
            autoFocus
            pending={add.isPending}
            error={add.error}
            onCancel={() => setTarget(null)}
            onSubmit={(body, done) =>
              add.mutate(
                { body, parentId: null, line: target! },
                {
                  onSuccess: () => {
                    done();
                    setTarget(null);
                  },
                },
              )
            }
          />
        )}
      </div>
    );
  };

  const list = (
    <div
      className={cn(
        'min-w-0',
        split && 'flex min-h-0 flex-col border-r border-line',
      )}
    >
      <div className={cn('pb-2.5', split && 'px-4 pt-3')}>
        <label className="field flex h-8 items-center px-2.5">
          <span className="sr-only">Filter files</span>
          <input
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
            placeholder="Filter files"
            className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-ink outline-none placeholder:text-muted"
          />
        </label>
        <div className="mt-2 flex justify-between text-xs text-muted">
          <span>
            {seen.size} of {files.length} viewed
          </span>
          {version && <span>Snapshot {version}</span>}
        </div>
        <div
          className="mt-1.5 h-1.5 overflow-hidden rounded-[4px] bg-control"
          role="progressbar"
          aria-label="Files viewed"
          aria-valuemin={0}
          aria-valuemax={files.length}
          aria-valuenow={seen.size}
        >
          <div
            className="h-full rounded-[4px] bg-accent"
            style={{ width: `${(seen.size / files.length) * 100}%` }}
          />
        </div>
      </div>
      <ul
        aria-label="Changed files"
        className={cn(
          'border-t border-line',
          split && 'min-h-0 flex-1 overflow-auto',
        )}
      >
        {!shown.length && (
          <li>
            <EmptyState
              compact
              art={<NoResultsArt />}
              title={`No file matches "${filter}"`}
              action={
                <Button size="sm" onClick={() => setFilter('')}>
                  Clear filter
                </Button>
              }
            >
              Try part of a folder or file name.
            </EmptyState>
          </li>
        )}
        {shown.map((f) => {
          const [letter, word] = STATUS_LETTER[f.status];
          const current = f === file;
          return (
            <li
              key={f.path}
              className={cn(
                'flex items-center gap-2.5 border-b border-line px-4 py-2',
                current ? 'bg-accent-soft' : 'hover:bg-row-hover',
              )}
            >
              <Checkbox
                aria-label={`Viewed ${f.path}`}
                checked={seen.has(f.path)}
                disabled={!version}
                onCheckedChange={(value) =>
                  setViewed.mutate({ path: f.path, viewed: value === true })
                }
              />
              <button
                type="button"
                aria-current={current || undefined}
                onClick={() => {
                  setPicked(f.path);
                  setFull(false);
                  setExpanded(false);
                  setTarget(null);
                }}
                className="min-w-0 flex-1 truncate text-left font-mono text-[0.78125rem] text-ink focus-visible:outline-offset-2"
                title={f.oldPath ? `${f.oldPath} → ${f.path}` : f.path}
              >
                {f.path}
              </button>
              <span className="shrink-0 text-xs text-muted tabular-nums">
                {f.binary ? 'Binary' : `+${f.added ?? 0} −${f.removed ?? 0}`}
              </span>
              <span
                title={word}
                className="inline-flex h-5 w-6 shrink-0 items-center justify-center rounded-[4px] border border-line bg-sunken text-[0.71875rem] font-medium text-ink"
              >
                <span aria-hidden>{letter}</span>
                <span className="sr-only">{word}</span>
              </span>
            </li>
          );
        })}
      </ul>
      {comparison.filesTruncated && (
        <p className="px-4 py-2 text-xs text-muted">
          Only the first 3,000 files are listed.
        </p>
      )}
    </div>
  );

  let body;
  if (!file) body = null;
  else if (diff.isPending)
    body = <Loading label={`Loading the diff of ${file.path}…`} />;
  else if (diff.isError)
    body = (
      <InlineStatus
        tone="danger"
        action={
          <Button
            size="sm"
            pending={diff.isFetching}
            onClick={() => void diff.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(diff.error, "The diff didn't load.")}
      </InlineStatus>
    );
  else if (diff.data.status === 'binary')
    body = (
      <EmptyState
        compact
        art={<DiffArt />}
        title="Binary file"
        action={
          <Button size="sm" onClick={() => setPicked(null)}>
            Back to the first file
          </Button>
        }
      >
        Git doesn't show a text diff for this file.
      </EmptyState>
    );
  else if (diff.data.status === 'too-large')
    body = (
      <EmptyState
        compact
        art={<DiffArt />}
        title={`This file changed by ${(diff.data.added + diff.data.removed).toLocaleString()} lines`}
        action={
          <Button size="sm" onClick={() => setFull(true)}>
            Show the diff anyway
          </Button>
        }
      >
        Showing it all may be slow. The rest of the review is unaffected.
      </EmptyState>
    );
  else if (diff.data.status === 'empty')
    body = (
      <EmptyState
        compact
        art={<DiffArt />}
        title="No text change"
        action={
          <Button size="sm" onClick={() => setPicked(null)}>
            Back to the first file
          </Button>
        }
      >
        {diff.data.modeChange
          ? `Only the file mode changed (${diff.data.modeChange}).`
          : 'Only whitespace changed, and whitespace is hidden in Settings.'}
      </EmptyState>
    );
  else
    body = (
      <div className="flex min-h-0 flex-col overflow-hidden rounded-sm border border-line">
        <DiffBody
          diff={diff.data}
          path={file.path}
          settings={settings}
          split={diffSplit}
          onExpand={expanded ? null : () => setExpanded(true)}
          maxHeight={split ? undefined : 'max-h-[70vh]'}
          lineSlot={slot}
          onLineComment={
            live && version
              ? (line, side) =>
                  setTarget({
                    path: file.path,
                    side,
                    line: (side === 'new' ? line.new : line.old) ?? 0,
                  })
              : undefined
          }
        />
      </div>
    );

  const header = file && (
    <div className="flex flex-wrap items-center gap-2.5 pb-2.5">
      <span className="min-w-0 truncate font-mono text-[0.8125rem] font-semibold text-ink">
        {file.path}
      </span>
      <span className="text-xs text-muted">
        {STATUS_LETTER[file.status][1]}
        {!file.binary && ` · +${file.added ?? 0} −${file.removed ?? 0}`}
      </span>
      <span className="ml-auto flex items-center gap-2.5">
        <Segmented
          label="Diff layout"
          value={diffSplit ? 'split' : 'unified'}
          options={[
            { value: 'unified', label: 'Unified' },
            { value: 'split', label: 'Split' },
          ]}
          onChange={(value) => updateSettings.mutate({ diffLayout: value })}
        />
        <label className="flex items-center gap-2 text-[0.8125rem] text-ink">
          <Checkbox
            checked={seen.has(file.path)}
            disabled={!version}
            onCheckedChange={(value) =>
              setViewed.mutate({ path: file.path, viewed: value === true })
            }
          />
          Viewed
        </label>
      </span>
    </div>
  );

  const extras = (
    <>
      {live && version && (
        <p className="mt-2 text-xs text-muted">
          Select a line number to comment on that line.
        </p>
      )}
      {outdated.length > 0 && (
        <section aria-label="Outdated comments" className="mt-5">
          <h3 className="text-[0.8125rem] font-semibold text-ink">
            Outdated on this file
          </h3>
          <p className="text-xs text-muted">
            Their lines changed after they were written, so they no longer point
            anywhere.
          </p>
          {outdated.map(({ root, replies }) => (
            <div key={root.id} className="mt-3 border-t border-line pt-3">
              <Thread
                repoId={repo.id}
                pullId={pull.id}
                root={root}
                replies={replies}
                canReply={live}
              />
            </div>
          ))}
        </section>
      )}
    </>
  );

  if (split)
    return (
      <div className="grid min-h-0 flex-1 grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)]">
        {list}
        <div className="flex min-h-0 flex-col overflow-auto px-6 py-4">
          {header}
          {body}
          {extras}
        </div>
      </div>
    );
  return (
    <div className="grid gap-6 pt-5">
      {list}
      <div className="min-w-0">
        {header}
        {body}
        {extras}
      </div>
    </div>
  );
}
