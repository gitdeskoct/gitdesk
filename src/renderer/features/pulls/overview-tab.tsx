import { useState } from 'react';
import type { PullDetail, ReviewDecision } from '../../../shared/pulls';
import type { RepositorySummary } from '../../../shared/repos';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Segmented } from '../../components/ui/segmented';
import { InlineStatus, Loading } from '../../components/ui/status';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAddComment,
  useCheckMergeability,
  usePullComments,
  useSubmitReview,
  useUpdatePull,
} from '../../lib/pull-queries';
import { Composer, Thread, groupThreads } from './comments';
import { MergeabilityBand, PullStrip } from './pull-preview';
import {
  AuthorBadge,
  MergeabilityChip,
  ReviewChip,
  plural,
  shortOid,
} from './pull-bits';

const DECISIONS: { value: ReviewDecision; label: string }[] = [
  { value: 'commented', label: 'Comment' },
  { value: 'approved', label: 'Approve' },
  { value: 'changes_requested', label: 'Request changes' },
];

function EditDetails({
  repoId,
  detail,
  onDone,
}: {
  repoId: string;
  detail: PullDetail;
  onDone: () => void;
}) {
  const { pull } = detail;
  const update = useUpdatePull(repoId, pull.id);
  const [title, setTitle] = useState(pull.title);
  const [description, setDescription] = useState(pull.description);
  const [draft, setDraft] = useState(pull.isDraft);
  return (
    <form
      aria-label="Edit pull request"
      onSubmit={(event) => {
        event.preventDefault();
        if (!title.trim() || update.isPending) return;
        update.mutate(
          { title: title.trim(), description, draft },
          { onSuccess: onDone },
        );
      }}
      className="grid gap-3"
    >
      <label>
        <span className="mb-1.5 block text-[0.8125rem] font-medium text-ink">
          Title
        </span>
        <input
          className="field h-9 w-full px-3 text-[0.8125rem] outline-none"
          value={title}
          maxLength={200}
          onChange={(event) => setTitle(event.target.value)}
        />
      </label>
      <label>
        <span className="mb-1.5 block text-[0.8125rem] font-medium text-ink">
          Description
        </span>
        <textarea
          className="field min-h-28 w-full px-3 py-2 text-[0.8125rem] leading-relaxed outline-none"
          value={description}
          maxLength={10_000}
          onChange={(event) => setDescription(event.target.value)}
        />
      </label>
      <label className="flex items-center gap-2.5 text-[0.8125rem] text-ink">
        <Checkbox
          checked={draft}
          onCheckedChange={(value) => setDraft(value === true)}
        />
        Draft (not ready for review)
      </label>
      {update.isError && (
        <InlineStatus tone="danger">
          {ipcErrorMessage(update.error, "The changes weren't saved.")}
        </InlineStatus>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          pending={update.isPending}
          aria-disabled={!title.trim() || undefined}
        >
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function OverviewTab({
  repo,
  detail,
  editing,
  onEditDone,
}: {
  repo: RepositorySummary;
  detail: PullDetail;
  editing: boolean;
  onEditDone: () => void;
}) {
  const { pull, comparison } = detail;
  const comments = usePullComments(repo.id, pull.id, pull.latest?.version ?? 0);
  const general = groupThreads(
    (comments.data ?? []).filter((c) => !c.anchor || !c.position || c.outdated),
  );
  const add = useAddComment(repo.id, pull.id);
  const review = useSubmitReview(repo.id, pull.id);
  const check = useCheckMergeability(repo.id, pull.id);
  const [decision, setDecision] = useState<ReviewDecision>('commented');
  const latest = pull.latest;
  const open = pull.status === 'open';

  return (
    <div className="@container grid gap-x-9 gap-y-6 pt-5 @min-[880px]:grid-cols-[minmax(0,1fr)_17rem]">
      <div className="min-w-0">
        <PullStrip comparison={comparison} />
        <section aria-labelledby="pr-description" className="mt-6">
          <h2
            id="pr-description"
            className="text-[0.9375rem] font-semibold text-ink"
          >
            Description
          </h2>
          <div className="mt-2">
            {editing ? (
              <EditDetails
                repoId={repo.id}
                detail={detail}
                onDone={onEditDone}
              />
            ) : pull.description ? (
              <p className="text-[0.84375rem] whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
                {pull.description}
              </p>
            ) : (
              <p className="text-[0.8125rem] text-muted">No description.</p>
            )}
          </div>
        </section>

        <section aria-labelledby="pr-discussion" className="mt-7">
          <h2
            id="pr-discussion"
            className="flex items-baseline gap-3 text-[0.9375rem] font-semibold text-ink"
          >
            Discussion
            <span className="ml-auto text-xs font-normal text-muted">
              {pull.comments
                ? `${plural(pull.comments, 'comment')} · ${pull.unresolved} unresolved`
                : 'Line comments are on Files changed'}
            </span>
          </h2>
          <div className="mt-2 border-t border-line">
            {comments.isPending && <Loading label="Loading comments…" />}
            {comments.isError && (
              <InlineStatus
                tone="danger"
                className="mt-3"
                action={
                  <Button
                    size="sm"
                    pending={comments.isFetching}
                    onClick={() => void comments.refetch()}
                  >
                    Try again
                  </Button>
                }
              >
                {ipcErrorMessage(comments.error, "The comments didn't load.")}
              </InlineStatus>
            )}
            {general.map(({ root, replies }) => (
              <div key={root.id} className="border-b border-line py-3.5">
                <Thread
                  repoId={repo.id}
                  pullId={pull.id}
                  root={root}
                  replies={replies}
                  canReply
                />
              </div>
            ))}
            {comments.data && !general.length && (
              <p className="py-3 text-[0.8125rem] text-muted">
                No general comments yet.
              </p>
            )}
          </div>
          <div className="mt-3">
            <Composer
              label="Comment on the whole pull request"
              placeholder="Leave a comment on the whole pull request"
              submitLabel="Comment"
              pending={add.isPending}
              error={add.error}
              onSubmit={(body, done) =>
                add.mutate(
                  { body, parentId: null, line: null },
                  { onSuccess: done },
                )
              }
            />
          </div>
        </section>

        {open && latest && (
          <section aria-labelledby="pr-review" className="mt-7">
            <h2
              id="pr-review"
              className="text-[0.9375rem] font-semibold text-ink"
            >
              Review
            </h2>
            <p className="mt-1 text-xs text-muted">
              Tied to snapshot {latest.version}: {shortOid(latest.sourceOid)}{' '}
              into {shortOid(latest.targetOid)}. A newer commit makes it stale.
            </p>
            <div className="mt-2.5">
              <Segmented
                label="Review decision"
                value={decision}
                onChange={setDecision}
                options={DECISIONS}
              />
            </div>
            <div className="mt-2.5">
              <Composer
                key={decision}
                label="Review summary"
                placeholder={
                  decision === 'approved'
                    ? 'Optional: what you checked'
                    : 'What should change, or what you noticed'
                }
                submitLabel="Submit review"
                pending={review.isPending}
                error={review.error}
                onSubmit={(body, done) =>
                  review.mutate(
                    { decision, body, version: latest.version },
                    { onSuccess: done },
                  )
                }
              />
            </div>
          </section>
        )}
      </div>

      <aside aria-label="Status" className="min-w-0 text-[0.8125rem]">
        <h3 className="font-semibold text-ink">Review</h3>
        <div className="mt-1.5">
          <ReviewChip pull={pull} />
        </div>
        {pull.review && (
          <p className="mt-1 text-xs text-muted">
            {pull.review.stale
              ? `Made on snapshot ${pull.review.version}. Commits were added after it.`
              : `On snapshot ${pull.review.version}, the latest.`}
          </p>
        )}
        {open && (
          <>
            <h3 className="mt-5 font-semibold text-ink">Mergeability</h3>
            <div className="mt-1.5">
              <MergeabilityChip pull={pull} />
            </div>
            <div className="mt-2">
              <MergeabilityBand
                pull={pull}
                stacked
                pending={check.isPending}
                onCheck={() => check.mutate()}
              />
            </div>
            {check.isError && (
              <InlineStatus tone="danger" className="mt-2">
                {ipcErrorMessage(check.error, "The check didn't run.")}
              </InlineStatus>
            )}
          </>
        )}
        <h3 className="mt-5 font-semibold text-ink">Author</h3>
        <div className="mt-1.5 flex items-center gap-2 text-ink">
          <AuthorBadge author={pull.author} />
          {pull.author.name}
        </div>
        {latest && (
          <>
            <h3 className="mt-5 font-semibold text-ink">Compared commits</h3>
            <dl className="mt-1.5 grid grid-cols-[4.5rem_minmax(0,1fr)] border-t border-line [&>*]:border-b [&>*]:border-line [&>*]:py-1.5">
              <dt className="text-muted">Source</dt>
              <dd className="font-mono text-[0.75rem]">
                {shortOid(latest.sourceOid)}
              </dd>
              <dt className="text-muted">Target</dt>
              <dd className="font-mono text-[0.75rem]">
                {shortOid(latest.targetOid)}
              </dd>
              <dt className="text-muted">Base</dt>
              <dd className="font-mono text-[0.75rem]">
                {latest.mergeBaseOid ? shortOid(latest.mergeBaseOid) : 'None'}
              </dd>
            </dl>
            <p className="mt-1.5 text-xs text-muted">
              Snapshot {latest.version}
              {latest.checkedAt
                ? `, checked ${relativeTime(latest.checkedAt)}`
                : ''}
            </p>
          </>
        )}
      </aside>
    </div>
  );
}
