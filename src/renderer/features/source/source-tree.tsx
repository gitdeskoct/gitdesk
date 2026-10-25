import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronRight, EyeOff, RotateCcw } from 'lucide-react';
import {
  useCallback,
  useEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { fileType } from '../../../shared/file-types';
import type { SourceEntry } from '../../../shared/source';
import { Button } from '../../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/cn';
import { formatBytes } from '../../lib/format';
import { iconFor } from './file-icons';
import type { DirState } from './source-queries';

export type TreeRow =
  | {
      kind: 'entry';
      key: string;
      entry: SourceEntry;
      level: number;
      setsize: number;
      posinset: number;
      open: boolean;
      parent: string;
    }
  | {
      kind: 'status';
      key: string;
      dir: string;
      level: number;
      state: 'loading' | 'empty' | 'error' | 'more' | 'loading-more';
    };

export const STATUS_LABEL: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Conflict',
  '?': 'Untracked',
};

// The rows on screen, in order: each open folder's entries right under it. Collapsing a folder
// drops its rows from this list; its cached entries stay for when it opens again.
export function flattenTree(
  dirs: Map<string, DirState>,
  expanded: Set<string>,
): TreeRow[] {
  const rows: TreeRow[] = [];
  const walk = (dir: string, level: number) => {
    const state = dirs.get(dir);
    if (!state || (state.loading && !state.entries.length)) {
      rows.push({
        kind: 'status',
        key: `${dir}\0loading`,
        dir,
        level,
        state: 'loading',
      });
      return;
    }
    if (state.error === 'load' || (state.problem && !state.entries.length)) {
      rows.push({
        kind: 'status',
        key: `${dir}\0error`,
        dir,
        level,
        state: 'error',
      });
      return;
    }
    if (!state.entries.length && dir !== '') {
      rows.push({
        kind: 'status',
        key: `${dir}\0empty`,
        dir,
        level,
        state: 'empty',
      });
      return;
    }
    const size = state.total ?? state.entries.length;
    state.entries.forEach((entry, i) => {
      const open = entry.type === 'dir' && expanded.has(entry.path);
      rows.push({
        kind: 'entry',
        key: entry.path,
        entry,
        level,
        setsize: size,
        posinset: i + 1,
        open,
        parent: dir,
      });
      if (open) walk(entry.path, level + 1);
    });
    if (state.loadingMore)
      rows.push({
        kind: 'status',
        key: `${dir}\0more`,
        dir,
        level,
        state: 'loading-more',
      });
    else if (state.hasMore)
      rows.push({
        kind: 'status',
        key: `${dir}\0more`,
        dir,
        level,
        state: 'more',
      });
  };
  walk('', 1);
  return rows;
}

export function describeEntry(entry: SourceEntry): string {
  const parts: string[] = [];
  if (entry.type === 'dir') parts.push('Folder');
  else if (entry.type === 'submodule')
    parts.push('Submodule, a separate repository');
  else if (entry.type === 'symlink') parts.push('Symbolic link');
  else parts.push(fileType(entry.path).label);
  if (entry.size !== null) parts.push(formatBytes(entry.size));
  if (entry.status) {
    const s = entry.status;
    parts.push(
      s.staged && s.unstaged
        ? 'Staged, then changed again'
        : `${STATUS_LABEL[s.code] ?? s.code}${s.staged ? ', staged' : s.kind === 'modified' ? ', not staged' : ''}`,
    );
  } else if (entry.changes) parts.push('Has changes inside');
  if (entry.ignored) parts.push('Ignored by .gitignore');
  return parts.join(' · ');
}

const ROW = 28;
const VIRTUALIZE_FROM = 400;
const INDENT = 16;

export function SourceTree({
  label,
  rows,
  focused,
  selected,
  typedIcons,
  onFocus,
  onOpen,
  onToggle,
  onLoadMore,
  onRetry,
  menu,
}: {
  label: string;
  rows: TreeRow[];
  focused: string | null;
  selected: string | null;
  typedIcons: boolean;
  onFocus: (key: string) => void;
  onOpen: (entry: SourceEntry) => void;
  onToggle: (dir: string, open: boolean) => void;
  onLoadMore: (dir: string) => void;
  onRetry: (dir: string) => void;
  menu: (entry: SourceEntry) => ReactNode;
}) {
  const scroller = useRef<HTMLDivElement>(null);
  const virtualize = rows.length >= VIRTUALIZE_FROM;
  const virtual = useVirtualizer({
    count: virtualize ? rows.length : 0,
    enabled: virtualize,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW,
    overscan: 20,
    getItemKey: (index) => rows[index]?.key ?? index,
  });
  const typed = useRef({ text: '', at: 0 });
  const focusIndex = Math.max(
    0,
    rows.findIndex((row) => row.key === focused),
  );

  // Moves DOM focus to a row, scrolling it into the rendered window first when the list is virtual.
  const focusRow = useCallback(
    (index: number) => {
      const row = rows[index];
      if (!row) return;
      onFocus(row.key);
      if (virtualize) virtual.scrollToIndex(index, { align: 'auto' });
      requestAnimationFrame(() =>
        scroller.current
          ?.querySelector<HTMLElement>(`[data-row="${CSS.escape(row.key)}"]`)
          ?.focus({ preventScroll: !virtualize }),
      );
    },
    [rows, onFocus, virtualize, virtual],
  );

  // A focused row that disappeared (its folder closed) hands focus to the nearest row left.
  useEffect(() => {
    if (focused && rows.length && !rows.some((r) => r.key === focused))
      onFocus(rows[Math.min(focusIndex, rows.length - 1)]!.key);
  }, [rows, focused, focusIndex, onFocus]);

  // The WAI-ARIA tree pattern: arrows move, Right opens or steps in, Left closes or steps out,
  // Home and End jump, Enter opens, and typing a name moves to it.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const row = rows[focusIndex];
    if (!row) return;
    const key = event.key;
    if (key === 'ArrowDown')
      focusRow(Math.min(focusIndex + 1, rows.length - 1));
    else if (key === 'ArrowUp') focusRow(Math.max(focusIndex - 1, 0));
    else if (key === 'Home') focusRow(0);
    else if (key === 'End') focusRow(rows.length - 1);
    else if (
      key === 'ArrowRight' &&
      row.kind === 'entry' &&
      row.entry.type === 'dir'
    ) {
      if (!row.open) onToggle(row.entry.path, true);
      else if (rows[focusIndex + 1]) focusRow(focusIndex + 1);
    } else if (key === 'ArrowLeft') {
      if (row.kind === 'entry' && row.open) onToggle(row.entry.path, false);
      else {
        const parent = row.kind === 'entry' ? row.parent : row.dir;
        const at = rows.findIndex((r) => r.key === parent);
        if (at >= 0) focusRow(at);
      }
    } else if (key === 'Enter' || key === ' ') {
      if (row.kind === 'entry') {
        if (row.entry.type === 'dir') onToggle(row.entry.path, !row.open);
        else onOpen(row.entry);
      } else if (row.state === 'more') onLoadMore(row.dir);
      else if (row.state === 'error') onRetry(row.dir);
    } else if (
      key.length === 1 &&
      /\S/.test(key) &&
      !event.ctrlKey &&
      !event.metaKey &&
      !event.altKey
    ) {
      const now = Date.now();
      typed.current.text =
        now - typed.current.at > 600 ? key : typed.current.text + key;
      typed.current.at = now;
      const wanted = typed.current.text.toLowerCase();
      const order = [
        ...rows.slice(focusIndex + 1),
        ...rows.slice(0, focusIndex + 1),
      ];
      const match = order.find(
        (r) =>
          r.kind === 'entry' && r.entry.name.toLowerCase().startsWith(wanted),
      );
      if (match) focusRow(rows.indexOf(match));
    } else return;
    event.preventDefault();
  };

  const renderRow = (row: TreeRow, index: number) => {
    const indent = { paddingLeft: 6 + (row.level - 1) * INDENT };
    if (row.kind === 'status') {
      const busy = row.state === 'loading' || row.state === 'loading-more';
      return (
        <div
          key={row.key}
          data-row={row.key}
          data-index={index}
          role="treeitem"
          aria-level={row.level}
          aria-busy={busy || undefined}
          tabIndex={row.key === rows[focusIndex]?.key ? 0 : -1}
          onFocus={() => onFocus(row.key)}
          className="flex h-7 items-center gap-2 rounded-[4px] pr-2 text-[0.8125rem] text-muted outline-offset-[-2px]"
          style={{ ...indent, paddingLeft: indent.paddingLeft + 20 }}
        >
          {busy && <Spinner />}
          {row.state === 'loading' && 'Loading…'}
          {row.state === 'loading-more' && 'Loading more…'}
          {row.state === 'empty' && 'Empty folder'}
          {row.state === 'error' && (
            <>
              Couldn't read this folder.
              <Button
                size="sm"
                variant="ghost"
                className="h-6 px-1.5"
                tabIndex={-1}
                onClick={() => onRetry(row.dir)}
              >
                <RotateCcw /> Try again
              </Button>
            </>
          )}
          {row.state === 'more' && (
            <Button
              size="sm"
              variant="ghost"
              className="h-6 px-1.5"
              tabIndex={-1}
              onClick={() => onLoadMore(row.dir)}
            >
              Load more
            </Button>
          )}
        </div>
      );
    }
    const { entry } = row;
    const Icon = iconFor(entry, row.open, typedIcons);
    const folder = entry.type === 'dir';
    const isSelected = entry.path === selected;
    const status = entry.status;
    return (
      <ContextMenu key={row.key}>
        <ContextMenuTrigger asChild>
          <div
            data-row={row.key}
            data-index={index}
            role="treeitem"
            aria-level={row.level}
            aria-setsize={row.setsize}
            aria-posinset={row.posinset}
            aria-expanded={folder ? row.open : undefined}
            aria-selected={folder ? undefined : isSelected}
            tabIndex={row.key === rows[focusIndex]?.key ? 0 : -1}
            title={describeEntry(entry)}
            onFocus={() => onFocus(row.key)}
            onClick={() =>
              folder ? onToggle(entry.path, !row.open) : onOpen(entry)
            }
            className={cn(
              'flex h-7 cursor-default items-center gap-1.5 rounded-[4px] pr-2 text-[0.8125rem] outline-offset-[-2px] select-none hover:bg-row-hover',
            )}
            style={indent}
          >
            <ChevronRight
              aria-hidden
              className={cn(
                'size-3.5 shrink-0 text-muted transition-transform',
                folder ? '' : 'invisible',
                row.open && 'rotate-90',
              )}
            />
            {/* The open file is marked by the accent on its icon and name: no fill, no strip. */}
            <Icon
              aria-hidden
              className={cn(
                'size-4 shrink-0',
                isSelected ? 'text-accent' : 'text-muted',
              )}
            />
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                folder || entry.type === 'submodule' ? 'font-medium' : '',
                isSelected
                  ? 'font-semibold text-accent'
                  : entry.ignored
                    ? 'text-muted'
                    : 'text-ink',
              )}
            >
              {entry.name}
            </span>
            {entry.ignored && (
              <EyeOff aria-hidden className="size-3.5 shrink-0 text-muted" />
            )}
            {status ? (
              <span
                className={cn(
                  'grid h-5 min-w-5 shrink-0 place-items-center rounded-[4px] px-1 font-mono text-[0.71875rem] font-semibold text-ink',
                  status.kind === 'conflict' ? 'bg-danger-soft' : 'bg-control',
                )}
              >
                <span aria-hidden>{status.code}</span>
              </span>
            ) : (
              entry.changes && (
                <span
                  aria-hidden
                  className="shrink-0 font-mono text-[0.71875rem] text-muted"
                >
                  M
                </span>
              )
            )}
            <span className="sr-only">{describeEntry(entry)}</span>
          </div>
        </ContextMenuTrigger>
        <ContextMenuContent>{menu(entry)}</ContextMenuContent>
      </ContextMenu>
    );
  };

  return (
    <div
      ref={scroller}
      role="tree"
      aria-label={label}
      onKeyDown={onKeyDown}
      className="min-h-0 flex-1 overflow-auto px-2 pb-2"
    >
      {virtualize ? (
        <div
          className="relative w-full"
          style={{ height: virtual.getTotalSize() }}
        >
          <div
            className="absolute top-0 left-0 w-full"
            style={{
              transform: `translateY(${virtual.getVirtualItems()[0]?.start ?? 0}px)`,
            }}
          >
            {virtual
              .getVirtualItems()
              .map((item) => renderRow(rows[item.index]!, item.index))}
          </div>
        </div>
      ) : (
        rows.map(renderRow)
      )}
    </div>
  );
}
