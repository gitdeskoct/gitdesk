import * as Toolbar from '@radix-ui/react-toolbar';
import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowDown,
  ArrowUp,
  Check,
  Copy,
  FolderOpen,
  Lock,
  MoreHorizontal,
  Pilcrow,
  RefreshCw,
  TriangleAlert,
  UnfoldVertical,
  WrapText,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MutableRefObject,
  type ReactNode,
} from 'react';
import { fileType } from '../../../shared/file-types';
import type { Settings } from '../../../shared/settings';
import type {
  DiffHunk,
  DiffLine,
  DiffResult,
  DiffSide,
} from '../../../shared/workspace';
import { DiffArt, OfflineArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { EmptyState } from '../../components/ui/empty-state';
import { InlineStatus, Loading } from '../../components/ui/status';
import { useToast } from '../../components/ui/toast';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/cn';
import { formatBytes } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useApplySelection,
  useCopyFilePath,
  useCopyPatch,
  useDiff,
  useRevealDiscarded,
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
): { tokens: (CodeToken[] | null)[][]; skipped: boolean } | null {
  const [result, setResult] = useState<{
    diff: DiffResult;
    tokens: (CodeToken[] | null)[][];
    skipped: boolean;
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
      let skipped = false;
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
        // Shiki skips a side past its size limit; the diff says so instead of going quiet.
        if ((oldIdx.length && !oldTokens) || (newIdx.length && !newTokens))
          skipped = true;
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
      if (!cancelled) setResult({ diff, tokens, skipped });
    })().catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [diff, path, theme, enabled]);
  return enabled && result && result.diff === diff
    ? { tokens: result.tokens, skipped: result.skipped }
    : null;
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

// With onComment, the line number is the button that starts a comment on that line.
function Gutter({
  value,
  onComment,
  removed = false,
}: {
  value: number | null;
  onComment?: () => void;
  // The old side of a removed line: its number is from before the change.
  removed?: boolean;
}) {
  if (onComment && value !== null) {
    const label = `Comment on ${removed ? 'removed ' : ''}line ${value}`;
    return (
      <span role="cell" className="text-right">
        <button
          type="button"
          onClick={onComment}
          aria-label={label}
          title={label}
          className="w-full pr-2 text-right text-muted tabular-nums select-none hover:bg-accent-soft hover:text-accent focus-visible:outline-offset-[-2px]"
        >
          {value}
        </button>
      </span>
    );
  }
  return (
    <span
      role="cell"
      className="pr-2 text-right text-muted tabular-nums select-none"
    >
      {value ?? ''}
    </span>
  );
}

// A thread or composer under a line, inside the diff's table.
function SlotRow({ children }: { children: ReactNode }) {
  return (
    <div role="row" className="border-y border-line bg-surface font-sans">
      <div
        role="cell"
        // Pinned to the visible width, so a thread stays in view while long code scrolls sideways.
        className="sticky left-0 w-[100cqw] py-3 pr-4 pl-4 whitespace-normal sm:pl-[6.25rem]"
      >
        {children}
      </div>
    </div>
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

export type StagingControls = {
  // Selected line indexes per hunk.
  selected: Map<number, Set<number>>;
  onToggle: (hunk: number, index: number, extend: boolean) => void;
  hunkActions: (hunk: number) => ReactNode;
};

function NoEol() {
  return (
    <span className="ml-3 font-sans text-[0.71875rem] text-muted">
      No newline at end of file
    </span>
  );
}

// One changed line's select box. Shift+click extends from the last line picked.
function PickCell({
  on,
  label,
  onToggle,
}: {
  on: boolean;
  label: string;
  onToggle: (extend: boolean) => void;
}) {
  return (
    <span role="cell" className="grid place-items-center select-none">
      <button
        type="button"
        aria-pressed={on}
        aria-label={`Select ${label} for staging`}
        title={`Select ${label}`}
        onClick={(event) => onToggle(event.shiftKey)}
        className={cn(
          'grid size-3.5 place-items-center rounded-[3px] text-on-accent focus-visible:outline-offset-1',
          on ? 'bg-accent' : 'shadow-[inset_0_0_0_1.5px_var(--field-line)]',
        )}
      >
        {on && <Check aria-hidden className="size-2.5 stroke-[3.5]" />}
      </button>
    </span>
  );
}

// The text diff itself. Reviews pass lineSlot to show threads under lines and onLineComment to
// make line numbers start a comment; Changes passes neither.
export function DiffBody({
  diff,
  path,
  settings,
  split,
  onExpand,
  maxHeight,
  lineSlot,
  onLineComment,
  staging,
  navRef,
}: {
  diff: Extract<DiffResult, { status: 'text' }>;
  path: string;
  settings: Settings | undefined;
  split: boolean;
  onExpand: (() => void) | null;
  maxHeight?: string;
  lineSlot?: (line: DiffLine) => ReactNode;
  onLineComment?: (line: DiffLine, side: 'old' | 'new') => void;
  // Changes: a select box on each changed line and actions on each change (hunk).
  staging?: StagingControls;
  // Lets the toolbar and the [ and ] keys move between changes.
  navRef?: MutableRefObject<((delta: number) => void) | null>;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const rows = useMemo(() => buildRows(diff.hunks, split), [diff, split]);
  const highlighted = useHighlighted(diff, path, settings);
  const tokens = highlighted?.tokens ?? null;
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
  useEffect(() => {
    if (!navRef) return;
    navRef.current = hunkRows.length ? jump : null;
    return () => {
      navRef.current = null;
    };
  });
  const pick = (hunk: number, side: { index: number; line: DiffLine }) =>
    staging && (side.line.kind === 'add' || side.line.kind === 'del') ? (
      <PickCell
        on={staging.selected.get(hunk)?.has(side.index) ?? false}
        label={`${side.line.kind === 'add' ? 'added' : 'removed'} line ${side.line.new ?? side.line.old}`}
        onToggle={(extend) => staging.onToggle(hunk, side.index, extend)}
      />
    ) : staging ? (
      <span role="cell" />
    ) : null;

  const textCell = (
    side: { index: number; line: DiffLine } | null,
    hunk: number,
    first: boolean,
  ) =>
    side ? (
      <>
        {pick(hunk, side)}
        <Gutter
          // Left is the file before (old numbers), right the file after (new numbers).
          value={
            first
              ? (side.line.old ?? side.line.new)
              : (side.line.new ?? side.line.old)
          }
          // The left column comments only on removed lines: an unchanged line there shows its old
          // number, so its comment belongs to the right column's copy.
          onComment={
            onLineComment && (!first || side.line.kind === 'del')
              ? () =>
                  onLineComment(
                    side.line,
                    side.line.kind === 'del' ? 'old' : 'new',
                  )
              : undefined
          }
          removed={side.line.kind === 'del'}
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
          {side.line.noEol && <NoEol />}
        </span>
      </>
    ) : (
      <span
        role="cell"
        aria-label="No line"
        className={cn(
          staging ? 'col-span-4' : 'col-span-3',
          'bg-sunken',
          !first && 'border-l border-line',
        )}
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
        <div key={index} {...common} className="bg-diff-hunk text-muted">
          {staging ? (
            // Pinned to the visible width, so the actions stay in view while long code scrolls.
            <div
              role="cell"
              className="sticky left-0 flex w-[100cqw] flex-wrap items-center gap-x-3 gap-y-1 py-1 pr-3 pl-4"
            >
              <span className="min-w-0 truncate whitespace-pre">
                {row.header}
              </span>
              <span className="ml-auto flex gap-1 font-sans">
                {staging.hunkActions(row.hunk)}
              </span>
            </div>
          ) : (
            <span role="cell" className="block px-4 py-0.5 whitespace-pre">
              {row.header}
            </span>
          )}
        </div>
      );
    if (row.type === 'line') {
      const slot = lineSlot?.(row.line);
      const line = (
        <div
          key={index}
          {...(slot ? { role: 'row' } : common)}
          className={cn(
            'grid',
            staging
              ? 'grid-cols-[1.5rem_3rem_3rem_1.25rem_minmax(0,1fr)]'
              : 'grid-cols-[3rem_3rem_1.25rem_minmax(0,1fr)]',
            ROW_TINT[row.line.kind],
          )}
        >
          {pick(row.hunk, row)}
          <Gutter
            value={row.line.old}
            onComment={
              onLineComment && row.line.kind === 'del'
                ? () => onLineComment(row.line, 'old')
                : undefined
            }
            removed
          />
          <Gutter
            value={row.line.new}
            onComment={
              onLineComment ? () => onLineComment(row.line, 'new') : undefined
            }
          />
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
            {row.line.noEol && <NoEol />}
          </span>
        </div>
      );
      if (!slot) return line;
      // The line and its thread are measured as one item when the diff is virtualized.
      return (
        <div key={index} data-index={index} ref={measure}>
          {line}
          <SlotRow>{slot}</SlotRow>
        </div>
      );
    }
    // An unchanged line is the same line in both columns: ask for its threads once.
    const lines = new Set([row.left?.line, row.right?.line]);
    const slots = [...lines]
      .map((line) => (line ? lineSlot?.(line) : null))
      .filter(Boolean);
    const pair = (
      <div
        key={index}
        {...(slots.length ? { role: 'row' } : common)}
        className={cn(
          'grid',
          staging
            ? 'grid-cols-[1.5rem_3rem_1.25rem_minmax(0,1fr)_1.5rem_3rem_1.25rem_minmax(0,1fr)]'
            : 'grid-cols-[3rem_1.25rem_minmax(0,1fr)_3rem_1.25rem_minmax(0,1fr)]',
        )}
      >
        <div
          className={cn(
            staging ? 'col-span-4' : 'col-span-3',
            'grid grid-cols-subgrid',
            row.left && ROW_TINT[row.left.line.kind],
          )}
        >
          {textCell(row.left, row.hunk, true)}
        </div>
        <div
          className={cn(
            staging ? 'col-span-4' : 'col-span-3',
            'grid grid-cols-subgrid border-l border-line',
            row.right && ROW_TINT[row.right.line.kind],
          )}
        >
          {textCell(row.right, row.hunk, false)}
        </div>
      </div>
    );
    if (!slots.length) return pair;
    return (
      <div key={index} data-index={index} ref={measure}>
        {pair}
        {slots.map((slot, i) => (
          <SlotRow key={i}>{slot}</SlotRow>
        ))}
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
        className={cn(
          'code-text @container min-h-0 flex-1 overflow-auto',
          maxHeight,
        )}
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
      {highlighted?.skipped && (
        <p className="flex-none border-t border-line px-4 py-2 text-xs text-muted">
          Syntax colors are off for parts of this diff that are too long to
          color quickly.
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

// The comparison Git made, in its own terms, so a staged diff never reads as the working file.
const COMPARISON: Record<DiffSide, readonly string[]> = {
  staged: ['HEAD', 'Index'],
  unstaged: ['Index', 'Working tree'],
  untracked: ['New file', 'Working tree'],
  conflict: ['Base', 'Yours', 'Incoming'],
};

function Comparison({ side }: { side: DiffSide }) {
  const parts = COMPARISON[side];
  return (
    <span className="inline-flex items-center gap-1 rounded-[4px] bg-sunken px-1.5 py-px text-xs text-ink ring-1 ring-line">
      {parts.map((part, i) => (
        <span key={part} className="inline-flex items-center gap-1">
          {i > 0 && (
            <span aria-hidden className="text-muted">
              {side === 'conflict' ? '·' : '→'}
            </span>
          )}
          <b className="font-semibold">{part}</b>
        </span>
      ))}
      {side !== 'conflict' && (
        <span className="sr-only">
          {` compared: ${parts[0]} to ${parts[1]}`}
        </span>
      )}
    </span>
  );
}

const GENERATED = /\.min\.(js|css|mjs)$|\.map$/i;
const isGenerated = (path: string) =>
  fileType(path).icon === 'lock' || GENERATED.test(path);

type Pick = { index: number; lines?: number[] }[];

// The partial-staging problem that needs words: a stale diff, a held lock, or a selection Git
// refused. Each says what happened and that nothing changed.
type Problem =
  | { kind: 'stale' }
  | { kind: 'busy'; message: string }
  | { kind: 'refused'; message: string };

const TOOL_TOGGLE =
  'h-7 rounded-[4px] px-2.5 text-[0.8125rem] whitespace-nowrap text-muted transition-colors hover:text-ink focus-visible:outline-offset-0 data-[state=on]:bg-thumb data-[state=on]:font-medium data-[state=on]:text-ink data-[state=on]:shadow-[0_1px_2px_rgb(20_22_26/0.12)]';

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
  onStep,
}: {
  repoId: string;
  path: string;
  side: DiffSide;
  statusAt: number | null;
  actions?: ReactNode;
  // The pane's width, for Auto: side by side needs room for two columns of code.
  width: number;
  // The centered layout's inline diff: whole-file actions only, so reading stays light.
  inline?: boolean;
  // Moves to the previous or next changed file in the list.
  onStep?: (delta: -1 | 1) => void;
}) {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const reveal = useRevealFile(repoId);
  const copyPath = useCopyFilePath(repoId);
  const copyPatch = useCopyPatch(repoId);
  const apply = useApplySelection(repoId);
  const revealDiscarded = useRevealDiscarded();
  const toast = useToast();
  const navRef = useRef<((delta: number) => void) | null>(null);
  const [full, setFull] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [showGenerated, setShowGenerated] = useState(false);
  const [selected, setSelected] = useState<Map<number, Set<number>>>(
    () => new Map(),
  );
  const [anchor, setAnchor] = useState<{ hunk: number; index: number } | null>(
    null,
  );
  const [problem, setProblem] = useState<Problem | null>(null);
  const [confirming, setConfirming] = useState<{
    hunks: Pick;
    label: string;
  } | null>(null);
  useEffect(() => {
    setFull(false);
    setExpanded(false);
    setShowGenerated(false);
    setProblem(null);
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
  const token = current?.status === 'text' ? current.token : null;
  // A new diff means new line indexes: an old selection would point at other lines.
  useEffect(() => {
    setSelected(new Map());
    setAnchor(null);
    setConfirming(null);
  }, [token, path, side]);

  const partial =
    !inline &&
    side !== 'conflict' &&
    (settings?.changesPartial ?? true) &&
    current?.status === 'text';
  const canPick = partial && !!token;
  const keepCopy = settings?.changesKeepDiscarded ?? true;

  const run = (action: 'stage' | 'unstage' | 'discard', hunks: Pick) => {
    if (!token || side === 'conflict') return;
    setProblem(null);
    apply.mutate(
      { path, side, action, token, context, hunks },
      {
        onSuccess: (result) => {
          if (result.status === 'applied') {
            setSelected(new Map());
            setConfirming(null);
            if (action === 'discard')
              toast({
                tone: 'success',
                title: 'Discarded the selected changes',
                description: result.saved
                  ? 'A copy is in Discarded changes.'
                  : undefined,
                action: result.saved
                  ? {
                      label: 'Reveal',
                      altText: 'Show the saved copy',
                      onClick: () => revealDiscarded.mutate(repoId),
                    }
                  : undefined,
              });
          } else if (result.status === 'stale') setProblem({ kind: 'stale' });
          else
            setProblem({
              kind: result.reason === 'busy' ? 'busy' : 'refused',
              message: result.message,
            });
        },
        onError: (err) =>
          setProblem({
            kind: 'refused',
            message: ipcErrorMessage(err, "That change didn't run."),
          }),
      },
    );
  };

  const selection: Pick = [...selected]
    .filter(([, lines]) => lines.size)
    .map(([index, lines]) => ({
      index,
      lines: [...lines].sort((a, b) => a - b),
    }));
  const selectedCount = selection.reduce((n, h) => n + h.lines!.length, 0);
  const pendingAction =
    apply.isPending && apply.variables ? apply.variables : null;
  const isPending = (action: string, hunk: number | null) =>
    !!pendingAction &&
    pendingAction.action === action &&
    (hunk === null
      ? pendingAction.hunks.some((h) => h.lines)
      : pendingAction.hunks.length === 1 &&
        pendingAction.hunks[0]!.index === hunk &&
        !pendingAction.hunks[0]!.lines);

  const toggle = (hunk: number, index: number, extend: boolean) => {
    if (current?.status !== 'text') return;
    setSelected((previous) => {
      const next = new Map(previous);
      const lines = new Set(next.get(hunk) ?? []);
      const on = !lines.has(index);
      const from =
        extend && anchor?.hunk === hunk ? Math.min(anchor.index, index) : index;
      const to =
        extend && anchor?.hunk === hunk ? Math.max(anchor.index, index) : index;
      current.hunks[hunk]!.lines.forEach((line, i) => {
        if (i < from || i > to) return;
        if (line.kind !== 'add' && line.kind !== 'del') return;
        if (on) lines.add(i);
        else lines.delete(i);
      });
      next.set(hunk, lines);
      return next;
    });
    setAnchor({ hunk, index });
  };

  const hunkActions = (hunk: number) => (
    <>
      {side === 'staged' ? (
        <Button
          size="sm"
          className="h-6 px-2 text-xs"
          pending={isPending('unstage', hunk)}
          onClick={() => run('unstage', [{ index: hunk }])}
        >
          Unstage change
        </Button>
      ) : (
        <Button
          size="sm"
          className="h-6 px-2 text-xs"
          pending={isPending('stage', hunk)}
          onClick={() => run('stage', [{ index: hunk }])}
        >
          Stage change
        </Button>
      )}
      {side === 'unstaged' && (
        <Button
          size="sm"
          variant="ghost"
          className="h-6 px-2 text-xs"
          onClick={() =>
            setConfirming({
              hunks: [{ index: hunk }],
              label: `change ${hunk + 1}`,
            })
          }
        >
          Discard change…
        </Button>
      )}
    </>
  );

  const onKeyDown = (event: ReactKeyboardEvent<HTMLElement>) => {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    if (event.key === ']' || event.key === '[') {
      event.preventDefault();
      navRef.current?.(event.key === ']' ? 1 : -1);
    } else if (
      event.altKey &&
      onStep &&
      (event.key === 'ArrowDown' || event.key === 'ArrowUp')
    ) {
      event.preventDefault();
      onStep(event.key === 'ArrowDown' ? 1 : -1);
    }
  };

  const iconButton = (
    label: string,
    icon: ReactNode,
    onClick: () => void,
    keys?: string,
  ) => (
    <Tooltip label={keys ? `${label} (${keys})` : label} side="bottom">
      <Toolbar.Button asChild>
        <Button
          size="icon"
          variant="ghost"
          aria-label={label}
          onClick={onClick}
        >
          {icon}
        </Button>
      </Toolbar.Button>
    </Tooltip>
  );

  const toolbar = (
    <Toolbar.Root
      aria-label="Diff"
      className="flex flex-wrap items-center gap-1"
    >
      {onStep && (
        <>
          {iconButton('Previous file', <ArrowUp />, () => onStep(-1), 'Alt+↑')}
          {iconButton('Next file', <ArrowDown />, () => onStep(1), 'Alt+↓')}
          <Toolbar.Separator className="mx-1 h-5 w-px bg-line" />
        </>
      )}
      <Toolbar.ToggleGroup
        type="single"
        aria-label="Diff layout"
        value={split ? 'split' : 'unified'}
        onValueChange={(value) =>
          value && update.mutate({ diffLayout: value as 'unified' | 'split' })
        }
        className="inline-flex gap-0.5 rounded-sm bg-control p-0.5"
      >
        <Toolbar.ToggleItem value="unified" className={TOOL_TOGGLE}>
          Unified
        </Toolbar.ToggleItem>
        <Toolbar.ToggleItem value="split" className={TOOL_TOGGLE}>
          Split
        </Toolbar.ToggleItem>
      </Toolbar.ToggleGroup>
      <Toolbar.Button asChild>
        <Button
          size="sm"
          variant={ignoreWhitespace ? 'secondary' : 'ghost'}
          aria-pressed={ignoreWhitespace}
          className={cn(ignoreWhitespace && 'bg-accent-soft')}
          onClick={() =>
            update.mutate({ diffIgnoreWhitespace: !ignoreWhitespace })
          }
        >
          <Pilcrow />
          Hide whitespace
        </Button>
      </Toolbar.Button>
      <Toolbar.Button asChild>
        <Button
          size="sm"
          variant={settings?.diffWrap ? 'secondary' : 'ghost'}
          aria-pressed={settings?.diffWrap ?? false}
          className={cn(settings?.diffWrap && 'bg-accent-soft')}
          onClick={() => update.mutate({ diffWrap: !settings?.diffWrap })}
        >
          <WrapText />
          Wrap lines
        </Button>
      </Toolbar.Button>
      {(side === 'staged' || side === 'unstaged') && (
        <Toolbar.Button asChild>
          <Button
            size="sm"
            variant="ghost"
            pending={copyPatch.isPending}
            onClick={() =>
              copyPatch.mutate(
                { path, side },
                {
                  onSuccess: () =>
                    toast({ tone: 'success', title: 'Copied the patch' }),
                  onError: (err) =>
                    toast({
                      tone: 'danger',
                      title: "Couldn't copy the patch",
                      description: ipcErrorMessage(err, 'Try again.'),
                    }),
                },
              )
            }
          >
            {!copyPatch.isPending && <Copy />}
            Copy patch
          </Button>
        </Toolbar.Button>
      )}
      <Toolbar.Button asChild>
        <OpenInEditorButton
          repoId={repoId}
          // A deleted file has nothing to open, so the repository opens instead.
          path={current?.status === 'text' && current.deleted ? null : path}
          line={
            current?.status === 'text'
              ? (current.hunks[0]?.lines.find(
                  (l) => l.kind === 'add' || l.kind === 'conflict',
                )?.new ??
                current.hunks[0]?.newStart ??
                null)
              : null
          }
        />
      </Toolbar.Button>
      {actions}
      <DropdownMenu>
        <Tooltip label="More file actions" side="bottom">
          <Toolbar.Button asChild>
            <DropdownMenuTrigger asChild>
              <Button
                size="icon"
                variant="ghost"
                aria-label="More file actions"
              >
                <MoreHorizontal />
              </Button>
            </DropdownMenuTrigger>
          </Toolbar.Button>
        </Tooltip>
        <DropdownMenuContent align="end">
          <DropdownMenuItem
            onSelect={() =>
              copyPath.mutate(path, {
                onSuccess: () =>
                  toast({ tone: 'success', title: 'Copied the path' }),
                onError: (err) =>
                  toast({
                    tone: 'danger',
                    title: "Couldn't copy the path",
                    description: ipcErrorMessage(err, 'Try again.'),
                  }),
              })
            }
          >
            <Copy /> Copy path
          </DropdownMenuItem>
          {!(current?.status === 'text' && current.deleted) && (
            <DropdownMenuItem
              onSelect={() =>
                reveal.mutate(path, {
                  onError: (err) =>
                    toast({
                      tone: 'danger',
                      title: "Couldn't show the file",
                      description: ipcErrorMessage(err, 'Try again.'),
                    }),
                })
              }
            >
              <FolderOpen /> {fileManagerLabel()}
            </DropdownMenuItem>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </Toolbar.Root>
  );

  const oldPath =
    current && current.status !== 'too-large' && current.status !== 'empty'
      ? current.oldPath
      : null;
  const header = (
    <div className="flex flex-none flex-wrap items-center justify-between gap-x-4 gap-y-2 border-b border-line px-4 py-2.5">
      <div className="min-w-0">
        <h2
          className="truncate font-mono text-[0.8125rem] font-semibold text-ink"
          title={oldPath ? `${oldPath} → ${path}` : path}
        >
          {oldPath ? (
            <>
              <span className="font-normal text-muted">{oldPath}</span>
              <span aria-label=" renamed to "> → </span>
              {path}
            </>
          ) : (
            path
          )}
        </h2>
        <p className="mt-1 flex flex-wrap items-center gap-x-2 gap-y-1 text-xs text-muted">
          <Comparison side={side} />
          <span>{SIDE_LABEL[side]}</span>
          {current?.status === 'text' && (
            <span>
              <b className="font-semibold text-success">+{current.added}</b>{' '}
              <b className="font-semibold text-danger">−{current.removed}</b>
            </span>
          )}
          {current?.status === 'text' && current.modeChange && (
            <span>Mode {current.modeChange}</span>
          )}
        </p>
      </div>
      {toolbar}
    </div>
  );

  const discardBand = confirming && (
    <div
      role="alert"
      className="grid flex-none gap-2.5 bg-danger-soft px-4 py-2.5 text-[0.8125rem] text-ink"
    >
      <p>
        <b className="font-semibold">
          Discard {confirming.label} in {path.split('/').pop()}?
        </b>{' '}
        Your working copy loses those lines and goes back to the staged version.{' '}
        {keepCopy
          ? 'A copy is saved in Discarded changes first.'
          : "Keeping a copy is off in Settings, so this can't be undone."}
      </p>
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="danger"
          className="bg-surface"
          pending={isPending(
            'discard',
            confirming.hunks[0]?.lines ? null : confirming.hunks[0]!.index,
          )}
          onClick={() => run('discard', confirming.hunks)}
        >
          Discard {confirming.label}
        </Button>
        <Button
          size="sm"
          variant="ghost"
          autoFocus
          onClick={() => setConfirming(null)}
        >
          Cancel
        </Button>
      </div>
    </div>
  );

  const problemBand =
    problem &&
    (problem.kind === 'stale' ? (
      <div
        role="alert"
        className="flex flex-none flex-wrap items-center gap-3 bg-warning-soft px-4 py-2.5 text-[0.8125rem] text-ink"
      >
        <TriangleAlert aria-hidden className="size-4 text-warning" />
        <span className="min-w-0 flex-1">
          <b className="font-semibold">
            {path.split('/').pop()} changed while you were reviewing it.
          </b>{' '}
          Nothing was staged. The diff now shows the file as it is; choose the
          lines again.
        </span>
        <Button
          size="sm"
          className="bg-surface"
          pending={query.isFetching}
          onClick={() => {
            setProblem(null);
            void query.refetch();
          }}
        >
          {!query.isFetching && <RefreshCw />}
          Refresh diff
        </Button>
      </div>
    ) : problem.kind === 'busy' ? (
      <div
        role="alert"
        className="flex flex-none flex-wrap items-center gap-3 bg-warning-soft px-4 py-2.5 text-[0.8125rem] text-ink"
      >
        <Lock aria-hidden className="size-4 text-warning" />
        <span className="min-w-0 flex-1">{problem.message}</span>
        <Button
          size="sm"
          className="bg-surface"
          pending={apply.isPending}
          onClick={() =>
            apply.variables &&
            run(apply.variables.action, apply.variables.hunks)
          }
        >
          Try again
        </Button>
      </div>
    ) : (
      <InlineStatus tone="warning" className="mx-4 my-2 flex-none">
        {problem.message}
      </InlineStatus>
    ));

  const selectionBar = canPick && selectedCount > 0 && (
    <div
      role="toolbar"
      aria-label="Selected lines"
      className="flex flex-none flex-wrap items-center gap-2 bg-accent-soft px-4 py-2 text-[0.8125rem] text-ink"
    >
      <span className="min-w-0 flex-1">
        <b className="font-semibold tabular-nums">{selectedCount}</b>{' '}
        {selectedCount === 1 ? 'changed line' : 'changed lines'} selected. The
        rest stay {side === 'staged' ? 'staged' : 'as they are'}.
      </span>
      {side === 'staged' ? (
        <Button
          size="sm"
          variant="primary"
          pending={isPending('unstage', null)}
          onClick={() => run('unstage', selection)}
        >
          Unstage lines
        </Button>
      ) : (
        <Button
          size="sm"
          variant="primary"
          pending={isPending('stage', null)}
          onClick={() => run('stage', selection)}
        >
          Stage lines
        </Button>
      )}
      {side === 'unstaged' && (
        <Button
          size="sm"
          variant="danger"
          className="bg-surface"
          onClick={() =>
            setConfirming({
              hunks: selection,
              label: `${selectedCount} ${selectedCount === 1 ? 'line' : 'lines'}`,
            })
          }
        >
          Discard lines…
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={() => setSelected(new Map())}>
        Clear
      </Button>
    </div>
  );

  // Why parts of this diff can't be staged, when the reason is something the user can change.
  const partialNote =
    partial && !token && current?.status === 'text' ? (
      ignoreWhitespace ? (
        <div className="flex flex-none flex-wrap items-center gap-3 border-b border-line px-4 py-2 text-xs text-muted">
          <span className="min-w-0 flex-1">
            Whitespace changes are hidden, so parts of this file can't be
            staged: the patch has to match Git's own diff. Whole-file staging
            still works.
          </span>
          <Button
            size="sm"
            onClick={() => update.mutate({ diffIgnoreWhitespace: false })}
          >
            Show whitespace changes
          </Button>
        </div>
      ) : current.truncated ? (
        <p className="flex-none border-b border-line px-4 py-2 text-xs text-muted">
          This diff is cut short, so parts of it can't be staged. Load the full
          diff, or stage the whole file.
        </p>
      ) : null
    ) : null;

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
        {current.oldSize !== null && current.newSize !== null
          ? `${formatBytes(current.oldSize)} → ${formatBytes(current.newSize)}. `
          : current.newSize !== null
            ? `${formatBytes(current.newSize)}, new. `
            : current.oldSize !== null
              ? `${formatBytes(current.oldSize)}, removed. `
              : ''}
        Git can't show it as lines, so there are no line counts.
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
  else if (
    (settings.diffCollapseGenerated ?? true) &&
    isGenerated(path) &&
    !showGenerated
  )
    body = (
      <EmptyState
        compact
        className="px-4"
        art={<DiffArt />}
        title={`${path.split('/').pop()} is folded`}
        action={
          <Button size="sm" onClick={() => setShowGenerated(true)}>
            Show diff
          </Button>
        }
      >
        {`It's a generated file with ${(current.added + current.removed).toLocaleString()} changed lines. It is still staged and committed like any other file; folding only hides the lines.`}
      </EmptyState>
    );
  else
    body = (
      <>
        {partialNote}
        {problemBand}
        {discardBand}
        {selectionBar}
        <DiffBody
          diff={current}
          path={path}
          settings={settings}
          split={split}
          onExpand={expanded ? null : () => setExpanded(true)}
          maxHeight={inline ? 'max-h-[32rem]' : undefined}
          navRef={navRef}
          staging={
            canPick ? { selected, onToggle: toggle, hunkActions } : undefined
          }
        />
      </>
    );

  return (
    <section
      aria-label={`Diff of ${path}`}
      onKeyDown={onKeyDown}
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
