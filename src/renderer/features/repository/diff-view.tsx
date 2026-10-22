import { useVirtualizer } from '@tanstack/react-virtual';
import { ArrowDown, ArrowUp, FolderOpen, UnfoldVertical } from 'lucide-react';
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import type { Settings } from '../../../shared/settings';
import type {
  DiffHunk,
  DiffLine,
  DiffResult,
  DiffSide,
} from '../../../shared/workspace';
import { DiffArt, OfflineArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { Segmented } from '../../components/ui/segmented';
import { Loading } from '../../components/ui/status';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/cn';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useDiff,
  useRevealFile,
  useSettings,
  useUpdateSettings,
} from '../../lib/queries';
import { fileManagerLabel } from '../repos/repo-actions';
import { OpenInEditorButton } from './editor-button';
import { languageOf, tokenizeLines, type CodeToken } from './highlight';
import { wordRanges, type Range } from './word-diff';

const WHOLE_FILE = 1_000_000;
const VIRTUALIZE_FROM = 400;

type Row =
  | { type: 'hunk'; header: string; hunk: number }
  | { type: 'gap'; hidden: number | null }
  | { type: 'line'; hunk: number; index: number; line: DiffLine }
  | {
      type: 'pair';
      hunk: number;
      left: { index: number; line: DiffLine } | null;
      right: { index: number; line: DiffLine } | null;
    };

const SIGN: Record<DiffLine['kind'], { glyph: string; label: string }> = {
  add: { glyph: '+', label: 'Added' },
  del: { glyph: '−', label: 'Removed' },
  context: { glyph: ' ', label: 'Unchanged' },
  conflict: { glyph: '!', label: 'Conflict marker' },
};

const ROW_TINT: Record<DiffLine['kind'], string> = {
  add: 'bg-diff-add',
  del: 'bg-diff-del',
  context: '',
  conflict: 'bg-warning-soft',
};

// Conflict markers say what they mark, so the meaning never rests on the tint.
function markerLabel(text: string): string {
  if (text.startsWith('<<<<<<<')) return 'Your side starts';
  if (text.startsWith('|||||||')) return 'Common base starts';
  if (text.startsWith('=======')) return 'Their side starts';
  return 'Conflict ends';
}

// Lines hidden between two hunks, from where one ends to where the next starts.
function gapBefore(hunks: DiffHunk[], index: number): number | null {
  const hunk = hunks[index]!;
  if (index === 0) return hunk.newStart > 1 ? hunk.newStart - 1 : null;
  const previous = hunks[index - 1]!;
  const lastNew = [...previous.lines]
    .reverse()
    .find((l) => l.new !== null)?.new;
  if (!lastNew) return null;
  const hidden = hunk.newStart - lastNew - 1;
  return hidden > 0 ? hidden : null;
}

function buildRows(hunks: DiffHunk[], split: boolean): Row[] {
  const rows: Row[] = [];
  hunks.forEach((hunk, h) => {
    const hidden = gapBefore(hunks, h);
    if (hidden) rows.push({ type: 'gap', hidden });
    rows.push({ type: 'hunk', header: hunk.header, hunk: h });
    if (!split) {
      hunk.lines.forEach((line, index) =>
        rows.push({ type: 'line', hunk: h, index, line }),
      );
      return;
    }
    // Side by side: removed lines pair with the added lines that follow them.
    for (let i = 0; i < hunk.lines.length; ) {
      const line = hunk.lines[i]!;
      if (line.kind === 'context' || line.kind === 'conflict') {
        rows.push({
          type: 'pair',
          hunk: h,
          left: { index: i, line },
          right: { index: i, line },
        });
        i++;
        continue;
      }
      const dels: number[] = [];
      while (i < hunk.lines.length && hunk.lines[i]!.kind === 'del')
        dels.push(i++);
      const adds: number[] = [];
      while (i < hunk.lines.length && hunk.lines[i]!.kind === 'add')
        adds.push(i++);
      for (let k = 0; k < Math.max(dels.length, adds.length); k++)
        rows.push({
          type: 'pair',
          hunk: h,
          left:
            dels[k] !== undefined
              ? { index: dels[k]!, line: hunk.lines[dels[k]!]! }
              : null,
          right:
            adds[k] !== undefined
              ? { index: adds[k]!, line: hunk.lines[adds[k]!]! }
              : null,
        });
    }
  });
  return rows;
}

// Tokens for every line of every hunk: each side of a hunk is tokenized as one block, so
// comments and strings that span lines are colored right.
function useHighlighted(
  diff: DiffResult | undefined,
  path: string,
  settings: Settings | undefined,
): (CodeToken[] | null)[][] | null {
  const [result, setResult] = useState<{
    diff: DiffResult;
    tokens: (CodeToken[] | null)[][];
  } | null>(null);
  const theme = settings?.codeTheme ?? 'github';
  const enabled = settings?.diffSyntax ?? true;
  useEffect(() => {
    if (!enabled || diff?.status !== 'text') return;
    const lang = languageOf(path);
    if (!lang) return;
    let cancelled = false;
    void (async () => {
      const tokens: (CodeToken[] | null)[][] = [];
      for (const hunk of diff.hunks) {
        const oldIdx: number[] = [];
        const newIdx: number[] = [];
        hunk.lines.forEach((line, i) => {
          if (line.kind !== 'add') oldIdx.push(i);
          if (line.kind !== 'del') newIdx.push(i);
        });
        const [oldTokens, newTokens] = await Promise.all([
          tokenizeLines(
            oldIdx.map((i) => hunk.lines[i]!.text),
            lang,
            theme,
          ),
          tokenizeLines(
            newIdx.map((i) => hunk.lines[i]!.text),
            lang,
            theme,
          ),
        ]);
        const byLine: (CodeToken[] | null)[] = Array.from(
          { length: hunk.lines.length },
          () => null,
        );
        newIdx.forEach((line, k) => (byLine[line] = newTokens?.[k] ?? null));
        oldIdx.forEach((line, k) => {
          if (hunk.lines[line]!.kind === 'del')
            byLine[line] = oldTokens?.[k] ?? null;
        });
        tokens.push(byLine);
      }
      if (!cancelled) setResult({ diff, tokens });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [diff, path, theme, enabled]);
  return enabled && result && result.diff === diff ? result.tokens : null;
}

// One line's text: syntax tokens split again at changed-word boundaries.
function LineText({
  text,
  tokens,
  ranges,
  kind,
}: {
  text: string;
  tokens: CodeToken[] | null;
  ranges: Range[] | undefined;
  kind: DiffLine['kind'];
}) {
  const parts = tokens ?? [{ content: text, style: {} }];
  const out: ReactNode[] = [];
  let offset = 0;
  parts.forEach((token, t) => {
    const cuts = new Set([0, token.content.length]);
    for (const [s, e] of ranges ?? []) {
      if (s > offset && s < offset + token.content.length) cuts.add(s - offset);
      if (e > offset && e < offset + token.content.length) cuts.add(e - offset);
    }
    const points = [...cuts].sort((a, b) => a - b);
    for (let p = 0; p < points.length - 1; p++) {
      const start = offset + points[p]!;
      const piece = token.content.slice(points[p]!, points[p + 1]!);
      const changed = ranges?.some(([s, e]) => start >= s && start < e);
      out.push(
        <span
          key={`${t}:${p}`}
          className={cn(
            tokens && 'code-token',
            changed &&
              (kind === 'add'
                ? 'rounded-[3px] bg-diff-add-word underline decoration-1 underline-offset-3'
                : 'rounded-[3px] bg-diff-del-word line-through decoration-1'),
          )}
          style={tokens ? token.style : undefined}
        >
          {piece}
        </span>,
      );
    }
    offset += token.content.length;
  });
  return <>{out}</>;
}

function Gutter({ value }: { value: number | null }) {
  return (
    <span
      role="cell"
      className="pr-2 text-right text-muted tabular-nums select-none"
    >
      {value ?? ''}
    </span>
  );
}

function Sign({ kind }: { kind: DiffLine['kind'] }) {
  return (
    <span role="cell" className="font-semibold text-ink select-none">
      <span aria-hidden>{SIGN[kind].glyph}</span>
      <span className="sr-only">{SIGN[kind].label}</span>
    </span>
  );
}

function DiffBody({
  diff,
  path,
  settings,
  split,
  onExpand,
  maxHeight,
}: {
  diff: Extract<DiffResult, { status: 'text' }>;
  path: string;
  settings: Settings | undefined;
  split: boolean;
  onExpand: (() => void) | null;
  maxHeight?: string;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => buildRows(diff.hunks, split), [diff, split]);
  const tokens = useHighlighted(diff, path, settings);
  const words = useMemo(
    () =>
      settings?.diffWordHighlight === false
        ? diff.hunks.map(() => new Map<number, Range[]>())
        : diff.hunks.map((hunk) => wordRanges(hunk.lines)),
    [diff, settings?.diffWordHighlight],
  );
  const wrap = settings?.diffWrap ?? false;
  // Most diffs render directly; only long ones are virtualized, so the DOM stays small.
  const virtualize = rows.length > VIRTUALIZE_FROM;
  const virtual = useVirtualizer({
    count: virtualize ? rows.length : 0,
    enabled: virtualize,
    getScrollElement: () => scroller.current,
    estimateSize: () => 20,
    overscan: 30,
  });
  const hunkRows = useMemo(
    () => rows.flatMap((row, i) => (row.type === 'hunk' ? [i] : [])),
    [rows],
  );
  const [focusHunk, setFocusHunk] = useState(0);
  const jump = (delta: number) => {
    const next = Math.min(Math.max(focusHunk + delta, 0), hunkRows.length - 1);
    setFocusHunk(next);
    if (virtualize) virtual.scrollToIndex(hunkRows[next]!, { align: 'start' });
    else
      scroller.current
        ?.querySelector(`[data-index="${hunkRows[next]}"]`)
        ?.scrollIntoView({ block: 'start' });
  };

  const textCell = (
    side: { index: number; line: DiffLine } | null,
    hunk: number,
    first: boolean,
  ) =>
    side ? (
      <>
        <Gutter
          value={
            side.line.kind === 'add'
              ? side.line.new
              : (side.line.old ?? side.line.new)
          }
        />
        <Sign kind={side.line.kind} />
        <span
          role="cell"
          className={cn(
            'min-w-0 pr-4',
            wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre',
          )}
        >
          <LineText
            text={side.line.text}
            tokens={tokens?.[hunk]?.[side.index] ?? null}
            ranges={words[hunk]?.get(side.index)}
            kind={side.line.kind}
          />
          {side.line.kind === 'conflict' && (
            <span className="ml-3 font-sans text-[0.71875rem] font-semibold text-ink">
              {markerLabel(side.line.text)}
            </span>
          )}
        </span>
      </>
    ) : (
      <span
        role="cell"
        aria-label="No line"
        className={cn('col-span-3 bg-sunken', !first && 'border-l border-line')}
      />
    );

  const renderRow = (
    row: Row,
    index: number,
    measure?: (el: Element | null) => void,
  ) => {
    const common = {
      'data-index': index,
      ref: measure,
      role: 'row',
      'aria-rowindex': index + 1,
    };
    if (row.type === 'gap')
      return (
        <div key={index} {...common} className="border-y border-line">
          {onExpand ? (
            <button
              type="button"
              onClick={onExpand}
              className="flex h-7 w-full items-center gap-2 bg-sunken px-4 font-sans text-xs text-muted hover:text-ink"
            >
              <UnfoldVertical aria-hidden className="size-3.5" />
              Show {row.hidden} hidden {row.hidden === 1 ? 'line' : 'lines'}
            </button>
          ) : (
            <div className="h-2 bg-sunken" />
          )}
        </div>
      );
    if (row.type === 'hunk')
      return (
        <div
          key={index}
          {...common}
          className="bg-diff-hunk px-4 py-0.5 text-muted"
        >
          <span role="cell" className="whitespace-pre">
            {row.header}
          </span>
        </div>
      );
    if (row.type === 'line')
      return (
        <div
          key={index}
          {...common}
          className={cn(
            'grid grid-cols-[3rem_3rem_1.25rem_minmax(0,1fr)]',
            ROW_TINT[row.line.kind],
          )}
        >
          <Gutter value={row.line.old} />
          <Gutter value={row.line.new} />
          <Sign kind={row.line.kind} />
          <span
            role="cell"
            className={cn(
              'min-w-0 pr-4',
              wrap ? 'break-all whitespace-pre-wrap' : 'whitespace-pre',
            )}
          >
            <LineText
              text={row.line.text}
              tokens={tokens?.[row.hunk]?.[row.index] ?? null}
              ranges={words[row.hunk]?.get(row.index)}
              kind={row.line.kind}
            />
            {row.line.kind === 'conflict' && (
              <span className="ml-3 font-sans text-[0.71875rem] font-semibold text-ink">
                {markerLabel(row.line.text)}
              </span>
            )}
          </span>
        </div>
      );
    return (
      <div
        key={index}
        {...common}
        className="grid grid-cols-[3rem_1.25rem_minmax(0,1fr)_3rem_1.25rem_minmax(0,1fr)]"
      >
        <div
          className={cn(
            'col-span-3 grid grid-cols-subgrid',
            row.left && ROW_TINT[row.left.line.kind],
          )}
        >
          {textCell(row.left, row.hunk, true)}
        </div>
        <div
          className={cn(
            'col-span-3 grid grid-cols-subgrid border-l border-line',
            row.right && ROW_TINT[row.right.line.kind],
          )}
        >
          {textCell(row.right, row.hunk, false)}
        </div>
      </div>
    );
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {hunkRows.length > 1 && (
        <div className="flex flex-none items-center gap-1 border-b border-line px-3 py-1">
          <span className="mr-auto text-xs text-muted">
            Change {focusHunk + 1} of {hunkRows.length}
          </span>
          <Tooltip label="Previous change" side="bottom">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Previous change"
              onClick={() => jump(-1)}
            >
              <ArrowUp />
            </Button>
          </Tooltip>
          <Tooltip label="Next change" side="bottom">
            <Button
              size="icon"
              variant="ghost"
              aria-label="Next change"
              onClick={() => jump(1)}
            >
              <ArrowDown />
            </Button>
          </Tooltip>
        </div>
      )}
      <div
        ref={scroller}
        role="table"
        aria-label={`Diff of ${path}`}
        aria-rowcount={rows.length}
        className={cn('code-text min-h-0 flex-1 overflow-auto', maxHeight)}
      >
        {virtualize ? (
          <div
            className="relative w-full"
            style={{ height: virtual.getTotalSize() }}
          >
            <div
              className={cn(
                'absolute top-0 left-0',
                wrap ? 'w-full' : 'w-max min-w-full',
              )}
              style={{
                transform: `translateY(${virtual.getVirtualItems()[0]?.start ?? 0}px)`,
              }}
            >
              {virtual
                .getVirtualItems()
                .map((item) =>
                  renderRow(
                    rows[item.index]!,
                    item.index,
                    virtual.measureElement,
                  ),
                )}
            </div>
          </div>
        ) : (
          <div className={wrap ? 'w-full' : 'w-max min-w-full'}>
            {rows.map((row, index) => renderRow(row, index))}
          </div>
        )}
      </div>
      {diff.truncated && (
        <p className="flex-none border-t border-line px-4 py-2 text-xs text-muted">
          Showing the first lines of this diff. Your editor shows the rest.
        </p>
      )}
    </div>
  );
}

const SIDE_LABEL: Record<DiffSide, string> = {
  unstaged: 'Not staged',
  staged: 'Staged',
  untracked: 'New file, not tracked yet',
  conflict: 'Conflict',
};

// Everything the diff of one file can be: loading, an error, binary, too large, nothing to show,
// or text. The header's actions come from the caller, so the same view works in both layouts.
export function DiffView({
  repoId,
  path,
  side,
  statusAt,
  actions,
  width,
  inline = false,
}: {
  repoId: string;
  path: string;
  side: DiffSide;
  statusAt: number | null;
  actions?: ReactNode;
  // The pane's width, for Auto: side by side needs room for two columns of code.
  width: number;
  inline?: boolean;
}) {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const reveal = useRevealFile(repoId);
  const [full, setFull] = useState(false);
  const [expanded, setExpanded] = useState(false);
  useEffect(() => {
    setFull(false);
    setExpanded(false);
  }, [path, side]);

  const context = expanded ? WHOLE_FILE : (settings?.diffContext ?? 3);
  const ignoreWhitespace = settings?.diffIgnoreWhitespace ?? false;
  const query = useDiff(
    repoId,
    settings ? { path, side, context, ignoreWhitespace, full } : null,
    statusAt,
  );
  const layout = settings?.diffLayout ?? 'auto';
  const split = layout === 'split' || (layout === 'auto' && width >= 1100);
  const diff = query.data;
  const current = diff && diff.path === path ? diff : undefined;

  const toolbar = (
    <div
      role="toolbar"
      aria-label="Diff view"
      className="flex flex-wrap items-center gap-2"
    >
      <Segmented
        label="Diff layout"
        value={split ? 'split' : 'unified'}
        options={[
          { value: 'unified', label: 'Unified' },
          { value: 'split', label: 'Split' },
        ]}
        onChange={(diffLayout) => update.mutate({ diffLayout })}
      />
      <Button
        size="sm"
        variant={ignoreWhitespace ? 'secondary' : 'ghost'}
        aria-pressed={ignoreWhitespace}
        className={cn(ignoreWhitespace && 'bg-accent-soft')}
        onClick={() =>
          update.mutate({ diffIgnoreWhitespace: !ignoreWhitespace })
        }
      >
        Hide whitespace
      </Button>
      <Button
        size="sm"
        variant={settings?.diffWrap ? 'secondary' : 'ghost'}
        aria-pressed={settings?.diffWrap ?? false}
        className={cn(settings?.diffWrap && 'bg-accent-soft')}
        onClick={() => update.mutate({ diffWrap: !settings?.diffWrap })}
      >
        Wrap lines
      </Button>
      <OpenInEditorButton
        repoId={repoId}
        // A deleted file has nothing to open, so the repository opens instead.
        path={current?.status === 'text' && current.deleted ? null : path}
        line={
          current?.status === 'text'
            ? (current.hunks[0]?.lines.find((l) => l.kind === 'add')?.new ??
              current.hunks[0]?.newStart ??
              null)
            : null
        }
      />
      {actions}
    </div>
  );

  const header = (
    <div className="flex flex-none flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
      <div className="min-w-0">
        <h2
          className="truncate font-mono text-[0.8125rem] font-semibold text-ink"
          title={path}
        >
          {path}
        </h2>
        <p className="mt-0.5 text-xs text-muted">
          {SIDE_LABEL[side]}
          {current?.status === 'text' && (
            <>
              {' · '}
              <b className="font-semibold text-ink">+{current.added}</b>{' '}
              <b className="font-semibold text-ink">−{current.removed}</b>
              {current.oldPath ? ` · renamed from ${current.oldPath}` : ''}
              {current.modeChange ? ` · mode ${current.modeChange}` : ''}
            </>
          )}
        </p>
      </div>
      {toolbar}
    </div>
  );

  let body: ReactNode;
  if (!settings || (query.isPending && !current))
    body = (
      <div className="px-4">
        <Loading label={`Reading the diff of ${path}…`} />
      </div>
    );
  else if (query.isError)
    body = (
      <EmptyState
        compact
        className="px-4"
        art={<OfflineArt />}
        title="Couldn't read this diff"
        action={
          <Button
            size="sm"
            pending={query.isFetching}
            onClick={() => void query.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(
          query.error,
          'The file changed or moved while Git was reading it.',
        )}
      </EmptyState>
    );
  else if (!current)
    body = (
      <div className="px-4">
        <Loading label={`Reading the diff of ${path}…`} />
      </div>
    );
  else if (current.status === 'binary')
    body = (
      <EmptyState
        compact
        className="px-4"
        art={<DiffArt />}
        title={`${path.split('/').pop()} is binary`}
        action={
          <Button
            size="sm"
            pending={reveal.isPending}
            onClick={() => reveal.mutate(path)}
          >
            {!reveal.isPending && <FolderOpen />}
            {fileManagerLabel()}
          </Button>
        }
      >
        Git can't show it as lines. Open it from its folder to compare.
      </EmptyState>
    );
  else if (current.status === 'too-large')
    body = (
      <EmptyState
        compact
        className="px-4"
        art={<DiffArt />}
        title="This diff is large"
        action={
          <Button
            size="sm"
            pending={query.isFetching && full}
            onClick={() => setFull(true)}
          >
            Load full diff
          </Button>
        }
      >
        {current.added + current.removed > 0
          ? `It changes +${current.added.toLocaleString()} −${current.removed.toLocaleString()} lines. Showing them all may slow gitdesk down.`
          : 'The file is over 5 MB. Showing it may slow gitdesk down.'}
      </EmptyState>
    );
  else if (current.status === 'empty')
    body = (
      <EmptyState
        compact
        className="px-4"
        art={<DiffArt />}
        title={
          ignoreWhitespace
            ? 'Only whitespace changed'
            : 'No text changes to show'
        }
        action={
          ignoreWhitespace ? (
            <Button
              size="sm"
              onClick={() => update.mutate({ diffIgnoreWhitespace: false })}
            >
              Show whitespace changes
            </Button>
          ) : (
            <Button
              size="sm"
              pending={reveal.isPending}
              onClick={() => reveal.mutate(path)}
            >
              {fileManagerLabel()}
            </Button>
          )
        }
      >
        {current.modeChange
          ? `Only the file mode changed (${current.modeChange}).`
          : ignoreWhitespace
            ? 'Hide whitespace is on, and nothing else differs.'
            : 'Git reports the file as changed, with no lines to compare.'}
      </EmptyState>
    );
  else
    body = (
      <DiffBody
        diff={current}
        path={path}
        settings={settings}
        split={split}
        onExpand={expanded ? null : () => setExpanded(true)}
        maxHeight={inline ? 'max-h-[32rem]' : undefined}
      />
    );

  return (
    <section
      aria-label={`Diff of ${path}`}
      className={cn(
        'flex min-h-0 min-w-0 flex-col',
        inline ? 'rounded-sm border border-line' : 'flex-1',
      )}
    >
      {header}
      {body}
    </section>
  );
}
