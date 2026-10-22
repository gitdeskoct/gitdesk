import { useState } from 'react';
import type { PullComment } from '../../../shared/pulls';
import { Button } from '../../components/ui/button';
import { InlineStatus } from '../../components/ui/status';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAddComment,
  useDeleteComment,
  useEditComment,
} from '../../lib/pull-queries';
import { AuthorBadge, Tag } from './pull-bits';

// A text box whose draft survives a failed send: it clears only after the save succeeded.
export function Composer({
  label,
  placeholder,
  submitLabel,
  pending,
  error,
  onSubmit,
  onCancel,
  autoFocus,
  initial = '',
}: {
  label: string;
  placeholder: string;
  submitLabel: string;
  pending: boolean;
  error: unknown;
  onSubmit: (body: string, done: () => void) => void;
  onCancel?: () => void;
  autoFocus?: boolean;
  initial?: string;
}) {
  const [body, setBody] = useState(initial);
  const empty = !body.trim();
  return (
    <form
      onSubmit={(event) => {
        event.preventDefault();
        if (!empty && !pending) onSubmit(body.trim(), () => setBody(''));
      }}
    >
      <label className="block">
        <span className="sr-only">{label}</span>
        <textarea
          autoFocus={autoFocus}
          value={body}
          maxLength={10_000}
          placeholder={placeholder}
          onChange={(event) => setBody(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter' && (event.metaKey || event.ctrlKey))
              event.currentTarget.form?.requestSubmit();
            if (event.key === 'Escape' && onCancel) onCancel();
          }}
          className="field min-h-18 w-full px-3 py-2 font-sans text-[0.8125rem] leading-relaxed outline-none placeholder:text-muted"
        />
      </label>
      {!!error && (
        <InlineStatus tone="danger" className="mt-2">
          {ipcErrorMessage(
            error,
            "That wasn't saved. Your text is still here.",
          )}
        </InlineStatus>
      )}
      <div className="mt-2 flex flex-wrap items-center gap-2">
        <Button
          type="submit"
          size="sm"
          variant="primary"
          pending={pending}
          aria-disabled={empty || undefined}
        >
          {submitLabel}
        </Button>
        {onCancel && (
          <Button type="button" size="sm" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
        )}
      </div>
    </form>
  );
}

function CommentBody({
  repoId,
  pullId,
  comment,
}: {
  repoId: string;
  pullId: string;
  comment: PullComment;
}) {
  const [editing, setEditing] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const edit = useEditComment(repoId, pullId);
  const remove = useDeleteComment(repoId, pullId);
  const anchor = comment.anchor;
  return (
    <div className="flex gap-2.5">
      <AuthorBadge author={comment.author} size="sm" />
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-baseline gap-x-2 text-[0.8125rem]">
          <span className="font-semibold text-ink">{comment.author.name}</span>
          <span className="text-xs text-muted">
            {relativeTime(comment.createdAt)}
            {comment.updatedAt > comment.createdAt + 1000 && !comment.deleted
              ? ' · edited'
              : ''}
          </span>
          {anchor && (
            <span className="text-xs text-muted">
              on <span className="font-mono">{anchor.path}</span> line{' '}
              {anchor.side === 'new' ? anchor.newLine : anchor.oldLine},
              snapshot {anchor.comparisonVersion}
              {comment.position &&
                comment.position.line !==
                  (anchor.side === 'new' ? anchor.newLine : anchor.oldLine) &&
                ` · now line ${comment.position.line}`}
            </span>
          )}
          {comment.outdated && <Tag>Outdated</Tag>}
        </div>
        {comment.deleted ? (
          <p className="mt-0.5 text-[0.8125rem] text-muted italic">
            Comment deleted
          </p>
        ) : editing ? (
          <div className="mt-1.5">
            <Composer
              label="Edit comment"
              placeholder=""
              submitLabel="Save"
              initial={comment.body}
              autoFocus
              pending={edit.isPending}
              error={edit.error}
              onCancel={() => setEditing(false)}
              onSubmit={(body) =>
                edit.mutate(
                  { commentId: comment.id, body },
                  { onSuccess: () => setEditing(false) },
                )
              }
            />
          </div>
        ) : (
          <p className="mt-0.5 text-[0.84375rem] whitespace-pre-wrap text-ink [overflow-wrap:anywhere]">
            {comment.body}
          </p>
        )}
        {!comment.deleted && !editing && comment.mine && (
          <div className="mt-1 flex gap-1">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-1.5"
              onClick={() => setEditing(true)}
            >
              Edit
            </Button>
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-1.5"
              onClick={() => setDeleting(true)}
            >
              Delete
            </Button>
          </div>
        )}
        {deleting && (
          <div
            role="alert"
            className="mt-2 flex flex-wrap items-center gap-3 bg-danger-soft px-3 py-2 text-[0.8125rem] text-ink"
          >
            <span className="min-w-0 flex-1">
              Delete this comment? Replies stay under "Comment deleted".
            </span>
            <Button
              size="sm"
              variant="danger"
              pending={remove.isPending}
              onClick={() =>
                remove.mutate(comment.id, {
                  onSuccess: () => setDeleting(false),
                })
              }
            >
              Delete
            </Button>
            <Button size="sm" onClick={() => setDeleting(false)}>
              Keep it
            </Button>
          </div>
        )}
        {remove.isError && (
          <InlineStatus tone="danger" className="mt-2">
            {ipcErrorMessage(remove.error, "The comment wasn't deleted.")}
          </InlineStatus>
        )}
      </div>
    </div>
  );
}

// A first comment and its replies, with Reply and Resolve. Threads are one level deep.
export function Thread({
  repoId,
  pullId,
  root,
  replies,
  canReply,
}: {
  repoId: string;
  pullId: string;
  root: PullComment;
  replies: PullComment[];
  canReply: boolean;
}) {
  const [replying, setReplying] = useState(false);
  const add = useAddComment(repoId, pullId);
  const resolve = useEditComment(repoId, pullId);
  return (
    <div className="grid gap-3">
      <CommentBody repoId={repoId} pullId={pullId} comment={root} />
      {replies.map((reply) => (
        <div key={reply.id} className="pl-8">
          <CommentBody repoId={repoId} pullId={pullId} comment={reply} />
        </div>
      ))}
      {replying ? (
        <div className="pl-8">
          <Composer
            label="Reply"
            placeholder="Reply to this thread"
            submitLabel="Reply"
            autoFocus
            pending={add.isPending}
            error={add.error}
            onCancel={() => setReplying(false)}
            onSubmit={(body, done) =>
              add.mutate(
                { body, parentId: root.id, line: null },
                {
                  onSuccess: () => {
                    done();
                    setReplying(false);
                  },
                },
              )
            }
          />
        </div>
      ) : (
        canReply && (
          <div className="flex flex-wrap gap-1 pl-8">
            <Button
              size="sm"
              variant="ghost"
              className="h-7 px-1.5"
              onClick={() => setReplying(true)}
            >
              Reply
            </Button>
            {!root.deleted && (
              <Button
                size="sm"
                variant="ghost"
                className="h-7 px-1.5"
                pending={resolve.isPending}
                onClick={() =>
                  resolve.mutate({
                    commentId: root.id,
                    resolved: !root.resolved,
                  })
                }
              >
                {root.resolved ? 'Reopen thread' : 'Resolve'}
              </Button>
            )}
            {root.resolved && (
              <span className="self-center text-xs text-muted">Resolved</span>
            )}
          </div>
        )
      )}
    </div>
  );
}

export function groupThreads(comments: PullComment[]) {
  const replies = new Map<string, PullComment[]>();
  for (const c of comments)
    if (c.parentId)
      replies.set(c.parentId, [...(replies.get(c.parentId) ?? []), c]);
  return comments
    .filter((c) => !c.parentId)
    .map((root) => ({ root, replies: replies.get(root.id) ?? [] }));
}
