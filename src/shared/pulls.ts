import { z } from 'zod';
import { repoIdSchema } from './repos';
import {
  branchNameSchema,
  oidSchema,
  repoPathSchema,
  type CommitRow,
  type DiffResult,
} from './workspace';

// Pull requests: review records live in local SQLite ("local", for repositories not linked to the
// account) or in D1 through the Worker ("account"). Git computes every comparison, check, merge
// and revert on this computer; the records only describe the review.

export const PULL_STATUSES = ['open', 'closed', 'merged'] as const;
export type PullStatus = (typeof PULL_STATUSES)[number];

export const REVIEW_DECISIONS = [
  'approved',
  'changes_requested',
  'commented',
] as const;
export type ReviewDecision = (typeof REVIEW_DECISIONS)[number];

export type Mergeability =
  | 'unknown'
  | 'mergeable'
  | 'conflicts'
  | 'needs_refresh'
  | 'unavailable';
export type MergeabilityReason =
  | 'source-missing'
  | 'target-missing'
  | 'unrelated'
  | 'git-too-old'
  | 'failed';

// Who did something in gitdesk: the signed-in account, or this computer's Git name when local.
export type PullAuthor = {
  accountId: string | null;
  name: string;
  avatarUrl: string | null;
};

// The exact commits a review, a comment or a check refers to. A new version starts only when the
// source or the target commit changes.
export type PullSnapshot = {
  version: number;
  sourceOid: string;
  targetOid: string;
  mergeBaseOid: string | null;
  mergeability: Mergeability;
  reason: MergeabilityReason | null;
  conflicts: string[];
  checkedAt: number | null;
};

export type PullRequest = {
  id: string;
  number: number;
  store: 'local' | 'account';
  repositoryId: string;
  title: string;
  description: string;
  sourceRef: string;
  targetRef: string;
  status: PullStatus;
  isDraft: boolean;
  author: PullAuthor;
  createdAt: number;
  updatedAt: number;
  closedAt: number | null;
  mergedAt: number | null;
  mergeCommitOid: string | null;
  latest: PullSnapshot | null;
  comments: number;
  unresolved: number;
  // The newest decision, and whether it was made on an older snapshot than the latest.
  review: { decision: ReviewDecision; version: number; stale: boolean } | null;
};

export const pullRefSchema = z
  .object({ repoId: repoIdSchema, id: z.uuid() })
  .strict();
export type PullRef = z.infer<typeof pullRefSchema>;

const cursorSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,400}$/)
  .nullable();

export const pullListInputSchema = z
  .object({
    repoId: repoIdSchema,
    status: z.enum(PULL_STATUSES),
    q: z.string().trim().max(100),
    cursor: cursorSchema,
  })
  .strict();
export type PullListInput = z.infer<typeof pullListInputSchema>;
export const PULL_PAGE = 25;
export type PullCounts = Record<PullStatus, number>;
export type PullPage = {
  store: 'local' | 'account';
  pulls: PullRequest[];
  nextCursor: string | null;
  counts: PullCounts;
};

export type PullFile = {
  path: string;
  oldPath: string | null;
  status: 'added' | 'modified' | 'deleted' | 'renamed' | 'copied' | 'type';
  added: number | null;
  removed: number | null;
  binary: boolean;
};

// What the source adds to the target since they split: `git log target..source` and the diff
// from the merge base to the source.
export type Comparison = {
  sourceOid: string;
  targetOid: string;
  mergeBaseOid: string;
  commits: CommitRow[];
  commitsTruncated: boolean;
  files: PullFile[];
  filesTruncated: boolean;
  added: number;
  removed: number;
};

export type CompareProblem =
  | 'same-branch'
  | 'source-missing'
  | 'target-missing'
  | 'unrelated'
  | 'nothing-to-merge';

export const compareInputSchema = z
  .object({
    repoId: repoIdSchema,
    source: branchNameSchema,
    target: branchNameSchema,
  })
  .strict();
export type ComparePreview =
  | { status: 'ok'; comparison: Comparison }
  | { status: 'problem'; problem: CompareProblem };

export const pullTitleSchema = z
  .string()
  .trim()
  .min(1, 'Write a title.')
  .max(200)
  .regex(/^[^\r\n\0]*$/, 'Keep the title to one line.');
export const pullDescriptionSchema = z
  .string()
  .max(20_000)
  .regex(/^[^\0]*$/);

export const createPullInputSchema = z
  .object({
    repoId: repoIdSchema,
    title: pullTitleSchema,
    description: pullDescriptionSchema,
    source: branchNameSchema,
    target: branchNameSchema,
    draft: z.boolean(),
    // A retried create returns the first result instead of a second pull request.
    key: z.uuid(),
  })
  .strict();
export type CreatePullInput = z.infer<typeof createPullInputSchema>;

export const updatePullInputSchema = z
  .object({
    repoId: repoIdSchema,
    id: z.uuid(),
    title: pullTitleSchema.optional(),
    description: pullDescriptionSchema.optional(),
    draft: z.boolean().optional(),
  })
  .strict();
export type UpdatePullInput = z.infer<typeof updatePullInputSchema>;

export const pullStatusInputSchema = z
  .object({
    repoId: repoIdSchema,
    id: z.uuid(),
    status: z.enum(['open', 'closed']),
  })
  .strict();

// The live state of a pull request: its record, and Git's comparison right now.
export type PullDetail = {
  pull: PullRequest;
  comparison: Comparison | null;
  problem: CompareProblem | null;
  // Snapshot versions the source moved through since the latest review, for "changes since".
  changedSinceReview: boolean;
  mergeOperation: MergeOperation | null;
};

export const pullFileDiffInputSchema = z
  .object({
    repoId: repoIdSchema,
    id: z.uuid(),
    path: repoPathSchema,
    oldPath: repoPathSchema.nullable(),
    base: oidSchema,
    source: oidSchema,
    context: z.number().int().min(0).max(1_000_000),
    ignoreWhitespace: z.boolean(),
    full: z.boolean(),
  })
  .strict();
export type PullFileDiffInput = z.infer<typeof pullFileDiffInputSchema>;
export type PullFileDiff = DiffResult;

export type CommentAnchor = {
  comparisonVersion: number;
  sourceOid: string;
  targetOid: string;
  path: string;
  side: 'old' | 'new';
  oldLine: number | null;
  newLine: number | null;
  // sha1 of the line's text, so a moved line can be found again.
  contextHash: string;
};

export type PullComment = {
  id: string;
  parentId: string | null;
  author: PullAuthor;
  body: string;
  createdAt: number;
  updatedAt: number;
  deleted: boolean;
  resolved: boolean;
  anchor: CommentAnchor | null;
  // Where the anchor sits in the latest comparison, or null when it can't be found (outdated).
  position: { path: string; side: 'old' | 'new'; line: number } | null;
  outdated: boolean;
  mine: boolean;
};

export const commentBodySchema = z
  .string()
  .trim()
  .min(1, 'Write a comment.')
  .max(10_000)
  .regex(/^[^\0]*$/);

export const addCommentInputSchema = z
  .object({
    repoId: repoIdSchema,
    id: z.uuid(),
    body: commentBodySchema,
    parentId: z.uuid().nullable(),
    // A line in the latest comparison; main reads its text to make the anchor.
    line: z
      .object({
        path: repoPathSchema,
        side: z.enum(['old', 'new']),
        line: z.number().int().min(1).max(10_000_000),
      })
      .nullable(),
  })
  .strict();
export type AddCommentInput = z.infer<typeof addCommentInputSchema>;

export const editCommentInputSchema = z
  .object({
    repoId: repoIdSchema,
    id: z.uuid(),
    commentId: z.uuid(),
    body: commentBodySchema.optional(),
    resolved: z.boolean().optional(),
  })
  .strict()
  .refine((input) => input.body !== undefined || input.resolved !== undefined);
export const commentRefSchema = z
  .object({ repoId: repoIdSchema, id: z.uuid(), commentId: z.uuid() })
  .strict();

export type PullReview = {
  id: string;
  decision: ReviewDecision;
  body: string;
  version: number;
  sourceOid: string;
  targetOid: string;
  author: PullAuthor;
  submittedAt: number;
  stale: boolean;
};

export const submitReviewInputSchema = z
  .object({
    repoId: repoIdSchema,
    id: z.uuid(),
    decision: z.enum(REVIEW_DECISIONS),
    body: z
      .string()
      .trim()
      .max(10_000)
      .regex(/^[^\0]*$/),
    // The snapshot the reviewer looked at; refused when the comparison moved on since.
    version: z.number().int().min(1),
  })
  .strict();
export type SubmitReviewInput = z.infer<typeof submitReviewInputSchema>;

export const PULL_EVENTS = [
  'created',
  'edited',
  'closed',
  'reopened',
  'comparison_updated',
  'mergeability_checked',
  'reviewed',
  'commented',
  'merge_started',
  'merge_conflicts',
  'merge_aborted',
  'merge_failed',
  'merged',
  'pushed',
  'reverted',
  'branch_deleted',
] as const;
export type PullEventType = (typeof PULL_EVENTS)[number];
export type PullEvent = {
  id: string;
  type: PullEventType;
  actor: PullAuthor;
  detail: string | null;
  createdAt: number;
};
export const activityInputSchema = z
  .object({ repoId: repoIdSchema, id: z.uuid(), cursor: cursorSchema })
  .strict();
export type PullActivityPage = {
  events: PullEvent[];
  nextCursor: string | null;
};

export const viewedInputSchema = z
  .object({
    repoId: repoIdSchema,
    id: z.uuid(),
    version: z.number().int().min(1),
    path: repoPathSchema,
    viewed: z.boolean(),
  })
  .strict();

export const MERGE_STRATEGIES = ['default', 'no-ff'] as const;
export type MergeStrategy = (typeof MERGE_STRATEGIES)[number];
export const mergeInputSchema = z
  .object({
    repoId: repoIdSchema,
    id: z.uuid(),
    strategy: z.enum(MERGE_STRATEGIES),
    push: z.boolean(),
    // The commits the person reviewed and confirmed; a merge of anything newer is refused.
    sourceOid: oidSchema,
    targetOid: oidSchema,
    jobId: z.uuid(),
  })
  .strict();
export type MergeInput = z.infer<typeof mergeInputSchema>;

// prepared → merging → conflict_resolution | locally_merged → push_pending | report_pending → completed
export type MergeOperationState =
  | 'merging'
  | 'conflict_resolution'
  | 'locally_merged'
  | 'push_pending'
  | 'report_pending'
  | 'completed'
  | 'failed';
export type MergeOperation = {
  id: string;
  // null for a pull of the upstream or a branch merge, which share the conflict screen.
  pullId: string | null;
  kind: 'merge' | 'revert' | 'pull' | 'branch-merge';
  state: MergeOperationState;
  strategy: MergeStrategy | 'ff-only' | null;
  sourceOid: string;
  targetOid: string;
  resultOid: string | null;
  message: string | null;
  updatedAt: number;
};

export type MergeResult =
  | {
      status: 'merged';
      operation: MergeOperation;
      push: 'pushed' | 'skipped' | 'failed';
      pushMessage: string | null;
      // false when the account couldn't be told yet; it is retried with the same operation id.
      recorded: boolean;
    }
  | { status: 'conflicts'; operation: MergeOperation; files: ConflictFile[] }
  | {
      status: 'blocked';
      reason:
        | 'not-open'
        | 'changed'
        | 'local-changes'
        | 'operation'
        | 'source-missing'
        | 'target-missing'
        | 'target-elsewhere';
      message: string;
      files: string[];
    }
  | { status: 'failed'; message: string };

export type ConflictKind =
  | 'both-modified'
  | 'both-added'
  | 'both-deleted'
  | 'deleted-by-target'
  | 'deleted-by-source'
  | 'added-by-target'
  | 'added-by-source';
export type ConflictFile = {
  path: string;
  kind: ConflictKind;
  binary: boolean;
};
// An operation that stopped on conflicts. cherry-pick and rebase are only ever ones started outside
// gitdesk (a terminal, an editor); gitdesk finishes them with Git's own --continue and --abort.
export type ConflictOperation = 'merge' | 'revert' | 'cherry-pick' | 'rebase';
export type ConflictState = {
  operation: ConflictOperation | null;
  // The pull request gitdesk started this operation for, when it did.
  pullId: string | null;
  // A pull of the upstream: the two sides' names for the screen ("main", "origin/main"). In a
  // rebase the file's conflict markers hold the upstream first and your commit second.
  upstream: { ours: string; theirs: string; rebase: boolean } | null;
  // A merge from the Branches tab: the branch being merged into and the one merged in.
  branchMerge: { target: string; source: string } | null;
  files: ConflictFile[];
  // Paths that were conflicted in this operation and are now staged.
  resolved: string[];
  // An operation gitdesk didn't start: the two sides named from Git's own refs, the commit being
  // picked or reverted, and tracked edits outside the conflict that an abort leaves as they are.
  external: {
    ours: string;
    theirs: string;
    subject: string | null;
    otherChanges: string[];
  } | null;
};
// Git's own --continue for an operation gitdesk didn't start. `remaining` is the next step's
// conflicts when a rebase or a multi-commit pick stops again.
export type ContinueResult = {
  status: 'continued';
  operation: ConflictOperation;
  remaining: number;
};

export const conflictPathInputSchema = z
  .object({ repoId: repoIdSchema, path: repoPathSchema })
  .strict();
export type ConflictSides = {
  path: string;
  binary: boolean;
  tooLarge: boolean;
  base: string | null;
  target: string | null;
  source: string | null;
  // The working-tree file, with markers when Git left them.
  merged: string | null;
  markers: number;
};
export const resolveConflictInputSchema = z
  .object({
    repoId: repoIdSchema,
    path: repoPathSchema,
    take: z.enum(['target', 'source', 'working']),
  })
  .strict();

export type RevertInfo = {
  mergeOid: string;
  isMerge: boolean;
  parents: { oid: string; subject: string }[];
  // For a fast-forward merge: the range that came in, as before..after.
  range: { before: string; after: string } | null;
  files: number;
  added: number;
  removed: number;
};
export const revertInputSchema = z
  .object({
    repoId: repoIdSchema,
    id: z.uuid(),
    // Which parent of a merge commit is the main line; required for merge commits only.
    mainline: z.union([z.literal(1), z.literal(2)]).nullable(),
    // A new branch for the revert, or null to commit it on the target.
    branch: branchNameSchema.nullable(),
  })
  .strict();
export type RevertResult =
  | {
      status: 'reverted';
      oid: string;
      branch: string;
      operation: MergeOperation;
    }
  | { status: 'conflicts'; operation: MergeOperation; files: ConflictFile[] }
  | {
      status: 'blocked';
      reason:
        | 'not-merged'
        | 'local-changes'
        | 'operation'
        | 'mainline'
        | 'exists';
      message: string;
      files: string[];
    }
  | { status: 'failed'; message: string };

export const PULL_STAT_RANGES = ['3m', '6m', '1y'] as const;
export type PullStatRange = (typeof PULL_STAT_RANGES)[number];
export const statsInputSchema = z
  .object({ repoId: repoIdSchema, range: z.enum(PULL_STAT_RANGES) })
  .strict();
export type PullStats = {
  store: 'local' | 'account';
  // One row per month, oldest first, months in local time.
  months: { month: string; opened: number; merged: number }[];
  counts: PullCounts;
  // Median milliseconds from creation to merge, over merged pull requests; null with none.
  medianMergeMs: number | null;
  merges: number;
  openWithConflicts: number;
};

// The sidebar's Pull requests page: open pull requests across every repository.
export type PullOverviewRow = {
  repository: { id: string; name: string };
  pull: PullRequest;
};
export type PullOverview = {
  rows: PullOverviewRow[];
  // Repositories whose account pull requests couldn't be loaded, so the list may be incomplete.
  unavailable: string[];
};

export const PULLS_IPC = {
  list: 'pulls:list',
  overview: 'pulls:overview',
  compare: 'pulls:compare',
  create: 'pulls:create',
  get: 'pulls:get',
  update: 'pulls:update',
  setStatus: 'pulls:set-status',
  fileDiff: 'pulls:file-diff',
  checkMergeability: 'pulls:check-mergeability',
  comments: 'pulls:comments',
  addComment: 'pulls:add-comment',
  editComment: 'pulls:edit-comment',
  deleteComment: 'pulls:delete-comment',
  reviews: 'pulls:reviews',
  submitReview: 'pulls:submit-review',
  activity: 'pulls:activity',
  viewed: 'pulls:viewed',
  setViewed: 'pulls:set-viewed',
  merge: 'pulls:merge',
  conflicts: 'pulls:conflicts',
  conflictSides: 'pulls:conflict-sides',
  resolveConflict: 'pulls:resolve-conflict',
  continueMerge: 'pulls:continue-merge',
  abortMerge: 'pulls:abort-merge',
  revertInfo: 'pulls:revert-info',
  revert: 'pulls:revert',
  deleteBranch: 'pulls:delete-branch',
  stats: 'pulls:stats',
} as const;

export interface PullsApi {
  list(input: PullListInput): Promise<PullPage>;
  overview(): Promise<PullOverview>;
  // Validates the pair and shows what a pull request would contain, before anything is saved.
  compare(input: z.infer<typeof compareInputSchema>): Promise<ComparePreview>;
  create(input: CreatePullInput): Promise<PullRequest>;
  get(input: PullRef): Promise<PullDetail>;
  update(input: UpdatePullInput): Promise<PullRequest>;
  setStatus(input: z.infer<typeof pullStatusInputSchema>): Promise<PullRequest>;
  fileDiff(input: PullFileDiffInput): Promise<PullFileDiff>;
  checkMergeability(input: PullRef): Promise<PullRequest>;
  comments(input: PullRef): Promise<PullComment[]>;
  addComment(input: AddCommentInput): Promise<PullComment>;
  editComment(
    input: z.infer<typeof editCommentInputSchema>,
  ): Promise<PullComment>;
  deleteComment(input: z.infer<typeof commentRefSchema>): Promise<void>;
  reviews(input: PullRef): Promise<PullReview[]>;
  submitReview(input: SubmitReviewInput): Promise<PullReview>;
  activity(
    input: z.infer<typeof activityInputSchema>,
  ): Promise<PullActivityPage>;
  viewed(input: PullRef & { version: number }): Promise<string[]>;
  setViewed(input: z.infer<typeof viewedInputSchema>): Promise<string[]>;
  merge(input: MergeInput): Promise<MergeResult>;
  conflicts(repoId: string): Promise<ConflictState>;
  conflictSides(
    input: z.infer<typeof conflictPathInputSchema>,
  ): Promise<ConflictSides>;
  resolveConflict(
    input: z.infer<typeof resolveConflictInputSchema>,
  ): Promise<ConflictState>;
  continueMerge(
    repoId: string,
  ): Promise<MergeResult | RevertResult | ContinueResult>;
  abortMerge(repoId: string): Promise<ConflictState>;
  revertInfo(input: PullRef): Promise<RevertInfo>;
  revert(input: z.infer<typeof revertInputSchema>): Promise<RevertResult>;
  deleteBranch(
    input: PullRef,
  ): Promise<{ deleted: boolean; message: string | null }>;
  stats(input: z.infer<typeof statsInputSchema>): Promise<PullStats>;
}

export const viewedQuerySchema = pullRefSchema.extend({
  version: z.number().int().min(1),
});
