import {
  CircleAlert,
  CircleCheck,
  CircleDashed,
  CircleX,
  Cloud,
  GitMerge,
  GitPullRequest,
  HardDrive,
  MessageSquare,
  RefreshCw,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import type {
  CompareProblem,
  PullAuthor,
  PullRequest,
} from '../../../shared/pulls';
import { Avatar } from '../../components/ui/avatar';
import { cn } from '../../lib/cn';

const TONES = {
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-danger',
  muted: 'text-muted',
  ink: 'text-ink',
};

// Icon plus word in ink: the color sits on the icon only, so meaning never rests on color.
export function Chip({
  icon: Icon,
  tone,
  children,
  className,
}: {
  icon: LucideIcon;
  tone: keyof typeof TONES;
  children: string;
  className?: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[0.8125rem] font-medium whitespace-nowrap text-ink',
        className,
      )}
    >
      <Icon aria-hidden className={cn('size-3.5 shrink-0', TONES[tone])} />
      {children}
    </span>
  );
}

export function PullStateChip({ pull }: { pull: PullRequest }) {
  if (pull.status === 'merged')
    return (
      <Chip icon={GitMerge} tone="ink">
        Merged
      </Chip>
    );
  if (pull.status === 'closed')
    return (
      <Chip icon={CircleX} tone="bad">
        Closed
      </Chip>
    );
  return (
    <Chip icon={GitPullRequest} tone="ok">
      {pull.isDraft ? 'Draft' : 'Open'}
    </Chip>
  );
}

export function ReviewChip({ pull }: { pull: PullRequest }) {
  const review = pull.review;
  if (!review)
    return (
      <Chip icon={MessageSquare} tone="muted">
        No review yet
      </Chip>
    );
  if (review.stale)
    return (
      <Chip icon={RefreshCw} tone="warn">
        Approval is stale
      </Chip>
    );
  return review.decision === 'approved' ? (
    <Chip icon={CircleCheck} tone="ok">
      Approved
    </Chip>
  ) : (
    <Chip icon={TriangleAlert} tone="warn">
      Changes requested
    </Chip>
  );
}

export const PROBLEM_WORDS: Record<CompareProblem, string> = {
  'same-branch': 'Same branch on both sides',
  'source-missing': 'Source branch not found',
  'target-missing': 'Target branch not found',
  unrelated: 'No shared history',
  'nothing-to-merge': 'Nothing to merge',
};

// What the last check found, in words. A check of older commits is not shown as current.
export function MergeabilityChip({
  pull,
  className,
}: {
  pull: PullRequest;
  className?: string;
}) {
  const latest = pull.latest;
  if (pull.status !== 'open') return null;
  if (!latest || latest.mergeability === 'unknown')
    return (
      <Chip icon={CircleDashed} tone="muted" className={className}>
        Not checked
      </Chip>
    );
  if (latest.mergeability === 'mergeable')
    return (
      <Chip icon={CircleCheck} tone="ok" className={className}>
        Mergeable
      </Chip>
    );
  if (latest.mergeability === 'conflicts')
    return (
      <Chip icon={CircleX} tone="bad" className={className}>
        {latest.conflicts.length === 1
          ? '1 conflict'
          : latest.conflicts.length
            ? `${latest.conflicts.length} conflicts`
            : 'Conflicts'}
      </Chip>
    );
  return (
    <Chip icon={CircleAlert} tone="muted" className={className}>
      Unavailable
    </Chip>
  );
}

const tagClass =
  'inline-flex h-5 items-center gap-1 rounded-[4px] border border-line bg-sunken px-1.5 text-[0.71875rem] font-medium text-ink [&_svg]:size-3 [&_svg]:text-muted';

// Where the review records live: on this computer, or in the account.
export function StoreTag({ store }: { store: 'local' | 'account' }) {
  return store === 'local' ? (
    <span className={tagClass} title="Stored on this computer">
      <HardDrive aria-hidden />
      Local
    </span>
  ) : (
    <span className={tagClass} title="Stored in your gitdesk account">
      <Cloud aria-hidden />
      Account
    </span>
  );
}

export const Tag = ({ children }: { children: string }) => (
  <span className={tagClass}>{children}</span>
);

export function BranchPair({
  source,
  target,
  className,
}: {
  source: string;
  target: string;
  className?: string;
}) {
  return (
    <span className={cn('inline-flex min-w-0 items-center gap-1.5', className)}>
      <span className="truncate font-mono text-[0.78125rem]">{source}</span>
      <span aria-label="into" className="text-muted">
        →
      </span>
      <span className="truncate font-mono text-[0.78125rem]">{target}</span>
    </span>
  );
}

export function AuthorBadge({
  author,
  size = 'md',
}: {
  author: PullAuthor;
  size?: 'sm' | 'md';
}) {
  return (
    <Avatar
      name={author.name}
      src={author.avatarUrl}
      className={size === 'sm' ? 'size-6' : 'size-7'}
    />
  );
}

export const shortOid = (oid: string) => oid.slice(0, 7);

export const plural = (n: number, one: string, many = `${one}s`) =>
  `${n} ${n === 1 ? one : many}`;
