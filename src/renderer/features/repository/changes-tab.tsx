import { useVirtualizer } from '@tanstack/react-virtual';
import {
  ArrowLeft,
  Code2,
  Copy,
  ExternalLink,
  File as PlainFile,
  FileText,
  FolderGit2,
  FolderOpen,
  GitMerge,
  Lock,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Trash2,
  TriangleAlert,
} from 'lucide-react';
import {
  createContext,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { fileType } from '../../../shared/file-types';
import type {
  ChangedFile,
  ConflictKind,
  RepositorySummary,
} from '../../../shared/repos';
import type { DiffSide, WriteResult } from '../../../shared/workspace';
import {
  DiffArt,
  GitMissingArt,
  NoResultsArt,
  OfflineArt,
  RepositoriesArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import { EmptyState } from '../../components/ui/empty-state';
import { InlineStatus, Loading } from '../../components/ui/status';
import { useToast } from '../../components/ui/toast';
import { useNavigation } from '../../app/navigation';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/cn';
import { formatBytes } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useWidth as useWidthOf } from '../../lib/use-width';
import {
  useCopyFilePath,
  useDiscard,
  useDiscardAll,
  useGitInstall,
  useOpenGitInstallPage,
  useOpenInEditor,
  usePathPending,
  useRevealDiscarded,
  useSettings,
  useRefreshRepositories,
  useRepositoryChanges,
  useRevealFile,
  useStage,
  useStageAll,
  useUnstage,
} from '../../lib/queries';
import { fileManagerLabel } from '../repos/repo-actions';
import { ConflictsView } from '../pulls/merge-tab';
import { FILE_ICONS } from '../source/file-icons';
import { CommitForm } from './commit-form';
import { DiffView } from './diff-view';
import { EditorLogo, hasEditorLogo, useEditorName } from './editor-button';
import { SummaryStrip } from './history';

type Group = {
  key: DiffSide;
  title: string;
  meta: string;
  files: ChangedFile[];
};

const SIDE: Record<ChangedFile['kind'], DiffSide> = {
  staged: 'staged',
  modified: 'unstaged',
  untracked: 'untracked',
  conflict: 'conflict',
};

const CODE_LABEL: Record<string, string> = {
  M: 'Modified',
  A: 'Added',
  D: 'Deleted',
  R: 'Renamed',
  C: 'Copied',
  T: 'Type changed',
  U: 'Conflict',
  '?': 'Untracked',
};

// Yours and incoming, the words the conflict screen uses for a merge started outside gitdesk.
const CONFLICT_WORDS: Record<ConflictKind, string> = {
  'both-modified': 'Both sides changed it',
  'both-added': 'Both sides added it',
  'both-deleted': 'Both sides deleted it',
  'added-by-us': 'Added on your side only',
  'added-by-them': 'Added on the incoming side only',
  'deleted-by-us': 'You deleted it, incoming changed it',
  'deleted-by-them': 'You changed it, incoming deleted it',
};

// Lists past this many rows render only what is on screen.
const VIRTUALIZE_FROM = 200;

// A whole-file write that did not apply: the list shows why, once, with the step that helps.
type WriteProblem = {
  result: Exclude<WriteResult, { status: 'applied' }>;
  retry: () => void;
};
// Rows, bands and the bulk bar report their write results here; true means it applied.
const ReportWrite = createContext<
  (result: WriteResult, retry: () => void) => boolean
>((result) => result.status === 'applied');

function WriteBand({
  problem,
  onDismiss,
}: {
  problem: WriteProblem;
  onDismiss: () => void;
}) {
  const { result } = problem;
  return (
    <div
      role="alert"
      className="flex flex-wrap items-center gap-3 bg-warning-soft px-3 py-2.5 text-[0.8125rem] text-ink"
    >
      {result.status === 'rejected' && result.reason === 'busy' ? (
        <Lock aria-hidden className="size-4 text-warning" />
      ) : (
        <TriangleAlert aria-hidden className="size-4 text-warning" />
      )}
      <span className="min-w-0 flex-1">
        {result.status === 'stale' ? (
          <>
            <b className="font-semibold">
              The files moved on before Git ran this.
            </b>{' '}
            Nothing changed, and the list now shows what Git reports.
          </>
        ) : result.reason === 'busy' ? (
          result.message
        ) : (
          <>
            <b className="font-semibold">Git took too long to answer.</b> Part
            of it may have run; the list shows what Git did.
          </>
        )}
      </span>
      {result.status === 'stale' ? (
        <Button size="sm" className="bg-surface" onClick={onDismiss}>
          Got it
        </Button>
      ) : (
        <Button
          size="sm"
          className="bg-surface"
          onClick={() => {
            onDismiss();
            problem.retry();
          }}
        >
          Try again
        </Button>
      )}
    </div>
  );
}

// What Git reports about a row beyond its letter, in words, so nothing rests on the letter alone.
function detailOf(file: ChangedFile): string | null {
  if (file.conflict) return CONFLICT_WORDS[file.conflict];
  if (file.submodule && file.submoduleState) {
    const { commit, tracked, untracked } = file.submoduleState;
    const parts = [
      commit && 'new commit',
      tracked && 'edits inside',
      untracked && 'new files inside',
    ].filter(Boolean);
    return `Submodule${parts.length ? ` · ${parts.join(', ')}` : ''}`;
  }
  if (file.submodule) return 'Submodule';
  if (file.origPath)
    return `${file.code === 'C' ? 'Copied' : 'Renamed'} from ${file.origPath}`;
  if (file.code === 'T') return 'Type changed (file, link or submodule)';
  if (file.modeChange) return `Mode ${file.modeChange}`;
  if (file.kind === 'untracked' && file.path.endsWith('/')) return 'New folder';
  return null;
}

const keyOf = (file: ChangedFile) => `${SIDE[file.kind]}:${file.path}`;
const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

function splitPath(path: string): [string, string] {
  const slash = path.lastIndexOf('/');
  return slash < 0
    ? ['', path]
    : [path.slice(0, slash + 1), path.slice(slash + 1)];
}

// The removal named in full: unstaged edits go back to the staged version, new files go to the trash.
function DiscardBand({
  repoId,
  files,
  onDone,
  everything = false,
}: {
  repoId: string;
  files: ChangedFile[];
  onDone: () => void;
  // Discard staged and working changes: back to HEAD, not just to the staged version.
  everything?: boolean;
}) {
  const unstaged = useDiscard(repoId);
  const all = useDiscardAll(repoId);
  const discard = everything ? all : unstaged;
  const reveal = useRevealDiscarded();
  const toast = useToast();
  const report = useContext(ReportWrite);
  const { data: settings } = useSettings();
  const keepCopy = settings?.changesKeepDiscarded ?? true;
  const tracked = files.filter((f) => f.kind === 'modified');
  const untracked = files.filter((f) => f.kind === 'untracked');
  const names =
    files.length === 1 ? files[0]!.path : plural(files.length, 'file');
  const paths = files.map((f) => f.path);
  const start = () => discard.mutate(paths, { onSuccess: done });
  function done(result: WriteResult) {
    if (!report(result, start) || result.status !== 'applied') {
      onDone();
      return;
    }
    toast({
      tone: 'success',
      title: `Discarded changes in ${names}`,
      description: result.saved ? 'A copy is in Discarded changes.' : undefined,
      action: result.saved
        ? {
            label: 'Reveal',
            altText: 'Show the saved copy',
            onClick: () => reveal.mutate(repoId),
          }
        : undefined,
    });
    onDone();
  }
  return (
    <div
      role="group"
      aria-label={`Discard changes to ${names}`}
      className="grid gap-2.5 bg-danger-soft px-3 py-2.5 text-[0.8125rem] text-ink"
    >
      <p className="leading-relaxed">
        {everything ? (
          <>
            Discard everything in{' '}
            <b className="font-mono font-semibold">{names}</b> since the last
            commit? The staged changes and the edits after them both go, and{' '}
            {files.length === 1 ? 'the file returns' : 'the files return'} to
            how {files.length === 1 ? 'it is' : 'they are'} in HEAD.{' '}
          </>
        ) : (
          <>
            Discard your unstaged changes to{' '}
            <b className="font-mono font-semibold">{names}</b>?{' '}
            {tracked.length > 0 &&
              `${tracked.length === files.length ? 'They go' : `${plural(tracked.length, 'edited file')} go`} back to the staged version. `}
            {untracked.length > 0 &&
              `${plural(untracked.length, 'new file')} ${untracked.length === 1 ? 'moves' : 'move'} to the trash. `}
          </>
        )}
        {tracked.length > 0 || everything
          ? keepCopy
            ? 'gitdesk saves a copy of the changes first.'
            : "Keeping a copy is off in Settings, so this can't be undone."
          : ''}
      </p>
      {files.length > 1 && (
        <ul className="max-h-28 overflow-auto font-mono text-[0.78125rem]">
          {files.map((f) => (
            <li key={keyOf(f)}>{f.path}</li>
          ))}
        </ul>
      )}
      {discard.isError && (
        <InlineStatus tone="danger">
          {ipcErrorMessage(discard.error, 'Nothing was discarded. Try again.')}
        </InlineStatus>
      )}
      <div className="flex flex-wrap gap-2">
        <Button
          size="sm"
          variant="danger"
          className="bg-surface"
          pending={discard.isPending}
          onClick={start}
        >
          {everything ? 'Discard staged and working changes' : 'Discard'}
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone} autoFocus>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// Stage, unstage or (for a conflict) open the resolver. Its spinner shows whichever control
// started a write for this path.
function StageButton({
  repoId,
  file,
  onResolve,
}: {
  repoId: string;
  file: ChangedFile;
  onResolve: () => void;
}) {
  const write = useFileWrite(repoId, file);
  const pending = usePathPending(repoId, file.path);
  const staged = file.kind === 'staged';
  const conflict = file.kind === 'conflict';
  const verb = staged ? 'Unstage' : conflict ? 'Resolve' : 'Stage';
  return (
    <Tooltip label={conflict ? 'Resolve…' : verb} side="left">
      <Button
        size="icon"
        variant="ghost"
        aria-label={`${verb} ${file.path}`}
        data-stage
        pending={pending}
        onClick={(event) => {
          event.stopPropagation();
          if (conflict) onResolve();
          else write();
        }}
      >
        {!pending && (staged ? <Minus /> : conflict ? <GitMerge /> : <Plus />)}
      </Button>
    </Tooltip>
  );
}

// Stage or unstage one file, reporting stale, busy and timeout to the list and errors as a toast.
function useFileWrite(repoId: string, file: ChangedFile) {
  const stage = useStage(repoId);
  const unstage = useUnstage(repoId);
  const report = useContext(ReportWrite);
  const toast = useToast();
  const staged = file.kind === 'staged';
  const run = () =>
    (staged ? unstage : stage).mutate([file.path], {
      onSuccess: (result) => void report(result, run),
      onError: (err) =>
        toast({
          tone: 'danger',
          title: staged ? 'Not unstaged' : 'Not staged',
          description: ipcErrorMessage(err, 'Try again in a moment.'),
        }),
    });
  return run;
}

function FileRow({
  repoId,
  file,
  selected,
  checked,
  onCheck,
  onSelect,
  onDiscard,
  onDiscardAll,
  focusable,
  expanded,
  groupId,
}: {
  repoId: string;
  file: ChangedFile;
  selected: boolean;
  checked: boolean;
  onCheck: (checked: boolean) => void;
  onSelect: () => void;
  onDiscard: () => void;
  onDiscardAll: () => void;
  focusable: boolean;
  expanded?: boolean;
  // The group heading, so a screen reader hears "Staged" with the row.
  groupId: string;
}) {
  const [dir, name] = splitPath(file.path);
  const { data: settings } = useSettings();
  // The same glyphs as the Files tab, so a file looks the same in both places.
  const Icon = file.submodule
    ? FolderGit2
    : (settings?.sourceFileIcons ?? true)
      ? FILE_ICONS[fileType(file.path).icon]
      : PlainFile;
  const detail = detailOf(file);
  const editor = useEditorName(repoId);
  const { navigate } = useNavigation();
  const reveal = useRevealFile(repoId);
  const copy = useCopyFilePath(repoId);
  const open = useOpenInEditor(repoId);
  const write = useFileWrite(repoId, file);
  const toast = useToast();
  const failed = (title: string) => (err: unknown) =>
    toast({
      tone: 'danger',
      title,
      description: ipcErrorMessage(err, 'Try again in a moment.'),
    });
  const canDiscard = file.kind === 'modified' || file.kind === 'untracked';
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <div
          role="option"
          aria-selected={selected}
          aria-expanded={expanded}
          aria-describedby={groupId}
          tabIndex={focusable ? 0 : -1}
          data-key={keyOf(file)}
          onClick={onSelect}
          className={cn(
            'grid min-h-9 cursor-default grid-cols-[1rem_1rem_1.5rem_minmax(0,1fr)_auto_2rem] items-center gap-2 border-b border-line py-1 pr-1.5 pl-3 outline-offset-[-2px] transition-colors',
            selected ? 'bg-accent-soft' : 'hover:bg-row-hover',
          )}
        >
          <Checkbox
            checked={checked}
            onCheckedChange={(value) => onCheck(value === true)}
            onClick={(event) => event.stopPropagation()}
            aria-label={`Select ${file.path}`}
            tabIndex={-1}
          />
          <Icon aria-hidden className="size-4 text-muted" />
          <span
            className={cn(
              'grid h-5 place-items-center rounded-[4px] font-mono text-[0.71875rem] font-semibold text-ink',
              file.kind === 'conflict' ? 'bg-danger-soft' : 'bg-control',
            )}
            title={CODE_LABEL[file.code] ?? file.code}
          >
            <span aria-hidden>{file.code}</span>
            <span className="sr-only">
              {CODE_LABEL[file.code] ?? file.code}
            </span>
          </span>
          <span className="min-w-0" title={file.path}>
            <span className="block truncate font-mono text-[0.78125rem] text-ink">
              <span className="text-muted">{dir}</span>
              {name}
            </span>
            {detail && (
              <span className="block truncate text-xs text-muted">
                {detail}
              </span>
            )}
          </span>
          <span className="text-xs whitespace-nowrap text-muted tabular-nums">
            {file.binary ? (
              typeof file.size === 'number' ? (
                `Binary · ${formatBytes(file.size)}`
              ) : (
                'Binary'
              )
            ) : file.added !== undefined ? (
              <>
                {file.added > 0 && (
                  <b className="font-semibold text-success">+{file.added}</b>
                )}{' '}
                {(file.removed ?? 0) > 0 && (
                  <b className="font-semibold text-danger">−{file.removed}</b>
                )}
                <span className="sr-only">
                  {` ${file.added} added, ${file.removed ?? 0} removed`}
                </span>
              </>
            ) : null}
          </span>
          <StageButton repoId={repoId} file={file} onResolve={onSelect} />
        </div>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {file.kind === 'staged' ? (
          <ContextMenuItem onSelect={write}>
            <Minus /> Unstage
          </ContextMenuItem>
        ) : file.kind === 'conflict' ? (
          <ContextMenuItem onSelect={onSelect}>
            <GitMerge /> Resolve…
          </ContextMenuItem>
        ) : (
          <ContextMenuItem onSelect={write}>
            <Plus /> Stage
          </ContextMenuItem>
        )}
        {canDiscard && (
          <ContextMenuItem
            onSelect={onDiscard}
            className="text-danger [&_svg]:text-danger"
          >
            <Trash2 /> Discard unstaged changes…
          </ContextMenuItem>
        )}
        {(file.kind === 'staged' || file.kind === 'modified') && (
          <ContextMenuItem
            onSelect={onDiscardAll}
            className="text-danger [&_svg]:text-danger"
          >
            <Trash2 /> Discard staged and working changes…
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        {file.code !== 'D' && (
          <ContextMenuItem
            onSelect={() =>
              navigate({
                name: 'repository',
                id: repoId,
                tab: 'source',
                source: { path: file.path },
              })
            }
          >
            <FileText /> Open in Files
          </ContextMenuItem>
        )}
        <ContextMenuItem
          onSelect={() =>
            open.mutate(
              { path: file.code === 'D' ? null : file.path, line: null },
              { onError: failed("Couldn't open it") },
            )
          }
        >
          {hasEditorLogo(editor.id, editor.icon) ? (
            <EditorLogo id={editor.id} icon={editor.icon} />
          ) : (
            <Code2 />
          )}{' '}
          {editor.id === 'system' ? 'Open' : `Open in ${editor.name}`}
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            copy.mutate(file.path, {
              onSuccess: () => toast({ tone: 'success', title: 'Path copied' }),
              onError: failed("Couldn't copy the path"),
            })
          }
        >
          <Copy /> Copy path
        </ContextMenuItem>
        <ContextMenuItem
          onSelect={() =>
            reveal.mutate(file.path, { onError: failed("Couldn't show it") })
          }
        >
          <FolderOpen /> {fileManagerLabel()}
        </ContextMenuItem>
      </ContextMenuContent>
    </ContextMenu>
  );
}

function BulkBar({
  repoId,
  files,
  onClear,
  onDiscard,
}: {
  repoId: string;
  files: ChangedFile[];
  onClear: () => void;
  onDiscard: () => void;
}) {
  const stage = useStage(repoId);
  const unstage = useUnstage(repoId);
  const report = useContext(ReportWrite);
  // Conflicts resolve on their own screen, never by a bulk stage.
  const toStage = files.filter(
    (f) => f.kind !== 'staged' && f.kind !== 'conflict',
  );
  const toUnstage = files.filter((f) => f.kind === 'staged');
  const stageThem = () =>
    stage.mutate(
      toStage.map((f) => f.path),
      { onSuccess: (result) => report(result, stageThem) && onClear() },
    );
  const unstageThem = () =>
    unstage.mutate(
      toUnstage.map((f) => f.path),
      { onSuccess: (result) => report(result, unstageThem) && onClear() },
    );
  const canDiscard = files.every(
    (f) => f.kind === 'modified' || f.kind === 'untracked',
  );
  const failed = stage.error ?? unstage.error;
  return (
    <div
      role="toolbar"
      aria-label="Selected files"
      className="flex flex-wrap items-center gap-2 bg-accent-soft px-3 py-2 text-[0.8125rem] text-ink"
    >
      <span className="mr-auto font-medium">
        {plural(files.length, 'file')} selected
      </span>
      {toStage.length > 0 && (
        <Button
          size="sm"
          className="bg-surface"
          pending={stage.isPending}
          onClick={stageThem}
        >
          Stage {toStage.length}
        </Button>
      )}
      {toUnstage.length > 0 && (
        <Button
          size="sm"
          className="bg-surface"
          pending={unstage.isPending}
          onClick={unstageThem}
        >
          Unstage {toUnstage.length}
        </Button>
      )}
      {canDiscard && (
        <Button
          size="sm"
          variant="danger"
          className="bg-surface"
          onClick={onDiscard}
        >
          Discard…
        </Button>
      )}
      <Button size="sm" variant="ghost" onClick={onClear}>
        Clear
      </Button>
      {failed && (
        <InlineStatus tone="danger" className="basis-full">
          {ipcErrorMessage(failed, 'That didn’t work. Try again.')}
        </InlineStatus>
      )}
    </div>
  );
}

// One row of the flat list: a group heading, a file, a band under a file, or (centered) its diff.
type Item =
  | { type: 'group'; group: Group }
  | { type: 'file'; file: ChangedFile; group: Group }
  | { type: 'discard'; file: ChangedFile; everything: boolean }
  | { type: 'inline'; file: ChangedFile };

const itemKey = (item: Item) =>
  item.type === 'group'
    ? `group:${item.group.key}`
    : `${item.type}${item.type === 'discard' && item.everything ? '-all' : ''}:${keyOf(item.file)}`;

// Changed files, grouped the way Git keeps them apart, with their diffs and the commit form.
export function ChangesTab({
  repo,
  layout,
}: {
  repo: RepositorySummary;
  layout: 'split' | 'centered' | 'narrow';
}) {
  const refresh = useRefreshRepositories();
  const stageAll = useStageAll(repo.id);
  const toast = useToast();
  const gitInstall = useGitInstall();
  const installGit = useOpenGitInstallPage();
  const changes = useRepositoryChanges(
    repo.id,
    repo.statusAt,
    repo.status !== null,
  );
  const [filter, setFilter] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  // Where Shift+arrow ranges start: the row last checked or moved from.
  const [checkAnchor, setCheckAnchor] = useState<string | null>(null);
  const [discarding, setDiscarding] = useState<string[] | null>(null);
  // Discard staged and working changes, for one file, named by its row key.
  const [discardingAll, setDiscardingAll] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [writeProblem, setWriteProblem] = useState<WriteProblem | null>(null);
  const report = (result: WriteResult, retry: () => void) => {
    if (result.status === 'applied') {
      setWriteProblem(null);
      return true;
    }
    setWriteProblem({ result, retry });
    return false;
  };
  const scroller = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const files = changes.data?.files ?? [];
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  }, [files, filter]);
  const groups: Group[] = [
    {
      key: 'conflict',
      title: 'Conflicts',
      meta: 'Open each file to resolve it',
      files: shown.filter((f) => f.kind === 'conflict'),
    },
    {
      key: 'staged',
      title: 'Staged',
      meta: 'Goes into the next commit',
      files: shown.filter((f) => f.kind === 'staged'),
    },
    {
      key: 'unstaged',
      title: 'Not staged',
      meta: 'Working tree compared with the index',
      files: shown.filter((f) => f.kind === 'modified'),
    },
    {
      key: 'untracked',
      title: 'Untracked',
      meta: 'New files; ignored files stay hidden',
      files: shown.filter((f) => f.kind === 'untracked'),
    },
  ].filter((group) => group.files.length > 0) as Group[];
  const ordered = groups.flatMap((g) => g.files);
  const selected = ordered.find((f) => keyOf(f) === selectedKey) ?? null;
  const inlineDiffs = layout === 'centered';

  const items: Item[] = [];
  for (const group of groups) {
    items.push({ type: 'group', group });
    for (const file of group.files) {
      const key = keyOf(file);
      items.push({ type: 'file', file, group });
      if (discarding?.length === 1 && discarding[0] === key)
        items.push({ type: 'discard', file, everything: false });
      if (discardingAll === key)
        items.push({ type: 'discard', file, everything: true });
      if (inlineDiffs && key === selectedKey)
        items.push({ type: 'inline', file });
    }
  }
  // Most lists render whole; a big one (thousands of generated files) renders what is on screen.
  const virtualize = items.length > VIRTUALIZE_FROM;
  const scrollMargin = inlineDiffs ? (listRef.current?.offsetTop ?? 0) : 0;
  const virtual = useVirtualizer({
    count: virtualize ? items.length : 0,
    enabled: virtualize,
    getScrollElement: () => scroller.current,
    estimateSize: (index) => (items[index]?.type === 'group' ? 44 : 37),
    overscan: 12,
    scrollMargin,
    getItemKey: (index) => (items[index] ? itemKey(items[index]) : index),
  });

  // A selection that left the list (staged, committed elsewhere) moves to the nearest file.
  useEffect(() => {
    if (layout === 'split' && !selected && ordered.length && selectedKey)
      setSelectedKey(keyOf(ordered[0]!));
    setChecked((current) => {
      const keep = new Set(
        [...current].filter((key) => ordered.some((f) => keyOf(f) === key)),
      );
      return keep.size === current.size ? current : keep;
    });
    // Only a new file list can strand the selection; reacting to it alone avoids a render loop.
  }, [files]);

  const checkedFiles = ordered.filter((f) => checked.has(keyOf(f)));
  const discardFiles = discarding
    ? files.filter((f) => discarding.includes(keyOf(f)))
    : [];
  const status = repo.status;

  // Moves focus to a file's row, scrolling it into the rendered window first when virtual.
  const focusFile = (file: ChangedFile) => {
    const key = keyOf(file);
    setSelectedKey(key);
    const at = items.findIndex(
      (item) => item.type === 'file' && keyOf(item.file) === key,
    );
    if (virtualize && at >= 0) virtual.scrollToIndex(at, { align: 'auto' });
    requestAnimationFrame(() =>
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(`[data-key="${CSS.escape(key)}"]`)
          ?.focus(),
      ),
    );
  };

  const setRange = (from: string, to: string) => {
    const a = ordered.findIndex((f) => keyOf(f) === from);
    const b = ordered.findIndex((f) => keyOf(f) === to);
    if (a < 0 || b < 0) return;
    setChecked((current) => {
      const next = new Set(current);
      for (let i = Math.min(a, b); i <= Math.max(a, b); i++)
        next.add(keyOf(ordered[i]!));
      return next;
    });
  };

  const move = (event: KeyboardEvent<HTMLElement>) => {
    if (!ordered.length) return;
    const target = event.target as HTMLElement;
    if (target.getAttribute('role') !== 'option') return;
    // The keys act on the focused row: Tab can land on one before any row is selected.
    const current =
      ordered.find((f) => keyOf(f) === target.dataset.key) ?? selected;
    const index = Math.max(0, current ? ordered.indexOf(current) : 0);
    const go = (next: ChangedFile) => {
      if (event.shiftKey) {
        const from = checkAnchor ?? keyOf(ordered[index]!);
        setCheckAnchor(from);
        setRange(from, keyOf(next));
      } else setCheckAnchor(keyOf(next));
      focusFile(next);
    };
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      go(
        ordered[
          Math.min(
            ordered.length - 1,
            Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)),
          )
        ]!,
      );
    } else if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      go(event.key === 'Home' ? ordered[0]! : ordered.at(-1)!);
    } else if (event.key.toLowerCase() === 'x' && current) {
      event.preventDefault();
      toggleCheck(current, !checked.has(keyOf(current)));
      setCheckAnchor(keyOf(current));
    } else if (event.key === ' ' && current) {
      event.preventDefault();
      target.querySelector<HTMLElement>('[data-stage]')?.click();
    } else if (event.key === 'Enter' && current) {
      event.preventDefault();
      setSelectedKey(keyOf(current));
      if (layout === 'narrow') setShowDiff(true);
    }
  };

  const conflicted = (status?.conflicts ?? 0) > 0;
  const runStageAll = () =>
    stageAll.mutate(undefined, {
      onSuccess: (result) => void report(result, runStageAll),
      onError: (err) =>
        toast({
          tone: 'danger',
          title: 'Not staged',
          description: ipcErrorMessage(err, 'Try again.'),
        }),
    });
  const stageAllButton = (
    <Button
      size="sm"
      pending={stageAll.isPending}
      aria-disabled={conflicted || undefined}
      aria-describedby={conflicted ? 'stage-all-why' : undefined}
      onClick={() => !conflicted && runStageAll()}
    >
      Stage all
    </Button>
  );
  const stageAllWhy = conflicted && (
    <p id="stage-all-why" className="basis-full text-xs text-muted">
      Stage all waits until the conflicts are resolved, so it can't mark them
      resolved by accident.
    </p>
  );
  const filterField = (
    <label className="field flex h-8 min-w-0 flex-1 items-center gap-2 px-2.5 text-muted">
      <Search aria-hidden className="size-4 shrink-0" />
      <span className="sr-only">Filter changed files</span>
      <input
        type="search"
        value={filter}
        onChange={(event) => setFilter(event.target.value)}
        onKeyDown={(event) => event.key === 'Escape' && setFilter('')}
        placeholder="Filter files"
        className="min-w-0 flex-1 bg-transparent text-[0.8125rem] text-ink outline-none placeholder:text-muted"
      />
    </label>
  );

  const toggleCheck = (file: ChangedFile, value: boolean) =>
    setChecked((current) => {
      const next = new Set(current);
      if (value) next.add(keyOf(file));
      else next.delete(keyOf(file));
      return next;
    });

  const install = gitInstall.data;
  if (install && (!install.available || install.tooOld))
    return (
      <EmptyState
        art={<GitMissingArt />}
        title={
          install.available
            ? `Git ${install.version} is too old for gitdesk`
            : 'Git is not installed'
        }
        action={
          <Button
            variant="primary"
            pending={installGit.isPending}
            onClick={() => installGit.mutate()}
          >
            {!installGit.isPending && <ExternalLink />}
            Download Git
          </Button>
        }
      >
        {install.available
          ? `Changes needs Git ${install.minimum} or newer to read staged and unstaged files safely. Install a newer Git, then come back.`
          : 'Changes reads everything from Git on this computer. Install it, then come back.'}
      </EmptyState>
    );
  if (!status)
    return (
      <div className="px-6">
        <Loading label="Checking this repository…" />
      </div>
    );
  if (changes.isPending)
    return (
      <div className="px-6">
        <Loading label="Reading changes…" />
      </div>
    );
  if (changes.isError)
    return (
      <EmptyState
        art={<OfflineArt />}
        title="Couldn't read the changes"
        action={
          <Button
            pending={changes.isFetching}
            onClick={() => void changes.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(changes.error, 'Git did not answer.')}
      </EmptyState>
    );
  if (!files.length)
    return (
      <EmptyState
        art={<RepositoriesArt />}
        title="Working tree is clean"
        action={
          <Button
            pending={refresh.isPending || repo.inspecting}
            onClick={() => refresh.mutate(repo.id)}
          >
            {!(refresh.isPending || repo.inspecting) && <RefreshCw />}
            Refresh status
          </Button>
        }
      >
        Edits you save in this folder show up here within a moment.
      </EmptyState>
    );

  const renderItem = (item: Item) => {
    if (item.type === 'group') {
      const { group } = item;
      const allChecked = group.files.every((f) => checked.has(keyOf(f)));
      const some = group.files.some((f) => checked.has(keyOf(f)));
      return (
        <div
          role="presentation"
          className={cn(
            'flex items-center gap-2 border-b border-line pr-2.5 pl-3',
            inlineDiffs ? 'mt-8 pb-2 pl-0' : 'pt-3.5 pb-1.5',
          )}
        >
          <Checkbox
            checked={allChecked ? true : some ? 'indeterminate' : false}
            onCheckedChange={(value) =>
              group.files.forEach((f) => toggleCheck(f, value === true))
            }
            aria-label={`Select all ${group.title.toLowerCase()}`}
          />
          <h3
            id={`group-${group.key}`}
            className={cn(
              'font-semibold text-ink',
              inlineDiffs ? 'text-[0.9375rem]' : 'text-xs',
            )}
          >
            {group.title}
          </h3>
          <span className="text-xs text-muted">{group.files.length}</span>
          {inlineDiffs && (
            <span className="ml-auto text-xs text-muted">{group.meta}</span>
          )}
        </div>
      );
    }
    const { file } = item;
    const key = keyOf(file);
    if (item.type === 'discard')
      return (
        <div role="presentation">
          <DiscardBand
            everything={item.everything}
            repoId={repo.id}
            files={[file]}
            onDone={() =>
              item.everything ? setDiscardingAll(null) : setDiscarding(null)
            }
          />
        </div>
      );
    if (item.type === 'inline')
      return (
        <div role="presentation" className="border-b border-line py-3">
          {file.kind === 'conflict' ? (
            <ConflictsView
              repo={repo}
              pullSource=""
              pullTarget=""
              external
              initialPath={file.path}
            />
          ) : (
            <DiffView
              repoId={repo.id}
              path={file.path}
              side={SIDE[file.kind]}
              statusAt={repo.statusAt}
              width={900}
              inline
            />
          )}
        </div>
      );
    const isSelected = key === selectedKey;
    return (
      <FileRow
        repoId={repo.id}
        file={file}
        groupId={`group-${item.group.key}`}
        selected={isSelected}
        expanded={inlineDiffs ? isSelected : undefined}
        checked={checked.has(key)}
        onCheck={(value) => {
          toggleCheck(file, value);
          setCheckAnchor(key);
        }}
        onSelect={() => {
          setSelectedKey(inlineDiffs && isSelected ? null : key);
          if (layout === 'narrow') setShowDiff(true);
        }}
        onDiscard={() => setDiscarding([key])}
        onDiscardAll={() => setDiscardingAll(key)}
        focusable={isSelected || (!selectedKey && file === ordered[0])}
      />
    );
  };

  const uniquePaths = new Set(files.map((f) => f.path)).size;
  // Outside the list's scroll area, so it is seen whichever row started the write.
  const writeBand = writeProblem && (
    <WriteBand problem={writeProblem} onDismiss={() => setWriteProblem(null)} />
  );
  const list = (
    <ReportWrite.Provider value={report}>
      {/* Above the rows, not after 5,000 of them, so it is read before the list is trusted. */}
      {changes.data.truncated && (
        <p className="border-b border-line px-3 py-2 text-xs text-muted">
          Showing the first {uniquePaths.toLocaleString()} of{' '}
          {changes.data.total.toLocaleString()} changed paths. The filter
          searches these only, and Stage all still includes the rest. Adding a
          generated folder to .gitignore brings the list under the limit.
        </p>
      )}
      {checkedFiles.length > 0 && (
        <BulkBar
          repoId={repo.id}
          files={checkedFiles}
          onClear={() => setChecked(new Set())}
          onDiscard={() => setDiscarding(checkedFiles.map(keyOf))}
        />
      )}
      {discarding && discardFiles.length > 1 && (
        <DiscardBand
          repoId={repo.id}
          files={discardFiles}
          onDone={() => {
            setDiscarding(null);
            setChecked(new Set());
          }}
        />
      )}
      {!groups.length ? (
        <EmptyState
          compact
          className="px-3"
          art={<NoResultsArt />}
          title={`No changed files match "${filter.trim()}"`}
          action={
            <Button size="sm" onClick={() => setFilter('')}>
              Clear filter
            </Button>
          }
        >
          {changes.data.truncated
            ? `The filter searched the first ${uniquePaths.toLocaleString()} of ${changes.data.total.toLocaleString()} changed paths.`
            : `The filter checks file paths. ${plural(uniquePaths, 'file')} changed in total.`}
        </EmptyState>
      ) : (
        <div
          ref={listRef}
          role="listbox"
          aria-label="Changed files"
          aria-multiselectable
          onKeyDown={move}
          className={cn(!inlineDiffs && 'border-t border-line', 'relative')}
          style={virtualize ? { height: virtual.getTotalSize() } : undefined}
        >
          {virtualize
            ? virtual.getVirtualItems().map((row) => (
                <div
                  key={row.key}
                  role="none"
                  data-index={row.index}
                  ref={virtual.measureElement}
                  className="absolute top-0 left-0 w-full"
                  style={{
                    transform: `translateY(${row.start - scrollMargin}px)`,
                  }}
                >
                  {renderItem(items[row.index]!)}
                </div>
              ))
            : items.map((item) => (
                <div key={itemKey(item)} role="none">
                  {renderItem(item)}
                </div>
              ))}
        </div>
      )}
    </ReportWrite.Provider>
  );

  const diffActions = (file: ChangedFile) =>
    file.kind === 'modified' || file.kind === 'untracked' ? (
      <Button
        size="sm"
        variant="danger"
        onClick={() => setDiscarding([keyOf(file)])}
      >
        Discard…
      </Button>
    ) : file.kind === 'staged' ? (
      <Button
        size="sm"
        variant="danger"
        onClick={() => setDiscardingAll(keyOf(file))}
      >
        Discard…
      </Button>
    ) : null;
  // Alt+Up/Down and the toolbar arrows walk the list in its on-screen order.
  const step = (delta: -1 | 1) => {
    if (!selected) return;
    const index = ordered.findIndex((f) => keyOf(f) === keyOf(selected));
    const next = ordered[index + delta];
    if (next) setSelectedKey(keyOf(next));
  };
  const conflictView = (path: string) => (
    <div className="min-h-0 flex-1 overflow-auto px-4 pb-6 @container">
      <ConflictsView
        repo={repo}
        pullSource=""
        pullTarget=""
        external
        initialPath={path}
      />
    </div>
  );
  // The list shows write problems; the narrow diff, which replaces the list, shows its own.
  const selectedBands = (file: ChangedFile, problems: boolean) => (
    <ReportWrite.Provider value={report}>
      {problems && writeBand}
      {discarding?.length === 1 && discarding[0] === keyOf(file) && (
        <DiscardBand
          repoId={repo.id}
          files={[file]}
          onDone={() => setDiscarding(null)}
        />
      )}
      {discardingAll === keyOf(file) && (
        <DiscardBand
          everything
          repoId={repo.id}
          files={[file]}
          onDone={() => setDiscardingAll(null)}
        />
      )}
    </ReportWrite.Provider>
  );

  // Lines from each comparison on its own; staged and unstaged lines are never added together.
  function lineCounts(kind: 'staged' | 'modified', comparison: string) {
    const rows = files.filter((f) => f.kind === kind && !f.binary);
    const added = rows.reduce((n, f) => n + (f.added ?? 0), 0);
    const removed = rows.reduce((n, f) => n + (f.removed ?? 0), 0);
    return rows.length ? `+${added} −${removed} · ${comparison}` : comparison;
  }

  if (layout === 'centered')
    return (
      <div
        ref={scroller}
        className="relative min-h-0 flex-1 overflow-auto px-6 pb-10 min-[1100px]:px-10"
      >
        <div className="mx-auto max-w-(--content-max) @container">
          <div className="mt-6">
            <SummaryStrip
              cells={[
                {
                  label: 'Changed files',
                  value: changes.data.total.toLocaleString(),
                  context: status.branch
                    ? `On ${status.branch}`
                    : status.headOid
                      ? `Detached at ${status.headOid.slice(0, 7)}`
                      : 'No commits yet',
                },
                {
                  label: 'Staged',
                  value: String(status.staged),
                  context: lineCounts('staged', 'HEAD → Index'),
                },
                {
                  label: 'Not staged',
                  value: String(status.unstaged),
                  context: lineCounts('modified', 'Index → Working tree'),
                },
                {
                  label: 'Untracked',
                  value: String(status.untracked),
                  context: 'New, not in Git yet',
                },
                {
                  label: 'Conflicts',
                  value: String(status.conflicts),
                  context: status.conflicts
                    ? 'Resolve before you commit'
                    : 'Nothing to resolve',
                },
              ]}
            />
          </div>
          <div className="mt-6 flex flex-wrap items-center gap-3">
            <div className="flex w-64">{filterField}</div>
            <span className="ml-auto text-xs text-muted">
              {repo.inspecting ? 'Checking…' : 'Changes show up as you save'}
            </span>
            {stageAllButton}
            {stageAllWhy}
          </div>
          {writeBand && (
            <div className="sticky top-0 z-10 mt-3">{writeBand}</div>
          )}
          {list}
          <section aria-labelledby="commit-heading" className="mt-10">
            <div className="mb-2 flex flex-wrap items-baseline justify-between gap-x-3">
              <h2
                id="commit-heading"
                className="text-[0.9375rem] font-semibold text-ink"
              >
                Commit
              </h2>
              <span className="text-xs text-muted">
                {status.staged
                  ? `${plural(status.staged, 'staged file')} go into it`
                  : 'Nothing staged yet'}
              </span>
            </div>
            <div className="border-t border-line">
              <CommitForm
                repo={repo}
                staged={status.staged}
                conflicts={status.conflicts}
              />
            </div>
          </section>
        </div>
      </div>
    );

  if (layout === 'narrow' && showDiff && selected)
    return (
      <div className="flex min-h-0 flex-1 flex-col px-4 pt-3">
        <div>
          <Button variant="ghost" size="sm" onClick={() => setShowDiff(false)}>
            <ArrowLeft /> All changed files
          </Button>
        </div>
        {selectedBands(selected, true)}
        {selected.kind === 'conflict' ? (
          conflictView(selected.path)
        ) : (
          <DiffView
            repoId={repo.id}
            path={selected.path}
            side={SIDE[selected.kind]}
            statusAt={repo.statusAt}
            width={600}
            actions={diffActions(selected)}
            onStep={step}
          />
        )}
      </div>
    );

  const pane = (
    <div
      className={cn(
        'flex min-h-0 flex-col',
        layout === 'split' && 'border-r border-line',
      )}
    >
      <div className="flex flex-none flex-wrap gap-2 p-3">
        {filterField}
        {stageAllButton}
        {stageAllWhy}
      </div>
      {writeBand && <div className="flex-none">{writeBand}</div>}
      <div ref={scroller} className="relative min-h-0 flex-1 overflow-auto">
        {list}
      </div>
      <div className="flex-none border-t border-line">
        <CommitForm
          repo={repo}
          staged={status.staged}
          conflicts={status.conflicts}
          compact
        />
      </div>
    </div>
  );
  if (layout === 'narrow') return pane;

  return (
    <div className="grid min-h-0 flex-1 grid-cols-[minmax(18rem,22rem)_minmax(0,1fr)]">
      {pane}
      <WidthPane>
        {(width) =>
          selected?.kind === 'conflict' ? (
            conflictView(selected.path)
          ) : selected ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {selectedBands(selected, false)}
              <DiffView
                repoId={repo.id}
                path={selected.path}
                side={SIDE[selected.kind]}
                statusAt={repo.statusAt}
                width={width}
                actions={diffActions(selected)}
                onStep={step}
              />
            </div>
          ) : (
            <EmptyState
              art={<DiffArt />}
              title="Pick a file to see its diff"
              action={
                <Button
                  onClick={() =>
                    ordered[0] && setSelectedKey(keyOf(ordered[0]))
                  }
                >
                  Show first change
                </Button>
              }
            >
              Arrow keys move through the list, x checks a file, and Space
              stages the selected one.
            </EmptyState>
          )
        }
      </WidthPane>
    </div>
  );
}

// The diff pane measures itself, so Auto can choose side by side when there is room.
function WidthPane({ children }: { children: (width: number) => ReactNode }) {
  const [ref, width] = useWidthOf();
  return (
    <div ref={ref} className="flex min-h-0 min-w-0 flex-col">
      {children(width)}
    </div>
  );
}
