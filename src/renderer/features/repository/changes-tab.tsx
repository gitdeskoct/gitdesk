import {
  ArrowLeft,
  Copy,
  FolderOpen,
  Minus,
  Plus,
  RefreshCw,
  Search,
  Trash2,
} from 'lucide-react';
import {
  Fragment,
  useEffect,
  useMemo,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import type { ChangedFile, RepositorySummary } from '../../../shared/repos';
import type { DiffSide } from '../../../shared/workspace';
import {
  DiffArt,
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
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/cn';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useWidth as useWidthOf } from '../../lib/use-width';
import {
  useCopyFilePath,
  useDiscard,
  useOpenInEditor,
  useRefreshRepositories,
  useRepositoryChanges,
  useRevealFile,
  useStage,
  useStageAll,
  useUnstage,
} from '../../lib/queries';
import { fileManagerLabel } from '../repos/repo-actions';
import { CommitForm } from './commit-form';
import { DiffView } from './diff-view';
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
}: {
  repoId: string;
  files: ChangedFile[];
  onDone: () => void;
}) {
  const discard = useDiscard(repoId);
  const tracked = files.filter((f) => f.kind === 'modified');
  const untracked = files.filter((f) => f.kind === 'untracked');
  const names =
    files.length === 1 ? files[0]!.path : plural(files.length, 'file');
  return (
    <div
      role="group"
      aria-label={`Discard changes to ${names}`}
      className="grid gap-2.5 bg-danger-soft px-3 py-2.5 text-[0.8125rem] text-ink"
    >
      <p className="leading-relaxed">
        Discard your changes to{' '}
        <b className="font-mono font-semibold">{names}</b>?{' '}
        {tracked.length > 0 &&
          `${tracked.length === files.length ? 'They go' : `${plural(tracked.length, 'edited file')} go`} back to the staged version. `}
        {untracked.length > 0 &&
          `${plural(untracked.length, 'new file')} ${untracked.length === 1 ? 'moves' : 'move'} to the trash. `}
        gitdesk can't undo this.
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
          onClick={() =>
            discard.mutate(
              files.map((f) => f.path),
              { onSuccess: onDone },
            )
          }
        >
          Discard
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone} autoFocus>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function StageButton({ repoId, file }: { repoId: string; file: ChangedFile }) {
  const stage = useStage(repoId);
  const unstage = useUnstage(repoId);
  const toast = useToast();
  const staged = file.kind === 'staged';
  const action = staged ? unstage : stage;
  const label = `${staged ? 'Unstage' : file.kind === 'conflict' ? 'Mark resolved' : 'Stage'} ${file.path}`;
  return (
    <Tooltip
      label={
        staged
          ? 'Unstage'
          : file.kind === 'conflict'
            ? 'Mark resolved'
            : 'Stage'
      }
      side="left"
    >
      <Button
        size="icon"
        variant="ghost"
        aria-label={label}
        pending={action.isPending}
        onClick={(event) => {
          event.stopPropagation();
          action.mutate([file.path], {
            onError: (err) =>
              toast({
                tone: 'danger',
                title: staged ? 'Not unstaged' : 'Not staged',
                description: ipcErrorMessage(err, 'Try again in a moment.'),
              }),
          });
        }}
      >
        {!action.isPending && (staged ? <Minus /> : <Plus />)}
      </Button>
    </Tooltip>
  );
}

function FileRow({
  repoId,
  file,
  selected,
  checked,
  onCheck,
  onSelect,
  onDiscard,
  focusable,
  expanded,
}: {
  repoId: string;
  file: ChangedFile;
  selected: boolean;
  checked: boolean;
  onCheck: (checked: boolean) => void;
  onSelect: () => void;
  onDiscard: () => void;
  focusable: boolean;
  expanded?: boolean;
}) {
  const [dir, name] = splitPath(file.path);
  const reveal = useRevealFile(repoId);
  const copy = useCopyFilePath(repoId);
  const open = useOpenInEditor(repoId);
  const stage = useStage(repoId);
  const unstage = useUnstage(repoId);
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
        <li
          role="option"
          aria-selected={selected}
          aria-expanded={expanded}
          tabIndex={focusable ? 0 : -1}
          data-key={keyOf(file)}
          onClick={onSelect}
          className={cn(
            'grid min-h-9 cursor-default grid-cols-[1rem_1.5rem_minmax(0,1fr)_2rem] items-center gap-2 border-b border-l-2 border-b-line py-1 pr-1.5 pl-2.5 outline-offset-[-2px] transition-colors',
            selected
              ? 'border-l-accent bg-accent-soft'
              : 'border-l-transparent hover:bg-row-hover',
          )}
        >
          <Checkbox
            checked={checked}
            onCheckedChange={(value) => onCheck(value === true)}
            onClick={(event) => event.stopPropagation()}
            aria-label={`Select ${file.path}`}
            tabIndex={-1}
          />
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
          <span
            className="min-w-0 truncate font-mono text-[0.78125rem] text-ink"
            title={file.path}
          >
            <span className="text-muted">{dir}</span>
            {name}
            {file.origPath && (
              <span className="text-muted"> from {file.origPath}</span>
            )}
            {file.submodule && (
              <span className="font-sans text-xs text-muted"> · submodule</span>
            )}
          </span>
          <StageButton repoId={repoId} file={file} />
        </li>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {file.kind === 'staged' ? (
          <ContextMenuItem
            onSelect={() =>
              unstage.mutate([file.path], { onError: failed('Not unstaged') })
            }
          >
            <Minus /> Unstage
          </ContextMenuItem>
        ) : (
          <ContextMenuItem
            onSelect={() =>
              stage.mutate([file.path], { onError: failed('Not staged') })
            }
          >
            <Plus /> {file.kind === 'conflict' ? 'Mark resolved' : 'Stage'}
          </ContextMenuItem>
        )}
        {canDiscard && (
          <ContextMenuItem
            onSelect={onDiscard}
            className="text-danger [&_svg]:text-danger"
          >
            <Trash2 /> Discard changes…
          </ContextMenuItem>
        )}
        <ContextMenuSeparator />
        <ContextMenuItem
          onSelect={() =>
            open.mutate(
              { path: file.code === 'D' ? null : file.path, line: null },
              { onError: failed("Couldn't open it") },
            )
          }
        >
          <FolderOpen /> Open in editor
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
  const toStage = files.filter((f) => f.kind !== 'staged');
  const toUnstage = files.filter((f) => f.kind === 'staged');
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
          onClick={() =>
            stage.mutate(
              toStage.map((f) => f.path),
              { onSuccess: onClear },
            )
          }
        >
          Stage {toStage.length}
        </Button>
      )}
      {toUnstage.length > 0 && (
        <Button
          size="sm"
          className="bg-surface"
          pending={unstage.isPending}
          onClick={() =>
            unstage.mutate(
              toUnstage.map((f) => f.path),
              { onSuccess: onClear },
            )
          }
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
  const changes = useRepositoryChanges(
    repo.id,
    repo.statusAt,
    repo.status !== null,
  );
  const [filter, setFilter] = useState('');
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [checked, setChecked] = useState<Set<string>>(new Set());
  const [discarding, setDiscarding] = useState<string[] | null>(null);
  const [showDiff, setShowDiff] = useState(false);

  const files = changes.data?.files ?? [];
  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    return q ? files.filter((f) => f.path.toLowerCase().includes(q)) : files;
  }, [files, filter]);
  const groups: Group[] = [
    {
      key: 'conflict',
      title: 'Conflicts',
      meta: 'Resolve in your editor, then mark resolved',
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

  const move = (event: KeyboardEvent<HTMLElement>) => {
    if (!ordered.length) return;
    const index = Math.max(
      0,
      ordered.findIndex((f) => keyOf(f) === selectedKey),
    );
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      event.preventDefault();
      const next =
        ordered[
          Math.min(
            ordered.length - 1,
            Math.max(0, index + (event.key === 'ArrowDown' ? 1 : -1)),
          )
        ]!;
      setSelectedKey(keyOf(next));
      requestAnimationFrame(() =>
        document
          .querySelector<HTMLElement>(`[data-key="${CSS.escape(keyOf(next))}"]`)
          ?.focus(),
      );
    } else if (event.key === ' ' && selected) {
      event.preventDefault();
      document
        .querySelector<HTMLElement>(
          `[data-key="${CSS.escape(keyOf(selected))}"] button`,
        )
        ?.click();
    } else if (event.key === 'Enter' && layout === 'narrow' && selected)
      setShowDiff(true);
  };

  const stageAllButton = (
    <Button
      size="sm"
      pending={stageAll.isPending}
      aria-disabled={(status?.conflicts ?? 0) > 0 || undefined}
      onClick={() =>
        (status?.conflicts ?? 0) === 0 &&
        stageAll.mutate(undefined, {
          onError: (err) =>
            toast({
              tone: 'danger',
              title: 'Not staged',
              description: ipcErrorMessage(err, 'Try again.'),
            }),
        })
      }
    >
      Stage all
    </Button>
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

  const toggleCheck = (file: ChangedFile, value: boolean) =>
    setChecked((current) => {
      const next = new Set(current);
      if (value) next.add(keyOf(file));
      else next.delete(keyOf(file));
      return next;
    });

  const list = (inlineDiffs: boolean) => (
    <>
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
          The filter checks file paths. {plural(files.length, 'file')} changed
          in total.
        </EmptyState>
      ) : (
        groups.map((group) => {
          const allChecked = group.files.every((f) => checked.has(keyOf(f)));
          const some = group.files.some((f) => checked.has(keyOf(f)));
          return (
            <section
              key={group.key}
              aria-labelledby={`group-${group.key}`}
              className={inlineDiffs ? 'mt-8' : undefined}
            >
              <div
                className={cn(
                  'flex items-center gap-2 pr-2.5 pl-3',
                  inlineDiffs ? 'mb-2 pl-0' : 'pt-3.5 pb-1.5',
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
                  <span className="ml-auto text-xs text-muted">
                    {group.meta}
                  </span>
                )}
              </div>
              <ul
                role="listbox"
                aria-label={group.title}
                onKeyDown={move}
                className="border-t border-line"
              >
                {group.files.map((file) => {
                  const key = keyOf(file);
                  const isSelected = key === selectedKey;
                  return (
                    <Fragment key={key}>
                      <FileRow
                        repoId={repo.id}
                        file={file}
                        selected={isSelected}
                        expanded={inlineDiffs ? isSelected : undefined}
                        checked={checked.has(key)}
                        onCheck={(value) => toggleCheck(file, value)}
                        onSelect={() => {
                          setSelectedKey(
                            inlineDiffs && isSelected ? null : key,
                          );
                          if (layout === 'narrow') setShowDiff(true);
                        }}
                        onDiscard={() => setDiscarding([key])}
                        focusable={
                          isSelected || (!selectedKey && file === ordered[0])
                        }
                      />
                      {discarding?.length === 1 && discarding[0] === key && (
                        <li role="none">
                          <DiscardBand
                            repoId={repo.id}
                            files={[file]}
                            onDone={() => setDiscarding(null)}
                          />
                        </li>
                      )}
                      {inlineDiffs && isSelected && (
                        <li role="none" className="border-b border-line py-3">
                          <DiffView
                            repoId={repo.id}
                            path={file.path}
                            side={SIDE[file.kind]}
                            statusAt={repo.statusAt}
                            width={900}
                            inline
                          />
                        </li>
                      )}
                    </Fragment>
                  );
                })}
              </ul>
            </section>
          );
        })
      )}
      {changes.data.truncated && (
        <p className="px-3 py-2 text-xs text-muted">
          Showing the first {files.length} changes. Stage all still includes the
          rest.
        </p>
      )}
    </>
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
    ) : null;

  if (layout === 'centered')
    return (
      <div className="min-h-0 flex-1 overflow-auto px-6 pb-10 min-[1100px]:px-10">
        <div className="mx-auto max-w-(--content-max) @container">
          <div className="mt-6">
            <SummaryStrip
              cells={[
                {
                  label: 'Staged',
                  value: String(status.staged),
                  context: 'In the next commit',
                },
                {
                  label: 'Not staged',
                  value: String(status.unstaged),
                  context: 'Edited since the last stage',
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
          </div>
          {list(true)}
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
        {discarding?.length === 1 && discarding[0] === keyOf(selected) && (
          <DiscardBand
            repoId={repo.id}
            files={[selected]}
            onDone={() => setDiscarding(null)}
          />
        )}
        <DiffView
          repoId={repo.id}
          path={selected.path}
          side={SIDE[selected.kind]}
          statusAt={repo.statusAt}
          width={600}
          actions={diffActions(selected)}
        />
      </div>
    );

  const pane = (
    <div
      className={cn(
        'flex min-h-0 flex-col',
        layout === 'split' && 'border-r border-line',
      )}
    >
      <div className="flex flex-none gap-2 p-3">
        {filterField}
        {stageAllButton}
      </div>
      <div className="min-h-0 flex-1 overflow-auto">{list(false)}</div>
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
          selected ? (
            <div className="flex min-h-0 flex-1 flex-col">
              {discarding?.length === 1 &&
                discarding[0] === keyOf(selected) && (
                  <DiscardBand
                    repoId={repo.id}
                    files={[selected]}
                    onDone={() => setDiscarding(null)}
                  />
                )}
              <DiffView
                repoId={repo.id}
                path={selected.path}
                side={SIDE[selected.kind]}
                statusAt={repo.statusAt}
                width={width}
                actions={diffActions(selected)}
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
              Arrow keys move through the list, and Space stages the selected
              file.
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
