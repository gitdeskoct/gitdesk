import {
  ArrowDownToLine,
  Check,
  CircleAlert,
  Clock,
  CloudDownload,
  CloudUpload,
  X,
  type LucideIcon,
} from 'lucide-react';
import type { SyncOperation } from '../../../shared/sync';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { shortOid } from '../pulls/pull-bits';

const VERB: Record<SyncOperation['kind'], [done: string, failed: string]> = {
  fetch: ['Fetched', 'Fetch failed'],
  pull: ['Pulled', "Didn't pull"],
  push: ['Pushed', 'Push failed'],
  move: ['Moved to gitdesk', "Move didn't finish"],
  'remote-delete': ['Deleted on the remote', "Didn't delete on the remote"],
};

// What the record says, in words: the kind, its target and how it ended.
export function describe(op: SyncOperation): {
  icon: LucideIcon;
  tone: string;
  title: string;
  tag: string | null;
  detail: string | null;
} {
  const target =
    op.kind === 'fetch'
      ? op.remote
      : op.kind === 'pull'
        ? op.remote
        : op.kind === 'push' && op.remote && op.branch
          ? `${op.remote}/${op.branch}`
          : null;
  const range =
    op.oldOid && op.newOid
      ? `${shortOid(op.oldOid)}..${shortOid(op.newOid)}`
      : op.newOid
        ? shortOid(op.newOid)
        : null;
  if (op.state === 'unknown')
    return {
      icon: CircleAlert,
      tone: 'text-accent',
      title: `Push to ${target ?? 'the remote'} unconfirmed`,
      tag: 'Result unknown',
      detail: op.message,
    };
  if (op.state === 'conflict_resolution' || op.state === 'merging')
    return {
      icon: CircleAlert,
      tone: 'text-warning',
      title: `Pulling ${target ?? ''}`.trim(),
      tag: 'Waiting on conflicts',
      detail: 'Resolve them on the Sync tab to finish.',
    };
  if (op.state === 'fetching' || op.state === 'pushing')
    return {
      icon: Clock,
      tone: 'text-muted',
      title:
        `${op.kind === 'fetch' ? 'Fetching' : 'Pushing'} ${target ?? ''}`.trim(),
      tag: 'Running',
      detail: null,
    };
  const failed = op.state === 'failed' || op.state === 'cancelled';
  const icon = failed
    ? X
    : op.kind === 'fetch'
      ? CloudDownload
      : op.kind === 'pull'
        ? ArrowDownToLine
        : op.kind === 'push'
          ? CloudUpload
          : Check;
  const tag = failed
    ? op.state === 'cancelled'
      ? 'Cancelled'
      : op.code === 'NON_FAST_FORWARD' || op.code === 'REMOTE_REJECTED'
        ? 'Refused'
        : 'Failed'
    : op.kind === 'push'
      ? op.state === 'report_pending'
        ? 'Not confirmed yet'
        : op.server === 'confirmed'
          ? 'Confirmed by server'
          : op.server === 'unverified'
            ? 'Not confirmed'
            : 'Accepted by the remote'
      : op.kind === 'pull' && op.strategy
        ? {
            'ff-only': 'Fast-forward',
            merge: 'Merged locally',
            rebase: 'Rebased',
          }[op.strategy]
        : null;
  return {
    icon,
    tone: failed
      ? 'text-danger'
      : op.server === 'confirmed'
        ? 'text-success'
        : 'text-muted',
    title: `${VERB[op.kind][failed ? 1 : 0]}${target && op.kind !== 'move' ? ` ${target}` : ''}`,
    tag,
    detail: failed ? op.message : op.kind === 'move' ? null : range,
  };
}

export function OperationRow({
  op,
  showRepository = false,
}: {
  op: SyncOperation;
  showRepository?: boolean;
}) {
  const words = describe(op);
  const Icon = words.icon;
  return (
    <li className="grid grid-cols-[1rem_minmax(0,1fr)_auto] items-start gap-x-3 gap-y-0.5 border-b border-line py-2.5 text-[0.8125rem]">
      <Icon aria-hidden className={cn('mt-0.5 size-4', words.tone)} />
      <span className="min-w-0">
        <span className="font-medium text-ink">{words.title}</span>
        {showRepository && op.repositoryName && (
          <span className="text-muted"> · {op.repositoryName}</span>
        )}
        {words.detail && (
          <span
            className={cn(
              'block truncate text-xs text-muted',
              words.detail === words.title || /^[0-9a-f]{7}/.test(words.detail)
                ? 'font-mono'
                : '',
            )}
            title={words.detail}
          >
            {words.detail}
          </span>
        )}
      </span>
      <span className="flex flex-col items-end gap-1 text-xs text-muted">
        <span className="whitespace-nowrap">{relativeTime(op.at)}</span>
        {words.tag && (
          <span className="inline-flex h-5 items-center rounded-[4px] border border-line bg-sunken px-1.5 text-[0.71875rem] font-medium whitespace-nowrap text-ink">
            {words.tag}
          </span>
        )}
      </span>
    </li>
  );
}
