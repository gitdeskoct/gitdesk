import {
  ArrowLeft,
  ArrowLeftRight,
  ChevronLeft,
  GitMerge,
  RefreshCw,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import type {
  AutoMergeability,
  BranchComparison,
  BranchMergeMethod,
  BranchMergeResult,
  BranchOverview,
  BranchRef,
  MergeabilityCheck,
} from '../../../shared/branches';
import type { PullFile } from '../../../shared/pulls';
import type { RepositorySummary } from '../../../shared/repos';
import type { Settings } from '../../../shared/settings';
import { DiffArt, OfflineArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { EmptyState } from '../../components/ui/empty-state';
import { Segmented } from '../../components/ui/segmented';
import { InlineStatus, Loading } from '../../components/ui/status';
import { useToast } from '../../components/ui/toast';
import { useNavigation } from '../../app/navigation';
import {
  useBranchFileDiff,
  useCompareBranches,
  useDeleteBranch,
  useMergeability,
  useMergeBranches,
} from '../../lib/branch-queries';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { ChoiceList } from '../pulls/choice-list';
import { plural, shortOid } from '../pulls/pull-bits';
import { PullStrip } from '../pulls/pull-preview';
import { AuthorAvatar } from '../repository/author-avatar';
import { DiffBody } from '../repository/diff-view';
import { OpenInEditorButton } from '../repository/editor-button';
import { usePushAction } from '../repository/use-push';
import { RefSelect } from './ref-select';

const STATUS_LETTER: Record<PullFile['status'], [string, string]> = {
  added: ['A', 'Added'],
  modified: ['M', 'Modified'],
  deleted: ['D', 'Deleted'],
  renamed: ['R', 'Renamed'],
  copied: ['C', 'Copied'],
  type: ['T', 'Type changed'],
};

const PROBLEMS: Record<
  Extract<BranchComparison, { status: 'problem' }>['problem'],
  (base: string, source: string) => [title: string, text: string]
> = {
  'same-branch': () => [
    'Pick two different branches',
    'A branch compared with itself has nothing to show.',
  ],
  'same-commit': (base, source) => [
    'Nothing to compare',
    `${base} and ${source} point at the same commit, so there is nothing to review or merge.`,
  ],
  'nothing-to-merge': (base, source) => [
    `${source} has nothing ${base} lacks`,
    `Every commit on ${source} is already in ${base}. Swap them to see what ${base} adds.`,
  ],
  unrelated: (base, source) => [
    'These branches share no history',
    `${base} and ${source} have no commit in common, so Git can't compare or merge them.`,
  ],
  'source-missing': (_base, source) => [
    `${source} isn't here any more`,
    'It was deleted or renamed. Choose another branch.',
  ],
  'target-missing': (base) => [
    `${base} isn't here any more`,
    'It was deleted or renamed. Choose another branch.',
  ],
};

export function effectiveAuto(
  settings: Settings | undefined,
  prefs: { autoMergeability: AutoMergeability | 'global' } | undefined,
): AutoMergeability {
  return prefs && prefs.autoMergeability !== 'global'
    ? prefs.autoMergeability
    : (settings?.branchAutoMergeability ?? 'list');
}

function MergeabilityBand({
  check,
  pending,
  auto,
  base,
  source,
  onCheck,
  onSettings,
  movedNote,
}: {
  check: MergeabilityCheck | undefined;
  pending: boolean;
  auto: boolean;
  base: { name: string; oid: string };
  source: { name: string; oid: string };
  onCheck: () => void;
  onSettings: () => void;
  movedNote: string | null;
}) {
  const checkNow = (
    <Button
      size="sm"
      className="bg-surface"
      pending={pending}
      onClick={onCheck}
    >
      Check now
    </Button>
  );
  const pair = (
    <>
      <span className="font-mono">{shortOid(source.oid)}</span> into{' '}
      <span className="font-mono">{shortOid(base.oid)}</span>
    </>
  );
  if (pending && !check)
    return (
      <div
        role="status"
        aria-busy
        className="flex flex-wrap items-center gap-3 bg-sunken px-3 py-2.5 text-[0.8125rem] text-ink"
      >
        <span className="min-w-0 flex-1">
          <b className="font-semibold">Checking.</b> Git is merging {pair} in
          memory. Your files aren't touched.
        </span>
        {checkNow}
      </div>
    );
  if (!check)
    return (
      <div className="flex flex-wrap items-center gap-3 bg-sunken px-3 py-2.5 text-[0.8125rem] text-ink">
        <InlineStatus className="min-w-0 flex-1">
          <b className="font-semibold">Not checked.</b>{' '}
          {auto
            ? `Ask Git whether ${source.name} merges cleanly into ${base.name}.`
            : 'Automatic checks are off for this repository. Merge still checks first.'}
        </InlineStatus>
        {checkNow}
        {!auto && (
          <Button size="sm" className="bg-surface" onClick={onSettings}>
            Open settings
          </Button>
        )}
      </div>
    );
  const at = `${auto ? 'Checked automatically' : 'Checked'} ${relativeTime(check.checkedAt)}`;
  if (check.mergeability === 'mergeable')
    return (
      <div className="flex flex-wrap items-center gap-3 bg-sunken px-3 py-2.5 text-[0.8125rem] text-ink">
        <InlineStatus tone="success" className="min-w-0 flex-1">
          <b className="font-semibold">Mergeable.</b> Git found no conflicts
          merging {pair}. {at}, without touching your files.
          {movedNote
            ? ` ${movedNote}`
            : auto
              ? ' It checks again whenever either branch moves.'
              : ''}
        </InlineStatus>
        {checkNow}
      </div>
    );
  if (check.mergeability === 'conflicts')
    return (
      <div
        role="status"
        className="grid gap-2 bg-warning-soft px-3 py-3 text-[0.8125rem] text-ink"
      >
        <InlineStatus tone="warning" action={checkNow}>
          <b className="font-semibold">
            {check.conflicts.length
              ? plural(check.conflicts.length, 'file') + ' conflict'
              : 'Conflicts'}
            .
          </b>{' '}
          Merging {pair} would stop on{' '}
          {check.conflicts.length
            ? 'these files'
            : 'a conflict Git describes in its own words'}
          . You can still merge and resolve them on Changes. {at}.
        </InlineStatus>
        {check.conflicts.length > 0 && (
          <ul className="ml-6 font-mono text-[0.78125rem]">
            {check.conflicts.slice(0, 20).map((path) => (
              <li key={path}>{path}</li>
            ))}
            {check.conflicts.length > 20 && (
              <li className="font-sans text-muted">
                and {plural(check.conflicts.length - 20, 'more file')}
              </li>
            )}
          </ul>
        )}
      </div>
    );
  return (
    <div className="flex flex-wrap items-center gap-3 bg-sunken px-3 py-2.5 text-[0.8125rem] text-ink">
      <InlineStatus className="min-w-0 flex-1">
        <b className="font-semibold">Unavailable.</b>{' '}
        {check.reason === 'git-too-old'
          ? 'This check needs Git 2.38 or newer. Merging still works.'
          : check.reason === 'unrelated'
            ? 'These branches share no history.'
            : "Git couldn't finish the check. Try again."}
      </InlineStatus>
      {checkNow}
    </div>
  );
}

const METHOD_TEXT = (
  base: string,
  source: string,
  ffPossible: boolean,
): { value: BranchMergeMethod; title: string; description: string }[] => [
  {
    value: 'default',
    title: "Git's default",
    description: ffPossible
      ? `Moves ${base} forward to ${source}; no merge commit is needed.`
      : `Makes a merge commit, because ${base} has commits ${source} lacks.`,
  },
  {
    value: 'no-ff',
    title: 'Always a merge commit',
    description: `Records the merge as its own commit even when ${base} could just move forward.`,
  },
  {
    value: 'ff-only',
    title: 'Fast-forward only',
    description: ffPossible
      ? `Moves ${base} to ${source}, and refuses if it ever can't.`
      : `Git refuses unless ${base} can simply move forward. Not possible here.`,
  },
];

function MergePanel({
  repo,
  result,
  check,
  settings,
  method: initialMethod,
  isProtected,
  onResult,
  onCancel,
}: {
  repo: RepositorySummary;
  result: Extract<BranchComparison, { status: 'ok' }>;
  check: MergeabilityCheck | undefined;
  settings: Settings | undefined;
  method: BranchMergeMethod;
  isProtected: boolean;
  onResult: (result: BranchMergeResult) => void;
  onCancel: () => void;
}) {
  const merge = useMergeBranches(repo.id);
  const [method, setMethod] = useState<BranchMergeMethod>(initialMethod);
  const [push, setPush] = useState(settings?.branchPushAfterMerge ?? false);
  const [confirmProtected, setConfirmProtected] = useState(false);
  const base = result.base.name;
  const source = result.source.name;
  const status = repo.status;
  const dirty = status ? status.staged + status.unstaged + status.conflicts : 0;
  const ffPossible = result.behind === 0;
  const blockedFf = method === 'ff-only' && !ffPossible;
  const run = () => {
    if (merge.isPending || blockedFf || (isProtected && !confirmProtected))
      return;
    // The merge moves the branches, so this panel can unmount before the refetch ends; the
    // promise still reports the result, where a per-call onSuccess would be dropped.
    merge
      .mutateAsync({
        target: base,
        source: { kind: result.source.kind, name: source },
        targetOid: result.base.oid,
        sourceOid: result.source.oid,
        method,
        push,
        confirmProtected,
        jobId: crypto.randomUUID(),
      })
      .then(onResult, () => undefined);
  };
  return (
    <section aria-labelledby="merge-heading" className="mt-6">
      <h3
        id="merge-heading"
        className="text-[0.9375rem] font-semibold text-ink"
      >
        Merge {source} into {base}
      </h3>
      <ul className="mt-2 grid gap-1.5 text-[0.8125rem]">
        <li>
          <InlineStatus tone={dirty ? 'warning' : 'success'}>
            {dirty
              ? `${plural(dirty, 'file')} with uncommitted changes. Git refuses to merge until they're committed.`
              : 'No uncommitted changes'}
          </InlineStatus>
        </li>
        <li>
          <InlineStatus
            tone={
              check?.mergeability === 'mergeable'
                ? 'success'
                : check?.mergeability === 'conflicts'
                  ? 'warning'
                  : 'info'
            }
          >
            {check?.mergeability === 'mergeable'
              ? `Mergeable at ${shortOid(result.base.oid)} ← ${shortOid(result.source.oid)}`
              : check?.mergeability === 'conflicts'
                ? `Expect conflicts in ${plural(check.conflicts.length || 1, 'file')}`
                : 'Not checked yet. Git decides when the merge runs.'}
          </InlineStatus>
        </li>
        {status?.branch !== base && (
          <li>
            <InlineStatus>
              gitdesk switches to {base} first. You are on{' '}
              {status?.branch ?? 'a detached HEAD'}.
            </InlineStatus>
          </li>
        )}
      </ul>
      <p className="mt-4 mb-1.5 text-xs font-medium text-muted">Method</p>
      <ChoiceList
        label="Merge method"
        value={method}
        onChange={setMethod}
        options={METHOD_TEXT(base, source, ffPossible)}
      />
      <div className="mt-3 flex flex-wrap items-center gap-x-5 gap-y-2 text-[0.8125rem] text-ink">
        <label className="inline-flex items-center gap-2">
          <Checkbox
            checked={push}
            onCheckedChange={(next) => setPush(next === true)}
          />
          Push {base} after merging
        </label>
        {isProtected && (
          <label className="inline-flex items-center gap-2">
            <Checkbox
              checked={confirmProtected}
              onCheckedChange={(next) => setConfirmProtected(next === true)}
            />
            Merge into protected {base}
          </label>
        )}
      </div>
      <div className="mt-3 flex flex-wrap items-center gap-3 bg-sunken px-3 py-2.5 text-[0.8125rem] text-ink">
        <span className="min-w-0 flex-[1_1_20rem]">
          <b className="font-semibold">
            Merge {source} ({shortOid(result.source.oid)}) into {base} (
            {shortOid(result.base.oid)})?
          </b>{' '}
          {blockedFf
            ? `${base} can't simply move forward. Choose another method.`
            : push
              ? `This happens on this computer, then ${base} is pushed.`
              : 'This happens on this computer. Nothing is pushed until you push.'}
        </span>
        <Button
          variant="primary"
          pending={merge.isPending}
          aria-disabled={
            blockedFf || (isProtected && !confirmProtected) || undefined
          }
          onClick={run}
        >
          <GitMerge />
          Merge
        </Button>
        <Button className="bg-surface" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {merge.error && (
        <InlineStatus tone="danger" className="mt-3">
          {ipcErrorMessage(merge.error, "Git didn't merge. Nothing changed.")}
        </InlineStatus>
      )}
    </section>
  );
}

function MergeOutcome({
  repo,
  outcome,
  source,
  canDeleteSource,
  onClose,
}: {
  repo: RepositorySummary;
  outcome: BranchMergeResult;
  source: BranchRef;
  canDeleteSource: boolean;
  onClose: () => void;
}) {
  const { navigate } = useNavigation();
  const pushAction = usePushAction(repo.id);
  const remove = useDeleteBranch(repo.id);
  const toast = useToast();
  const ahead = repo.status?.upstream ? (repo.status.ahead ?? 0) : null;
  const dismiss = (
    <Button size="sm" variant="ghost" onClick={onClose}>
      Dismiss
    </Button>
  );
  if (outcome.status === 'merged')
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-3 bg-sunken px-3 py-2.5 text-[0.8125rem] text-ink"
      >
        <InlineStatus tone="success" className="min-w-0 flex-[1_1_20rem]">
          <b className="font-semibold">
            {outcome.fastForward
              ? `${repo.status?.branch ?? 'The branch'} moved to ${shortOid(outcome.operation.resultOid ?? '')}`
              : `Merged in ${shortOid(outcome.operation.resultOid ?? '')}`}
            .
          </b>{' '}
          {outcome.fastForward
            ? 'Git fast-forwarded; no merge commit was needed.'
            : 'Git made a merge commit.'}{' '}
          {outcome.push === 'pushed'
            ? 'Pushed.'
            : outcome.push === 'failed'
              ? `Merged locally · Push pending: ${outcome.pushMessage ?? ''}`
              : ahead
                ? `${plural(ahead, 'commit')} to push.`
                : ''}
        </InlineStatus>
        {outcome.push !== 'pushed' && repo.status?.hasRemotes && (
          <Button
            size="sm"
            className="bg-surface"
            pending={!!pushAction.running}
            onClick={pushAction.start}
          >
            {outcome.push === 'failed' ? 'Push again' : 'Push'}
          </Button>
        )}
        {canDeleteSource && source.kind === 'local' && (
          <Button
            size="sm"
            className="bg-surface"
            pending={remove.isPending}
            onClick={() =>
              remove.mutate(
                { name: source.name, force: false },
                {
                  onSuccess: (result) =>
                    toast(
                      result.status === 'done'
                        ? { tone: 'success', title: `Deleted ${source.name}` }
                        : {
                            tone: 'danger',
                            title: `Kept ${source.name}`,
                            description:
                              result.status === 'blocked'
                                ? result.message
                                : 'Git says it has commits that are not merged.',
                          },
                    ),
                },
              )
            }
          >
            Delete {source.name}
          </Button>
        )}
        {dismiss}
      </div>
    );
  if (outcome.status === 'conflicts')
    return (
      <div
        role="status"
        className="flex flex-wrap items-center gap-3 bg-warning-soft px-3 py-2.5 text-[0.8125rem] text-ink"
      >
        <InlineStatus tone="warning" className="min-w-0 flex-[1_1_20rem]">
          <b className="font-semibold">
            {plural(outcome.files.length, 'file')} need you.
          </b>{' '}
          Git is partway through the merge. Resolve each file, then Continue.
        </InlineStatus>
        <Button
          size="sm"
          variant="primary"
          onClick={() =>
            navigate({ name: 'repository', id: repo.id, tab: 'changes' })
          }
        >
          Resolve on Changes
        </Button>
      </div>
    );
  if (outcome.status === 'blocked')
    return (
      <div
        role="status"
        className="grid gap-2 bg-warning-soft px-3 py-3 text-[0.8125rem] text-ink"
      >
        <InlineStatus tone="warning" action={dismiss}>
          <b className="font-semibold">Nothing was merged.</b> {outcome.message}
        </InlineStatus>
        {outcome.files.length > 0 && (
          <>
            <ul className="ml-6 font-mono text-[0.78125rem]">
              {outcome.files.map((file) => (
                <li key={file}>{file}</li>
              ))}
            </ul>
            <div className="ml-6">
              <Button
                size="sm"
                className="bg-surface"
                onClick={() =>
                  navigate({ name: 'repository', id: repo.id, tab: 'changes' })
                }
              >
                Go to Changes
              </Button>
            </div>
          </>
        )}
      </div>
    );
  return (
    <InlineStatus tone="danger" action={dismiss}>
      {outcome.message}
    </InlineStatus>
  );
}

export function CompareWorkspace({
  repo,
  width,
  list,
  base,
  source,
  settings,
  auto,
  method,
  protectedNames,
  startMerge,
  onPick,
  onBack,
}: {
  repo: RepositorySummary;
  width: number;
  list: BranchOverview;
  base: BranchRef | null;
  source: BranchRef | null;
  settings: Settings | undefined;
  auto: AutoMergeability;
  method: BranchMergeMethod;
  protectedNames: string[];
  startMerge: boolean;
  onPick: (base: BranchRef | null, source: BranchRef | null) => void;
  onBack: () => void;
}) {
  const { navigate } = useNavigation();
  const tipOf = (ref: BranchRef | null) =>
    ref
      ? ((ref.kind === 'local' ? list.local : list.remote).find(
          (b) => b.name === ref.name,
        )?.oid ?? null)
      : null;
  const compare = useCompareBranches(repo.id, base, source, [
    tipOf(base),
    tipOf(source),
  ]);
  const [picked, setPicked] = useState<string | null>(null);
  const [showDiff, setShowDiff] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [layoutChoice, setLayoutChoice] = useState<'unified' | 'split' | null>(
    null,
  );
  const [manual, setManual] = useState(false);
  const [merging, setMerging] = useState(startMerge);
  const [outcome, setOutcome] = useState<BranchMergeResult | null>(null);
  const [movedNote, setMovedNote] = useState<string | null>(null);
  const previous = useRef<{ base: string; source: string } | null>(null);
  const result = compare.data?.status === 'ok' ? compare.data : null;

  // A branch that moves while the comparison is open gets a new snapshot, and says so.
  useEffect(() => {
    if (!result) return;
    const was = previous.current;
    if (
      was &&
      (was.base !== result.base.oid || was.source !== result.source.oid)
    ) {
      const moved = was.base !== result.base.oid ? result.base : result.source;
      setMovedNote(
        `${moved.name} moved to ${shortOid(moved.oid)}, so gitdesk took a new snapshot.`,
      );
    }
    previous.current = { base: result.base.oid, source: result.source.oid };
  }, [result?.base.oid, result?.source.oid]);

  const check = useMergeability(
    repo.id,
    result?.base.oid ?? null,
    result?.source.oid ?? null,
    auto !== 'off' || manual,
  );
  const files = result?.comparison.files ?? [];
  const file = files.find((f) => f.path === picked) ?? files[0] ?? null;
  // Past the size guard on an explicit Load full diff, for this file only.
  const [full, setFull] = useState(false);
  useEffect(() => setFull(false), [file?.path]);
  const nextFile = file ? files[files.indexOf(file) + 1] : undefined;
  const diff = useBranchFileDiff(
    result && file
      ? {
          id: repo.id,
          baseOid: result.base.oid,
          sourceOid: result.source.oid,
          path: file.path,
          oldPath: file.oldPath,
          context: expanded ? 1_000_000 : (settings?.diffContext ?? 3),
          ignoreWhitespace: settings?.diffIgnoreWhitespace ?? false,
          full,
        }
      : null,
  );
  const narrow = width > 0 && width < 700;
  const split = width >= 960;
  const diffSplit =
    layoutChoice === 'split' ||
    (layoutChoice === null &&
      (settings?.diffLayout === 'split' ||
        (settings?.diffLayout !== 'unified' && width >= 1300)));
  const isLocalBase = base?.kind === 'local';
  const sourceProtected =
    source?.kind === 'local' && protectedNames.includes(source.name);

  const pickers = (
    <div className="flex flex-wrap items-end gap-x-3 gap-y-2">
      <Button variant="ghost" size="sm" onClick={onBack}>
        <ArrowLeft />
        All branches
      </Button>
      <RefSelect
        id="compare-base"
        label="Base · gets the changes"
        value={base}
        list={list}
        onChange={(next) => {
          setOutcome(null);
          setMovedNote(null);
          previous.current = null;
          onPick(next, source);
        }}
      />
      <Button
        size="icon"
        aria-label="Swap base and source"
        title="Swap base and source"
        onClick={() => {
          setOutcome(null);
          setMovedNote(null);
          previous.current = null;
          onPick(source, base);
        }}
      >
        <ArrowLeftRight />
      </Button>
      <RefSelect
        id="compare-source"
        label="Source · brings the commits"
        value={source}
        list={list}
        onChange={(next) => {
          setOutcome(null);
          setMovedNote(null);
          previous.current = null;
          onPick(base, next);
        }}
      />
      <span className="ml-auto text-xs text-muted">
        {result ? `Snapshot taken ${relativeTime(result.capturedAt)}` : null}
      </span>
      <Button
        size="sm"
        pending={compare.isFetching}
        onClick={() => void compare.refetch()}
      >
        {!compare.isFetching && <RefreshCw />}
        Refresh
      </Button>
    </div>
  );

  let body;
  if (!base || !source)
    body = (
      <EmptyState
        art={<DiffArt />}
        title="Choose two branches"
        action={<Button onClick={onBack}>All branches</Button>}
      >
        Pick a base that gets the changes and a source that brings them.
      </EmptyState>
    );
  else if (compare.isPending)
    body = <Loading label="Reading the commits on both branches…" />;
  else if (compare.isError)
    body = (
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
    );
  else if (compare.data.status === 'problem') {
    const [title, text] = PROBLEMS[compare.data.problem](
      compare.data.base,
      compare.data.source,
    );
    body = (
      <EmptyState
        art={<DiffArt />}
        title={title}
        action={
          compare.data.problem === 'nothing-to-merge' ? (
            <Button onClick={() => onPick(source, base)}>Swap them</Button>
          ) : (
            <Button onClick={onBack}>Choose another branch</Button>
          )
        }
      >
        {text}
      </EmptyState>
    );
  } else {
    const r = compare.data;
    const commits = [...r.comparison.commits].reverse();
    const diffPane = !file ? (
      <EmptyState
        compact
        art={<DiffArt />}
        title="No file changes"
        action={
          <Button size="sm" onClick={() => onPick(source, base)}>
            Swap them
          </Button>
        }
      >
        These commits change no files compared with the shared history.
      </EmptyState>
    ) : (
      <div className="min-w-0">
        {narrow && (
          <button
            type="button"
            onClick={() => setShowDiff(false)}
            className="mb-2 flex h-9 w-full items-center gap-2 border-b border-line text-left text-[0.8125rem] font-medium text-accent focus-visible:outline-offset-[-2px]"
          >
            <ChevronLeft aria-hidden className="size-4" />
            All changed files
          </button>
        )}
        <div
          role="toolbar"
          aria-label="Diff"
          className="mb-2 flex flex-wrap items-center gap-x-3 gap-y-1.5"
        >
          <span
            className="min-w-0 truncate font-mono text-[0.8125rem] font-medium text-ink"
            title={file.path}
          >
            {file.path}
          </span>
          <span className="text-xs text-muted">
            {r.base.name} {shortOid(r.base.oid)} → {r.source.name}{' '}
            {shortOid(r.source.oid)}
          </span>
          <span className="flex-1" />
          <Segmented
            label="Diff layout"
            value={diffSplit ? 'split' : 'unified'}
            onChange={setLayoutChoice}
            options={[
              { value: 'unified', label: 'Unified' },
              { value: 'split', label: 'Split' },
            ]}
          />
        </div>
        {diff.isPending ? (
          <Loading label="Reading the diff…" />
        ) : diff.isError ? (
          <EmptyState
            compact
            art={<OfflineArt />}
            title="Couldn't read this file's diff"
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
            {ipcErrorMessage(diff.error, 'Git did not answer.')}
          </EmptyState>
        ) : diff.data.status === 'text' && diff.data.hunks.length ? (
          <div className="flex min-h-0 flex-col overflow-hidden rounded-sm border border-line">
            <DiffBody
              diff={diff.data}
              path={file.path}
              settings={settings}
              split={diffSplit && !narrow}
              onExpand={expanded ? null : () => setExpanded(true)}
              maxHeight="max-h-[70vh]"
            />
          </div>
        ) : (
          <EmptyState
            compact
            art={<DiffArt />}
            title={
              diff.data.status === 'binary'
                ? `${file.path.split('/').pop()} is binary`
                : diff.data.status === 'too-large'
                  ? 'This diff is large'
                  : 'No text changes to show'
            }
            action={
              diff.data.status === 'too-large' ? (
                <Button
                  size="sm"
                  pending={diff.isFetching}
                  onClick={() => setFull(true)}
                >
                  Load full diff
                </Button>
              ) : nextFile ? (
                <Button size="sm" onClick={() => setPicked(nextFile.path)}>
                  Next file
                </Button>
              ) : (
                <OpenInEditorButton repoId={repo.id} path={null} />
              )
            }
          >
            {diff.data.status === 'binary'
              ? "Git can't show it as lines, so there are no line counts."
              : diff.data.status === 'too-large'
                ? `It changes +${diff.data.added.toLocaleString()} −${diff.data.removed.toLocaleString()} lines. Showing them all may slow gitdesk down.`
                : 'Only the file mode changed, or the change is whitespace Git was asked to ignore.'}
          </EmptyState>
        )}
        <p className="mt-2 text-xs text-muted">
          Git's own diff from where the branches split to {r.source.name},
          highlighted with your Settings › Code theme.
        </p>
      </div>
    );
    const listPane = (
      <div className="min-w-0">
        <h3 className="text-[0.8125rem] font-semibold text-ink">
          Only on {r.source.name}
        </h3>
        <ul
          aria-label={`Commits only on ${r.source.name}`}
          className="mt-1.5 mb-5 border-t border-line"
        >
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
          {r.comparison.commitsTruncated && (
            <li className="pt-2 text-xs text-muted">
              Showing the newest commits only.
            </li>
          )}
        </ul>
        <h3 className="text-[0.8125rem] font-semibold text-ink">
          Changed files
        </h3>
        <ul aria-label="Changed files" className="mt-1.5 border-t border-line">
          {files.map((f) => {
            const [letter, word] = STATUS_LETTER[f.status];
            const current = f === file;
            return (
              <li key={f.path} className="border-b border-line">
                <button
                  type="button"
                  aria-current={current || undefined}
                  onClick={() => {
                    setPicked(f.path);
                    setExpanded(false);
                    setShowDiff(true);
                  }}
                  className={cn(
                    'grid w-full grid-cols-[1rem_minmax(0,1fr)_auto] items-center gap-2 px-2 py-2 text-left focus-visible:outline-offset-[-2px]',
                    current && !narrow
                      ? 'bg-accent-soft'
                      : 'hover:bg-row-hover',
                  )}
                >
                  <span
                    title={word}
                    className="text-center font-mono text-xs font-semibold text-ink"
                  >
                    {letter}
                    <span className="sr-only"> {word}</span>
                  </span>
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
            );
          })}
          {r.comparison.filesTruncated && (
            <li className="pt-2 text-xs text-muted">
              Showing the first 3,000 files.
            </li>
          )}
        </ul>
      </div>
    );
    body = (
      <>
        <p className="mt-3 max-w-[70ch] text-[0.8125rem] text-muted">
          {r.source.name} has {plural(r.comparison.commits.length, 'commit')}{' '}
          that {r.base.name} doesn't.{' '}
          {r.behind
            ? `${r.base.name} has ${plural(r.behind, 'commit')} since they split at ${shortOid(r.comparison.mergeBaseOid)}, so merging makes a merge commit unless you choose otherwise.`
            : `${r.base.name} has nothing new since they split, so a merge can simply move it forward.`}
        </p>
        <div className="mt-3 @container">
          <PullStrip comparison={r.comparison} />
        </div>
        <div className="mt-3 grid gap-3">
          <MergeabilityBand
            check={check.data}
            pending={check.isFetching}
            auto={auto !== 'off'}
            base={r.base}
            source={r.source}
            movedNote={movedNote}
            onCheck={() => {
              setManual(true);
              if (check.data) void check.refetch();
            }}
            onSettings={() =>
              navigate({ name: 'repository', id: repo.id, tab: 'settings' })
            }
          />
          {check.isError && (
            <InlineStatus tone="danger">
              {ipcErrorMessage(check.error, "Git couldn't run the check.")}
            </InlineStatus>
          )}
          {outcome && (
            <MergeOutcome
              repo={repo}
              outcome={outcome}
              source={source}
              canDeleteSource={
                (settings?.branchOfferDelete ?? true) &&
                !sourceProtected &&
                outcome.status === 'merged'
              }
              onClose={() => setOutcome(null)}
            />
          )}
          {!merging && !outcome && isLocalBase && (
            <div>
              <Button variant="primary" onClick={() => setMerging(true)}>
                <GitMerge />
                Merge into {r.base.name}…
              </Button>
            </div>
          )}
          {!isLocalBase && (
            <InlineStatus>
              {r.base.name} is a remote-tracking branch. Merge into a local
              branch; swap the two or pick a local base.
            </InlineStatus>
          )}
        </div>
        {merging && !outcome && isLocalBase && (
          <MergePanel
            repo={repo}
            result={r}
            check={check.data}
            settings={settings}
            method={method}
            isProtected={protectedNames.includes(r.base.name)}
            onResult={(next) => {
              setOutcome(next);
              setMerging(false);
            }}
            onCancel={() => setMerging(false)}
          />
        )}
        <div
          className={cn(
            'mt-6 border-t border-line pt-4',
            split && 'grid grid-cols-[minmax(17rem,20rem)_minmax(0,1fr)] gap-0',
          )}
        >
          {narrow ? (
            showDiff ? (
              diffPane
            ) : (
              listPane
            )
          ) : (
            <>
              <div className={cn(split && 'border-r border-line pr-4')}>
                {listPane}
              </div>
              <div className={cn('min-w-0', split ? 'pl-4' : 'mt-6')}>
                {diffPane}
              </div>
            </>
          )}
        </div>
      </>
    );
  }

  return (
    <div className="pt-4 pb-10">
      <h2 className="sr-only">Compare branches</h2>
      {pickers}
      {outcome && (!result || compare.data?.status !== 'ok') && (
        <div className="mt-3">
          <MergeOutcome
            repo={repo}
            outcome={outcome}
            source={source ?? { kind: 'local', name: '' }}
            canDeleteSource={
              (settings?.branchOfferDelete ?? true) &&
              !sourceProtected &&
              outcome.status === 'merged' &&
              !!source
            }
            onClose={() => setOutcome(null)}
          />
        </div>
      )}
      {body}
    </div>
  );
}
