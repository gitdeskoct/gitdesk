import { RefreshCw } from 'lucide-react';
import type { ComponentProps } from 'react';
import type { Comparison, PullRequest } from '../../../shared/pulls';
import type { RepositorySummary } from '../../../shared/repos';
import { Button } from '../../components/ui/button';
import { InlineStatus } from '../../components/ui/status';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useCheckMergeability, usePullDetail } from '../../lib/pull-queries';
import {
  BranchPair,
  MergeabilityChip,
  PullStateChip,
  ReviewChip,
  StoreTag,
  plural,
  shortOid,
} from './pull-bits';

// Four numbers that say how big a change is, read from Git's comparison.
export function PullStrip({ comparison }: { comparison: Comparison | null }) {
  const cells: [string, string][] = comparison
    ? [
        [
          String(comparison.commits.length) +
            (comparison.commitsTruncated ? '+' : ''),
          'Commits',
        ],
        [
          String(comparison.files.length) +
            (comparison.filesTruncated ? '+' : ''),
          'Files changed',
        ],
        [`+${comparison.added}`, 'Lines added'],
        [`−${comparison.removed}`, 'Lines removed'],
      ]
    : [
        ['–', 'Commits'],
        ['–', 'Files changed'],
        ['–', 'Lines added'],
        ['–', 'Lines removed'],
      ];
  return (
    <dl className="grid grid-cols-2 border-y border-line @min-[560px]:grid-cols-4">
      {cells.map(([value, label]) => (
        <div
          key={label}
          className="border-line px-4 py-3 not-first:border-l first:pl-0 @max-[559px]:nth-3:border-l-0 @max-[559px]:nth-3:pl-0"
        >
          <dd className="text-[1.625rem] leading-8 font-semibold tracking-[-0.02em] text-ink tabular-nums">
            {value}
          </dd>
          <dt className="text-xs text-muted">{label}</dt>
        </div>
      ))}
    </dl>
  );
}

// What a check found, as a band: when to check again, conflicts, or why it can't be checked.
// `stacked` puts the button under the sentence, for a narrow side column.
export function MergeabilityBand({
  pull,
  onCheck,
  pending,
  stacked = false,
}: {
  pull: PullRequest;
  onCheck: () => void;
  pending: boolean;
  stacked?: boolean;
}) {
  const latest = pull.latest;
  if (pull.status !== 'open' || !latest) return null;
  const button = (
    <Button
      size="sm"
      pending={pending}
      onClick={onCheck}
      className={stacked ? 'mt-2 flex' : undefined}
    >
      {!pending && <RefreshCw />}
      Check mergeability
    </Button>
  );
  const [tone, text]: [ComponentProps<typeof InlineStatus>['tone'], string] =
    latest.mergeability === 'unknown'
      ? [
          'info',
          latest.version > 1 && latest.checkedAt === null
            ? 'The branches moved since the last check. Check again before merging.'
            : 'Not checked yet. Git can test the merge without touching your files.',
        ]
      : latest.mergeability === 'mergeable'
        ? [
            'success',
            `Git found no conflicts merging ${shortOid(latest.sourceOid)} into ${shortOid(latest.targetOid)}${latest.checkedAt ? `, ${relativeTime(latest.checkedAt)}` : ''}.`,
          ]
        : latest.mergeability === 'conflicts'
          ? [
              'danger',
              `${
                latest.conflicts.length
                  ? `${plural(latest.conflicts.length, 'file')} would conflict: ${latest.conflicts.slice(0, 3).join(', ')}${latest.conflicts.length > 3 ? '…' : ''}.`
                  : 'Git found conflicts.'
              } You can still merge and resolve them here.`,
            ]
          : [
              'warning',
              latest.reason === 'git-too-old'
                ? 'Checking needs Git 2.38 or newer. Merging still works; only the check before it does not.'
                : latest.reason === 'unrelated'
                  ? 'These branches share no history, so Git cannot test the merge.'
                  : 'Git could not test the merge. Try again.',
            ];
  return (
    <InlineStatus tone={tone} action={stacked ? undefined : button}>
      {text}
      {stacked && button}
    </InlineStatus>
  );
}

export function PullPreview({
  repo,
  pull,
  onOpen,
}: {
  repo: RepositorySummary;
  pull: PullRequest;
  onOpen: () => void;
}) {
  const detail = usePullDetail(repo.id, pull.id, repo.statusAt);
  const check = useCheckMergeability(repo.id, pull.id);
  const live = detail.data?.pull ?? pull;
  const comparison = detail.data?.comparison ?? null;
  const last = comparison?.commits[comparison.commits.length - 1];
  return (
    <section
      aria-label="Selected pull request"
      className="@container max-w-3xl"
    >
      <p className="text-xs text-muted">
        Pull request #{live.number} · opened by {live.author.name}{' '}
        {relativeTime(live.createdAt)}
      </p>
      <h2 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-ink">
        {live.title}
      </h2>
      <div className="mt-1.5 flex flex-wrap items-center gap-x-3 gap-y-1 text-[0.8125rem]">
        <PullStateChip pull={live} />
        <BranchPair source={live.sourceRef} target={live.targetRef} />
        <StoreTag store={live.store} />
      </div>
      <div className="mt-5">
        <PullStrip comparison={comparison} />
      </div>
      <div className="mt-4">
        <MergeabilityBand
          pull={live}
          pending={check.isPending}
          onCheck={() => check.mutate()}
        />
        {check.isError && (
          <InlineStatus tone="danger" className="mt-2">
            {ipcErrorMessage(check.error, "The check didn't run.")}
          </InlineStatus>
        )}
      </div>
      <dl className="mt-4 grid grid-cols-[8rem_minmax(0,1fr)] border-t border-line text-[0.8125rem] [&>*]:border-b [&>*]:border-line [&>*]:py-2.5">
        <dt className="text-muted">Review</dt>
        <dd>
          <ReviewChip pull={live} />
        </dd>
        <dt className="text-muted">Discussion</dt>
        <dd className="text-ink">
          {live.comments
            ? `${plural(live.comments, 'comment')}, ${plural(live.unresolved, 'unresolved thread')}`
            : 'No comments yet'}
        </dd>
        <dt className="text-muted">Latest commit</dt>
        <dd className="min-w-0 truncate text-ink">
          {last ? (
            <>
              <span className="font-mono text-[0.75rem]">
                {shortOid(last.oid)}
              </span>{' '}
              {last.subject} · {relativeTime(last.at)}
            </>
          ) : detail.isPending ? (
            'Comparing…'
          ) : (
            'None to show'
          )}
        </dd>
        <dt className="text-muted">Mergeability</dt>
        <dd>
          <MergeabilityChip pull={live} />
          {live.status !== 'open' && (
            <span className="text-muted">
              Not checked after it is {live.status}
            </span>
          )}
        </dd>
      </dl>
      <div className="mt-5 flex flex-wrap gap-2.5">
        <Button variant="primary" onClick={onOpen}>
          Open review
        </Button>
      </div>
      <p className="mt-3 text-xs text-muted">
        Arrow keys move through the list. Enter opens the review.
      </p>
    </section>
  );
}
