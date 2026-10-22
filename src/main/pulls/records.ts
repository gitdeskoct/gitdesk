import type {
  CommentAnchor,
  Mergeability,
  MergeabilityReason,
  PullAuthor,
  PullCounts,
  PullEvent,
  PullEventType,
  PullRequest,
  PullStatRange,
  PullStats,
  ReviewDecision,
} from '../../shared/pulls';

// The review records of one repository's pull requests, kept either in local SQLite or in the
// account. Git facts (comparisons, checks, merges) are computed by the service and written here.

export type StoredComment = {
  id: string;
  parentId: string | null;
  author: PullAuthor;
  body: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  resolved: boolean;
  anchor: CommentAnchor | null;
};

export type StoredReview = {
  id: string;
  decision: ReviewDecision;
  body: string;
  version: number;
  sourceOid: string;
  targetOid: string;
  author: PullAuthor;
  submittedAt: number;
};

// Events gitdesk records itself; the rest are written by the store as side effects of a change.
export type ReportedEvent = Extract<
  PullEventType,
  | 'merge_started'
  | 'merge_conflicts'
  | 'merge_aborted'
  | 'merge_failed'
  | 'pushed'
  | 'reverted'
  | 'branch_deleted'
>;

export interface PullRecords {
  readonly store: 'local' | 'account';
  list(input: {
    status: PullRequest['status'];
    q: string;
    cursor: string | null;
  }): Promise<{
    pulls: PullRequest[];
    nextCursor: string | null;
    counts: PullCounts;
  }>;
  get(id: string): Promise<PullRequest | null>;
  create(input: {
    title: string;
    description: string;
    sourceRef: string;
    targetRef: string;
    draft: boolean;
    key: string;
    author: PullAuthor;
  }): Promise<PullRequest>;
  update(
    id: string,
    patch: { title?: string; description?: string; draft?: boolean },
    actor: PullAuthor,
  ): Promise<PullRequest>;
  setStatus(
    id: string,
    status: 'open' | 'closed',
    actor: PullAuthor,
  ): Promise<PullRequest>;
  // A new snapshot version when either commit moved; the same version otherwise.
  recordComparison(
    id: string,
    snapshot: {
      sourceOid: string;
      targetOid: string;
      mergeBaseOid: string | null;
    },
    actor: PullAuthor,
  ): Promise<PullRequest>;
  recordCheck(
    id: string,
    version: number,
    check: {
      mergeability: Mergeability;
      reason: MergeabilityReason | null;
      conflicts: string[];
    },
    actor: PullAuthor,
  ): Promise<PullRequest>;
  reviews(id: string): Promise<StoredReview[]>;
  addReview(
    id: string,
    input: Omit<StoredReview, 'id' | 'submittedAt'>,
  ): Promise<StoredReview>;
  comments(id: string): Promise<StoredComment[]>;
  addComment(
    id: string,
    input: {
      parentId: string | null;
      body: string;
      anchor: CommentAnchor | null;
      author: PullAuthor;
    },
  ): Promise<StoredComment>;
  editComment(
    id: string,
    commentId: string,
    patch: { body?: string; resolved?: boolean },
    actor: PullAuthor,
  ): Promise<StoredComment>;
  deleteComment(
    id: string,
    commentId: string,
    actor: PullAuthor,
  ): Promise<void>;
  activity(
    id: string,
    cursor: string | null,
  ): Promise<{ events: PullEvent[]; nextCursor: string | null }>;
  recordEvent(
    id: string,
    type: ReportedEvent,
    detail: string | null,
    actor: PullAuthor,
  ): Promise<void>;
  // Idempotent by operation id: a retry after a timeout returns the first result.
  recordMerge(
    id: string,
    input: { operationId: string; mergeCommitOid: string; targetOid: string },
    actor: PullAuthor,
  ): Promise<PullRequest>;
  stats(range: PullStatRange): Promise<Omit<PullStats, 'store'>>;
}

export class PullNotFound extends Error {}

// First day of the month `months - 1` months before now, local time; the oldest month shown.
export function rangeStart(range: PullStatRange, now: number): Date {
  const months = range === '3m' ? 3 : range === '6m' ? 6 : 12;
  const today = new Date(now);
  return new Date(today.getFullYear(), today.getMonth() - (months - 1), 1);
}

export function monthKey(at: number): string {
  const date = new Date(at);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}`;
}

export function emptyMonths(range: PullStatRange, now: number) {
  const start = rangeStart(range, now);
  const months: { month: string; opened: number; merged: number }[] = [];
  for (
    let d = start;
    d.getTime() <= now;
    d = new Date(d.getFullYear(), d.getMonth() + 1, 1)
  )
    months.push({ month: monthKey(d.getTime()), opened: 0, merged: 0 });
  return months;
}

export function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? sorted[mid]!
    : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

export const encodeCursor = (value: unknown) =>
  Buffer.from(JSON.stringify(value)).toString('base64url');
export function decodeCursor<T>(
  cursor: string | null,
  check: (value: unknown) => value is T,
): T | null {
  if (!cursor) return null;
  try {
    const value: unknown = JSON.parse(
      Buffer.from(cursor, 'base64url').toString('utf8'),
    );
    return check(value) ? value : null;
  } catch {
    return null;
  }
}
