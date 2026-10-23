import {
  Check,
  CircleAlert,
  CircleCheck,
  GitMerge,
  TriangleAlert,
  Undo2,
} from 'lucide-react';
import { useState } from 'react';
import type {
  ConflictFile,
  MergeResult,
  MergeStrategy,
  PullDetail,
  RevertResult,
} from '../../../shared/pulls';
import type { RepositorySummary } from '../../../shared/repos';
import { DiffArt, PullRequestsArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { EmptyState } from '../../components/ui/empty-state';
import { JobProgress } from '../../components/ui/job-progress';
import { InlineStatus, Loading } from '../../components/ui/status';
import { useToast } from '../../components/ui/toast';
import { cn } from '../../lib/cn';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAbortMerge,
  useCheckMergeability,
  useConflicts,
  useConflictSides,
  useContinueMerge,
  useDeletePullBranch,
  useMergePull,
  useResolveConflict,
  useRevertInfo,
  useRevertPull,
  useSetPullStatus,
} from '../../lib/pull-queries';
import { useJobProgress, useSettings } from '../../lib/queries';
import { useLineTokens } from '../repository/highlight';
import { OpenInEditorButton } from '../repository/editor-button';
import { usePushAction } from '../repository/use-push';
import { ChoiceList } from './choice-list';
import { MergeabilityBand } from './pull-preview';
import { plural, shortOid } from './pull-bits';

function Check_({
  ok,
  children,
}: {
  ok: boolean | 'warn';
  children: React.ReactNode;
}) {
  const Icon =
    ok === true ? CircleCheck : ok === 'warn' ? TriangleAlert : CircleAlert;
  return (
    <li className="flex items-start gap-2.5 border-b border-line py-2.5 text-[0.8125rem] text-ink">
      <Icon
        aria-hidden
        className={cn(
          'mt-0.5 size-4 shrink-0',
          ok === true
            ? 'text-success'
            : ok === 'warn'
              ? 'text-warning'
              : 'text-danger',
        )}
      />
      <span className="min-w-0">{children}</span>
    </li>
  );
}

function Outcome({ result }: { result: MergeResult | RevertResult }) {
  if (result.status === 'blocked')
    return (
      <InlineStatus tone="warning" className="mt-4">
        {result.message}
        {result.files.length > 0 && (
          <span className="mt-1 block font-mono text-[0.75rem]">
            {result.files.join(', ')}
          </span>
        )}
      </InlineStatus>
    );
  if (result.status === 'failed')
    return (
      <InlineStatus tone="danger" className="mt-4">
        <span className="whitespace-pre-wrap">{result.message}</span>
      </InlineStatus>
    );
  return null;
}

function MergePanel({
  repo,
  detail,
}: {
  repo: RepositorySummary;
  detail: PullDetail;
}) {
  const { pull } = detail;
  const { data: settings } = useSettings();
  const [strategy, setStrategy] = useState<MergeStrategy | null>(null);
  const [push, setPush] = useState<boolean | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [jobId, setJobId] = useState<string | null>(null);
  const merge = useMergePull(repo.id);
  const check = useCheckMergeability(repo.id, pull.id);
  const progress = useJobProgress(jobId);
  const latest = pull.latest;
  const status = repo.status;
  const method = strategy ?? settings?.pullMergeMethod ?? 'default';
  const canPush = !!status?.hasRemotes;
  const pushing = (push ?? settings?.pullPushAfterMerge ?? true) && canPush;
  const dirty = status ? status.staged + status.unstaged : 0;
  const warn = settings?.pullWarnBeforeMerge ?? true;
  const result = merge.data;

  if (detail.problem || !latest)
    return (
      <EmptyState
        art={<PullRequestsArt />}
        title="Nothing to merge right now"
        action={
          <Button pending={check.isPending} onClick={() => check.mutate()}>
            Check again
          </Button>
        }
      >
        {detail.problem === 'source-missing'
          ? `${pull.sourceRef} no longer exists here. Restore it to merge.`
          : detail.problem === 'target-missing'
            ? `${pull.targetRef} no longer exists here.`
            : 'Git could not compare the branches.'}
      </EmptyState>
    );

  const start = () => {
    const id = crypto.randomUUID();
    setJobId(id);
    merge.mutate(
      {
        id: pull.id,
        strategy: method,
        push: pushing,
        sourceOid: latest.sourceOid,
        targetOid: latest.targetOid,
        jobId: id,
      },
      { onSettled: () => setConfirming(false) },
    );
  };

  return (
    <div className="grid gap-x-9 gap-y-6 pt-5 @min-[880px]:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="min-w-0">
        <h2 className="text-[0.9375rem] font-semibold text-ink">
          Before merging
        </h2>
        <ul className="mt-2 border-t border-line">
          <Check_
            ok={
              latest.mergeability === 'mergeable'
                ? true
                : latest.mergeability === 'conflicts'
                  ? false
                  : 'warn'
            }
          >
            {latest.mergeability === 'mergeable'
              ? `Git found no conflicts merging ${shortOid(latest.sourceOid)} into ${shortOid(latest.targetOid)}.`
              : latest.mergeability === 'conflicts'
                ? 'Git found conflicts. You can merge and resolve them here, file by file.'
                : 'Not checked against these commits yet.'}
          </Check_>
          <Check_ ok={dirty === 0}>
            {dirty === 0
              ? 'No uncommitted changes in tracked files.'
              : `${plural(dirty, 'file')} with uncommitted changes. Commit or discard them on Changes first; gitdesk never stashes for you.`}
          </Check_>
          <Check_ ok={!status?.operation}>
            {status?.operation ? (
              `A ${status.operation} is in progress. Finish or abort it first.`
            ) : (
              <>
                <span className="font-mono text-[0.78125rem]">
                  {pull.targetRef}
                </span>
                {status?.branch === pull.targetRef
                  ? ' is checked out.'
                  : ' is a branch here. gitdesk switches to it for the merge.'}
              </>
            )}
          </Check_>
          {warn && pull.review?.stale && (
            <Check_ ok="warn">
              Your approval is for snapshot {pull.review.version}. You can still
              merge.
            </Check_>
          )}
          {warn &&
            pull.review?.decision === 'changes_requested' &&
            !pull.review.stale && (
              <Check_ ok="warn">
                Changes were requested on this snapshot. You can still merge.
              </Check_>
            )}
          {warn && pull.unresolved > 0 && (
            <Check_ ok="warn">
              {plural(pull.unresolved, 'thread')} unresolved. You can still
              merge.
            </Check_>
          )}
        </ul>
        <div className="mt-3">
          <MergeabilityBand
            pull={pull}
            pending={check.isPending}
            onCheck={() => check.mutate()}
          />
        </div>

        <h2 className="mt-6 text-[0.9375rem] font-semibold text-ink">
          How to merge
        </h2>
        <div className="mt-2">
          <ChoiceList
            label="How to merge"
            value={method}
            onChange={setStrategy}
            options={[
              {
                value: 'default',
                title: 'Default merge',
                description: `Git moves ${pull.targetRef} forward when it can, and makes a merge commit only when it has to.`,
              },
              {
                value: 'no-ff',
                title: 'Always make a merge commit',
                description:
                  'Keeps this pull request visible as one merge in History (--no-ff).',
              },
            ]}
          />
        </div>
        {canPush && (
          <label className="mt-3 flex items-center gap-2.5 text-[0.8125rem] text-ink">
            <Checkbox
              checked={pushing}
              onCheckedChange={(value) => setPush(value === true)}
            />
            Push{' '}
            <span className="font-mono text-[0.78125rem]">
              {pull.targetRef}
            </span>{' '}
            after merging
          </label>
        )}

        {confirming ? (
          <div
            role="alert"
            className="mt-4 flex flex-wrap items-center gap-3 bg-sunken px-3 py-2.5 text-[0.8125rem] text-ink"
          >
            <span className="min-w-0 flex-1">
              Merge{' '}
              <span className="font-mono text-[0.78125rem]">
                {pull.sourceRef}
              </span>{' '}
              into{' '}
              <span className="font-mono text-[0.78125rem]">
                {pull.targetRef}
              </span>{' '}
              on this computer
              {pushing ? ', then push it' : ''}?
            </span>
            <Button
              variant="primary"
              size="sm"
              pending={merge.isPending}
              onClick={() => !merge.isPending && start()}
            >
              Merge
            </Button>
            <Button
              size="sm"
              onClick={() => setConfirming(false)}
              aria-disabled={merge.isPending || undefined}
            >
              Cancel
            </Button>
          </div>
        ) : (
          <Button
            variant="primary"
            className="mt-4"
            onClick={() => setConfirming(true)}
          >
            <GitMerge />
            Merge pull request
          </Button>
        )}
        {merge.isPending && pushing && progress && (
          <div className="mt-3">
            <JobProgress
              label={`Pushing ${pull.targetRef}`}
              stage={progress.stage}
              right={`${progress.percent}%`}
              percent={progress.percent}
              progress={progress}
              network
            />
          </div>
        )}
        {merge.isError && (
          <InlineStatus tone="danger" className="mt-4">
            {ipcErrorMessage(merge.error, 'The merge did not run.')}
          </InlineStatus>
        )}
        {result && <Outcome result={result} />}
      </div>
      <aside aria-label="What happens" className="text-[0.8125rem] text-muted">
        <h3 className="font-semibold text-ink">What happens</h3>
        <ol className="mt-2 list-decimal space-y-1 pl-4.5">
          <li>Git checks the commits are the ones you reviewed.</li>
          <li>It merges on this computer.</li>
          <li>
            {pushing
              ? 'It pushes the target to its remote.'
              : 'Nothing is pushed.'}
          </li>
          <li>
            The pull request is marked merged only after Git's result is
            checked.
          </li>
        </ol>
        <p className="mt-3">
          If the push or your account can't be reached, the merge stays done
          here and the rest is retried.
        </p>
      </aside>
    </div>
  );
}

const KIND_WORDS: Record<ConflictFile['kind'], string> = {
  'both-modified': 'Both changed the same lines',
  'both-added': 'Both added this file',
  'both-deleted': 'Both deleted this file',
  'deleted-by-target': 'Deleted on the target, changed in the source',
  'deleted-by-source': 'Changed on the target, deleted in the source',
  'added-by-target': 'Added on the target only',
  'added-by-source': 'Added in the source only',
};

// One version of a conflicted file, with Shiki colors when Settings › Code allows them. Conflict
// markers stay plain and carry a label, so they never read as code.
function CodeBox({
  text,
  label,
  path,
  upstream,
}: {
  text: string | null;
  label: string;
  path: string;
  upstream: boolean;
}) {
  const { data: settings } = useSettings();
  const tokens = useLineTokens(
    text,
    path,
    settings?.codeTheme ?? 'github',
    settings?.diffSyntax ?? true,
  );
  if (text === null)
    return (
      <p className="rounded-sm border border-line bg-sunken px-3 py-2 text-[0.8125rem] text-muted">
        {label}
      </p>
    );
  const words = upstream
    ? ['Your side starts', 'Incoming side starts', 'Incoming side ends']
    : ['Target side starts', 'Source side starts', 'Source side ends'];
  return (
    <pre className="code-text max-h-72 overflow-auto rounded-sm border border-line bg-surface px-3 py-2 whitespace-pre">
      {text.split('\n').map((line, i) => {
        const marker = /^(<{7}|={7}|>{7})(\s|$)/.test(line);
        const lineTokens = marker ? null : tokens?.[i];
        return (
          <div key={i} className={cn(marker && 'bg-warning-soft')}>
            {lineTokens
              ? lineTokens.map((token, k) => (
                  <span key={k} className="code-token" style={token.style}>
                    {token.content}
                  </span>
                ))
              : line || ' '}
            {marker && (
              <span className="ml-3 font-sans text-[0.71875rem] font-semibold text-ink">
                {line.startsWith('<')
                  ? words[0]
                  : line.startsWith('=')
                    ? words[1]
                    : words[2]}
              </span>
            )}
          </div>
        );
      })}
    </pre>
  );
}

// A pull request merge or revert, or a pull of the upstream (`upstream` set), which reads in its
// own words: yours and incoming rather than target and source.
export function ConflictsView({
  repo,
  pullSource,
  pullTarget,
  upstream = false,
}: {
  repo: RepositorySummary;
  pullSource: string;
  pullTarget: string;
  upstream?: boolean;
}) {
  const conflicts = useConflicts(repo.id, repo.statusAt);
  const [picked, setPicked] = useState<string | null>(null);
  const [aborting, setAborting] = useState(false);
  const resolve = useResolveConflict(repo.id);
  const proceed = useContinueMerge(repo.id);
  const abort = useAbortMerge(repo.id);
  const toast = useToast();
  const files = conflicts.data?.files ?? [];
  const file = files.find((f) => f.path === picked) ?? files[0] ?? null;
  const sides = useConflictSides(repo.id, file?.path ?? null, repo.statusAt);
  const reverting = conflicts.data?.operation === 'revert';
  const what = upstream ? 'pull' : reverting ? 'revert' : 'merge';
  const sideNames = upstream
    ? { target: `Yours, ${pullTarget}`, source: `Incoming, ${pullSource}` }
    : { target: `Target, ${pullTarget}`, source: `Source, ${pullSource}` };

  if (conflicts.isPending) return <Loading label="Reading the conflicts…" />;
  // Without Git's answer nothing can be called resolved, so Continue isn't offered.
  if (conflicts.isError)
    return (
      <EmptyState
        compact
        className="mt-5 border-t border-line"
        art={<DiffArt />}
        title="Couldn't read the conflicts"
        action={
          <Button
            size="sm"
            pending={conflicts.isFetching}
            onClick={() => void conflicts.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(
          conflicts.error,
          "Git didn't answer, so gitdesk can't tell which files still conflict.",
        )}
      </EmptyState>
    );
  const done = !files.length;
  return (
    <section aria-labelledby="conflicts-title" className="pt-5">
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h2
            id="conflicts-title"
            className="text-[1.0625rem] font-semibold text-ink"
          >
            {upstream
              ? 'Resolve conflicts to finish the pull'
              : reverting
                ? 'Resolve revert conflicts'
                : 'Resolve merge conflicts'}
          </h2>
          <p className="text-xs text-muted">
            <span className="font-mono">{pullSource}</span> into{' '}
            <span className="font-mono">{pullTarget}</span> ·{' '}
            {done
              ? 'every file is resolved'
              : `${plural(files.length, 'file')} left`}
            {conflicts.data?.resolved.length
              ? ` · ${conflicts.data.resolved.length} resolved`
              : ''}
          </p>
        </div>
        <Button onClick={() => setAborting(true)}>Abort {what}</Button>
        <Button
          variant="primary"
          pending={proceed.isPending}
          aria-disabled={!done || undefined}
          aria-describedby="continue-why"
          onClick={() =>
            done &&
            !proceed.isPending &&
            proceed.mutate(undefined, {
              onSuccess: (result) => {
                if (result.status === 'merged')
                  toast({
                    tone: 'success',
                    title: upstream ? `Pulled ${pullSource}` : 'Merged',
                  });
                if (result.status === 'reverted')
                  toast({ tone: 'success', title: 'Reverted' });
              },
            })
          }
        >
          Continue {what}
        </Button>
      </div>
      <p id="continue-why" className="mt-1 text-xs text-muted">
        Continue unlocks when Git reports no unmerged files.
      </p>
      {aborting && (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-center gap-3 bg-danger-soft px-3 py-2.5 text-[0.8125rem] text-ink"
        >
          <span className="min-w-0 flex-1">
            <b className="font-semibold">Abort this {what}?</b> Git puts{' '}
            <span className="font-mono text-[0.78125rem]">{pullTarget}</span>{' '}
            back where it was and drops the resolutions made here. gitdesk
            started on a clean tree, so nothing of yours is lost.
          </span>
          <Button
            variant="danger"
            size="sm"
            pending={abort.isPending}
            onClick={() =>
              abort.mutate(undefined, { onSuccess: () => setAborting(false) })
            }
          >
            Abort {what}
          </Button>
          <Button size="sm" onClick={() => setAborting(false)}>
            Keep resolving
          </Button>
        </div>
      )}
      {[proceed.error, abort.error, resolve.error].map(
        (error, i) =>
          error && (
            <InlineStatus key={i} tone="danger" className="mt-3">
              {ipcErrorMessage(error, "That step didn't run.")}
            </InlineStatus>
          ),
      )}

      {done ? (
        <EmptyState
          compact
          className="mt-4 border-t border-line"
          art={<DiffArt />}
          title="Every conflict is resolved"
          action={
            <Button
              variant="primary"
              pending={proceed.isPending}
              onClick={() => proceed.mutate()}
            >
              Continue {what}
            </Button>
          }
        >
          Git has no unmerged files left. Continue to make the commit.
        </EmptyState>
      ) : (
        <div className="mt-4 grid gap-6 @min-[900px]:grid-cols-[18rem_minmax(0,1fr)]">
          <ul aria-label="Conflicted files" className="border-t border-line">
            {files.map((f) => (
              <li key={f.path} className="border-b border-line">
                <button
                  type="button"
                  aria-current={f === file || undefined}
                  onClick={() => setPicked(f.path)}
                  className={cn(
                    'block w-full px-3 py-2 text-left focus-visible:outline-offset-[-2px]',
                    f === file ? 'bg-accent-soft' : 'hover:bg-row-hover',
                  )}
                >
                  <span className="block truncate font-mono text-[0.78125rem] text-ink">
                    {f.path}
                  </span>
                  <span className="block text-xs text-muted">
                    {KIND_WORDS[f.kind]}
                    {f.binary ? ' · binary' : ''}
                  </span>
                </button>
              </li>
            ))}
            {conflicts.data?.resolved.map((p) => (
              <li
                key={p}
                className="flex items-center gap-2 border-b border-line px-3 py-2 text-xs text-muted"
              >
                <Check aria-hidden className="size-3.5 text-success" />
                <span className="truncate font-mono">{p}</span> resolved
              </li>
            ))}
          </ul>
          {file && (
            <div className="min-w-0">
              {sides.isPending ? (
                <Loading label="Reading both sides…" />
              ) : sides.isError ? (
                <InlineStatus tone="danger">
                  {ipcErrorMessage(
                    sides.error,
                    "Couldn't read this file's versions.",
                  )}
                </InlineStatus>
              ) : (
                <>
                  <div className="grid gap-4 @min-[700px]:grid-cols-2">
                    {(
                      [
                        [
                          'target',
                          sideNames.target,
                          sides.data.target,
                          upstream ? 'Use yours' : 'Use target version',
                        ],
                        [
                          'source',
                          sideNames.source,
                          sides.data.source,
                          upstream ? 'Use incoming' : 'Use source version',
                        ],
                      ] as const
                    ).map(([take, title, text, action]) => (
                      <div key={take} className="min-w-0">
                        <div className="mb-1.5 flex items-center gap-2">
                          <b className="min-w-0 truncate text-[0.8125rem] font-semibold text-ink">
                            {title}
                          </b>
                          <Button
                            size="sm"
                            className="ml-auto"
                            pending={
                              resolve.isPending &&
                              resolve.variables?.take === take
                            }
                            onClick={() =>
                              resolve.mutate({ path: file.path, take })
                            }
                          >
                            {text === null && !sides.data.binary
                              ? take === 'target'
                                ? 'Keep it deleted'
                                : 'Take the deletion'
                              : action}
                          </Button>
                        </div>
                        <CodeBox
                          path={file.path}
                          upstream={upstream}
                          text={sides.data.binary ? null : text}
                          label={
                            sides.data.binary
                              ? 'Binary file: no text view.'
                              : sides.data.tooLarge
                                ? 'Too large to show here.'
                                : 'Deleted on this side.'
                          }
                        />
                      </div>
                    ))}
                  </div>
                  {!sides.data.binary && (
                    <>
                      <div className="mt-4 mb-1.5 flex flex-wrap items-center gap-2">
                        <b className="text-[0.8125rem] font-semibold text-ink">
                          Merged result in your working tree
                        </b>
                        <span className="text-xs text-muted">
                          {sides.data.markers
                            ? `${plural(sides.data.markers, 'conflict marker')} left`
                            : 'No markers left'}
                        </span>
                        <span className="ml-auto">
                          <OpenInEditorButton
                            repoId={repo.id}
                            path={file.path}
                          />
                        </span>
                      </div>
                      <CodeBox
                        path={file.path}
                        upstream={upstream}
                        text={sides.data.merged}
                        label="The file is not in the working tree."
                      />
                      <div className="mt-3 flex flex-wrap items-center gap-2.5">
                        <Button
                          pending={
                            resolve.isPending &&
                            resolve.variables?.take === 'working'
                          }
                          aria-disabled={sides.data.markers > 0 || undefined}
                          aria-describedby="mark-why"
                          onClick={() =>
                            sides.data.markers === 0 &&
                            resolve.mutate({ path: file.path, take: 'working' })
                          }
                        >
                          Mark resolved
                        </Button>
                        <span id="mark-why" className="text-xs text-muted">
                          Edit the file until no markers are left; gitdesk then
                          stages it and asks Git again.
                        </span>
                      </div>
                    </>
                  )}
                </>
              )}
            </div>
          )}
        </div>
      )}
    </section>
  );
}

function RevertPanel({
  repo,
  detail,
}: {
  repo: RepositorySummary;
  detail: PullDetail;
}) {
  const { pull } = detail;
  const info = useRevertInfo(repo.id, pull.id, true);
  const revert = useRevertPull(repo.id, pull.id);
  const [mainline, setMainline] = useState<'1' | '2'>('1');
  const [where, setWhere] = useState<'branch' | 'target'>('branch');
  const [branch, setBranch] = useState(`revert-pr-${pull.number}`);
  const result = revert.data;
  if (info.isPending) return <Loading label="Reading the merge…" />;
  if (info.isError)
    return (
      <InlineStatus tone="warning" className="mt-5">
        {ipcErrorMessage(
          info.error,
          "gitdesk can't read this merge, so it can't revert it.",
        )}
      </InlineStatus>
    );
  const parents = info.data.parents;
  return (
    <section aria-labelledby="revert-title" className="mt-8 max-w-3xl">
      <h2 id="revert-title" className="text-[0.9375rem] font-semibold text-ink">
        Revert this pull request
      </h2>
      <p className="mt-1 text-[0.8125rem] text-muted">
        A revert adds a new commit that undoes it. The pull request stays merged
        and its history stays as it is.
      </p>
      {info.data.isMerge && (
        <div className="mt-4">
          <h3 className="mb-1 text-[0.8125rem] font-semibold text-ink">
            Which side of the merge commit to keep
          </h3>
          <ChoiceList
            label="Which side to keep"
            value={mainline}
            onChange={setMainline}
            options={parents.map((parent, i) => ({
              value: String(i + 1) as '1' | '2',
              title: (
                <>
                  Parent {i + 1},{' '}
                  <span className="font-mono text-[0.78125rem]">
                    {shortOid(parent.oid)}
                  </span>{' '}
                  · {parent.subject}
                </>
              ),
              description:
                i === 0
                  ? `Undoes what the pull request brought into ${pull.targetRef}. This is the usual choice.`
                  : `Undoes what ${pull.targetRef} had that the branch did not.`,
            }))}
          />
        </div>
      )}
      <div className="mt-4">
        <h3 className="mb-1 text-[0.8125rem] font-semibold text-ink">
          Where the revert goes
        </h3>
        <ChoiceList
          label="Where the revert goes"
          value={where}
          onChange={setWhere}
          options={[
            {
              value: 'branch',
              title: 'A new branch',
              description:
                'Review the revert in its own pull request before it reaches the target.',
            },
            {
              value: 'target',
              title: (
                <>
                  Straight onto{' '}
                  <span className="font-mono text-[0.78125rem]">
                    {pull.targetRef}
                  </span>
                </>
              ),
              description: 'Commits the revert on the target branch.',
            },
          ]}
        />
        {where === 'branch' && (
          <label className="mt-3 block max-w-sm">
            <span className="mb-1.5 block text-[0.8125rem] font-medium text-ink">
              Branch name
            </span>
            <input
              className="field h-9 w-full px-3 font-mono text-[0.78125rem] outline-none"
              value={branch}
              onChange={(event) => setBranch(event.target.value)}
            />
          </label>
        )}
      </div>
      <InlineStatus className="mt-4">
        <span className="inline-flex items-center gap-2">
          <Undo2 aria-hidden className="size-3.5 text-accent" />
          Undoes {plural(info.data.files, 'file')}: −{info.data.removed} +
          {info.data.added} lines.
        </span>
      </InlineStatus>
      <div className="mt-4 flex gap-2.5">
        <Button
          variant="primary"
          pending={revert.isPending}
          onClick={() =>
            !revert.isPending &&
            revert.mutate({
              mainline: info.data.isMerge ? (Number(mainline) as 1 | 2) : null,
              branch: where === 'branch' ? branch.trim() : null,
            })
          }
        >
          Create revert
        </Button>
      </div>
      <p className="mt-2 text-xs text-muted">
        Needs a clean working tree. If Git stops on conflicts, the conflict
        screen opens.
      </p>
      {revert.isError && (
        <InlineStatus tone="danger" className="mt-3">
          {ipcErrorMessage(revert.error, 'The revert did not run.')}
        </InlineStatus>
      )}
      {result?.status === 'reverted' && (
        <InlineStatus tone="success" className="mt-3">
          Reverted in{' '}
          <span className="font-mono text-[0.78125rem]">
            {shortOid(result.oid)}
          </span>{' '}
          on{' '}
          <span className="font-mono text-[0.78125rem]">{result.branch}</span>.
        </InlineStatus>
      )}
      {result && <Outcome result={result} />}
    </section>
  );
}

function MergedPanel({
  repo,
  detail,
}: {
  repo: RepositorySummary;
  detail: PullDetail;
}) {
  const { pull, mergeOperation: op } = detail;
  const { data: settings } = useSettings();
  const push = usePushAction(repo.id);
  const remove = useDeletePullBranch(repo.id, pull.id);
  const [deleting, setDeleting] = useState(false);
  return (
    <div className="pt-5">
      <InlineStatus tone="success">
        Merged as{' '}
        <span className="font-mono text-[0.78125rem]">
          {pull.mergeCommitOid ? shortOid(pull.mergeCommitOid) : 'unknown'}
        </span>{' '}
        into{' '}
        <span className="font-mono text-[0.78125rem]">{pull.targetRef}</span>.
      </InlineStatus>
      {op?.state === 'push_pending' && (
        <InlineStatus
          tone="warning"
          className="mt-3"
          action={
            <Button size="sm" pending={push.running} onClick={push.start}>
              Push again
            </Button>
          }
        >
          <b className="font-semibold">Merged locally · Push pending.</b>{' '}
          {pull.targetRef} has the merge on this computer only.
        </InlineStatus>
      )}
      {op?.state === 'report_pending' && (
        <InlineStatus tone="warning" className="mt-3">
          Merged on this computer. Your account hears about it the next time
          this page loads with a connection.
        </InlineStatus>
      )}
      {settings?.pullOfferDeleteBranch && (
        <div className="mt-4">
          {deleting ? (
            <div
              role="alert"
              className="flex flex-wrap items-center gap-3 bg-danger-soft px-3 py-2.5 text-[0.8125rem] text-ink"
            >
              <span className="min-w-0 flex-1">
                Delete{' '}
                <span className="font-mono text-[0.78125rem]">
                  {pull.sourceRef}
                </span>{' '}
                on this computer? Git refuses if it has commits that aren't
                merged.
              </span>
              <Button
                variant="danger"
                size="sm"
                pending={remove.isPending}
                onClick={() =>
                  remove.mutate(undefined, {
                    onSuccess: () => setDeleting(false),
                  })
                }
              >
                Delete branch
              </Button>
              <Button size="sm" onClick={() => setDeleting(false)}>
                Keep it
              </Button>
            </div>
          ) : (
            <Button onClick={() => setDeleting(true)}>
              Delete branch {pull.sourceRef}
            </Button>
          )}
          {remove.data && (
            <InlineStatus
              tone={remove.data.deleted ? 'success' : 'warning'}
              className="mt-2"
            >
              {remove.data.deleted
                ? `${pull.sourceRef} was deleted.`
                : remove.data.message}
            </InlineStatus>
          )}
          {remove.isError && (
            <InlineStatus tone="danger" className="mt-2">
              {ipcErrorMessage(remove.error, "The branch wasn't deleted.")}
            </InlineStatus>
          )}
        </div>
      )}
      <RevertPanel repo={repo} detail={detail} />
    </div>
  );
}

export function MergeTab({
  repo,
  detail,
}: {
  repo: RepositorySummary;
  detail: PullDetail;
}) {
  const { pull } = detail;
  const conflicts = useConflicts(repo.id, repo.statusAt);
  const reopen = useSetPullStatus(repo.id, pull.id);
  // Only an operation gitdesk started for this pull request; one from a terminal is finished there.
  const inConflict =
    !!conflicts.data?.operation && conflicts.data.pullId === pull.id;
  return (
    <div className="@container">
      {inConflict ? (
        <ConflictsView
          repo={repo}
          pullSource={pull.sourceRef}
          pullTarget={pull.targetRef}
        />
      ) : pull.status === 'open' ? (
        <MergePanel repo={repo} detail={detail} />
      ) : pull.status === 'merged' ? (
        <MergedPanel repo={repo} detail={detail} />
      ) : (
        <EmptyState
          art={<PullRequestsArt />}
          title="Closed without merging"
          action={
            <Button
              pending={reopen.isPending}
              onClick={() => reopen.mutate('open')}
            >
              Reopen
            </Button>
          }
        >
          Reopen it to review and merge it again. Its branches and comments were
          kept.
        </EmptyState>
      )}
      {reopen.isError && (
        <InlineStatus tone="danger" className="mt-3">
          {ipcErrorMessage(reopen.error, "It wasn't reopened.")}
        </InlineStatus>
      )}
    </div>
  );
}
