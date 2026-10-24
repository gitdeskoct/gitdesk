import { z } from 'zod';
import type { Comparison } from './pulls';
import { repoIdSchema } from './repos';
import {
  branchNameSchema,
  repoPathSchema,
  type DiffResult,
  type PushResult,
} from './workspace';

// The sync contract between main and the renderer. Git on this computer decides every state here;
// the account only confirms that a pushed commit reached the server.

// Stable reasons a sync stopped, so the interface can offer the right next step.
export type SyncCode =
  | 'AUTH_EXPIRED'
  | 'ACCESS_DENIED'
  | 'NON_FAST_FORWARD'
  | 'REMOTE_REJECTED'
  | 'REMOTE_UNAVAILABLE'
  | 'REPOSITORY_NOT_FOUND'
  | 'OPERATION_IN_PROGRESS'
  | 'OPERATION_RESULT_UNKNOWN'
  | 'LOCAL_CONFLICT'
  | 'LOCAL_CHANGES'
  | 'DIVERGED'
  | 'STALE_REFERENCE'
  | 'CANCELLED'
  | 'NO_REMOTE'
  | 'NO_UPSTREAM'
  | 'DETACHED'
  | 'FAILED';

// What the next step is, for codes that have one.
export const RECOVERY: Partial<
  Record<SyncCode, 'sign-in' | 'fetch' | 'resolve' | 'retry' | 'check'>
> = {
  AUTH_EXPIRED: 'sign-in',
  NON_FAST_FORWARD: 'fetch',
  STALE_REFERENCE: 'fetch',
  DIVERGED: 'fetch',
  LOCAL_CONFLICT: 'resolve',
  REMOTE_UNAVAILABLE: 'retry',
  OPERATION_RESULT_UNKNOWN: 'check',
};

export type SyncState =
  | 'up-to-date'
  | 'ahead'
  | 'behind'
  | 'diverged'
  | 'no-upstream'
  | 'gone'
  | 'detached'
  | 'no-remote';

// One journaled fetch, pull, push or move. state is the last step it reached; unknown means the
// connection ended after data was sent, so only a check against the remote can settle it.
export type SyncOperationState =
  | 'fetching'
  | 'merging'
  | 'conflict_resolution'
  | 'locally_merged'
  | 'pushing'
  | 'report_pending'
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'unknown';
export type SyncOperation = {
  id: string;
  repositoryId: string;
  repositoryName: string;
  kind: 'fetch' | 'pull' | 'push' | 'move';
  state: SyncOperationState;
  strategy: PullStrategy | null;
  remote: string | null;
  branch: string | null;
  oldOid: string | null;
  newOid: string | null;
  code: SyncCode | null;
  message: string | null;
  // For a push to the account's Git URL: what the server found when it checked.
  server: 'confirmed' | 'unverified' | null;
  at: number;
};

export type SyncOverview = {
  branch: string | null;
  upstream: string | null;
  // The remote the upstream lives on.
  remote: string | null;
  state: SyncState;
  ahead: number | null;
  behind: number | null;
  changed: number;
  // Last successful fetch and push of that remote from gitdesk; fetchedAt falls back to the time
  // any fetch last ran (FETCH_HEAD), which includes a terminal.
  fetchedAt: number | null;
  pushedAt: number | null;
  // The counts come from a fetch over an hour old, or none: they may not match the server.
  stale: boolean;
  // A pull waiting on conflicts, or a push whose result is unknown.
  pending: SyncOperation | null;
  recent: SyncOperation[];
};

export const PULL_STRATEGIES = ['ff-only', 'merge', 'rebase'] as const;
export type PullStrategy = (typeof PULL_STRATEGIES)[number];

export const pullInputSchema = z
  .object({
    id: repoIdSchema,
    jobId: z.uuid(),
    strategy: z.enum(PULL_STRATEGIES),
  })
  .strict();
export type PullResult =
  | {
      status: 'pulled';
      mode: 'fast-forward' | 'merge' | 'rebase' | 'up-to-date';
      branch: string;
      upstream: string;
    }
  | { status: 'conflicts'; files: string[]; upstream: string }
  | {
      status: 'stopped';
      code: SyncCode;
      message: string;
      files: string[];
    };

export const publishInputSchema = z
  .object({
    id: repoIdSchema,
    jobId: z.uuid(),
    remote: z.string().min(1).max(255),
    branch: branchNameSchema,
  })
  .strict();
export const setUpstreamInputSchema = z
  .object({
    id: repoIdSchema,
    remote: z.string().min(1).max(255),
    branch: branchNameSchema,
  })
  .strict();
export const checkPushInputSchema = z
  .object({ id: repoIdSchema, operationId: z.uuid() })
  .strict();

// Settles a push whose result was unknown, from what the remote holds now.
export type CheckResult =
  | { status: 'completed' }
  | { status: 'not-pushed' }
  | { status: 'moved'; remoteOid: string }
  | { status: 'unreachable'; message: string };

// What `ls-remote` says the server holds now, without downloading anything.
export type RemoteCheck =
  | { status: 'same'; oid: string | null }
  | { status: 'moved'; oid: string | null }
  | { status: 'failed'; code: SyncCode; message: string };

export type UpstreamComparison = {
  upstream: string;
  // Commits only here (to push) and only on the upstream (to pull), oldest first, with their files.
  outgoing: Comparison | null;
  incoming: Comparison | null;
};

// One file of the comparison, from the merge base to one side's tip. Main works out the commits.
export const syncFileDiffInputSchema = z
  .object({
    id: repoIdSchema,
    side: z.enum(['outgoing', 'incoming']),
    path: repoPathSchema,
    oldPath: repoPathSchema.nullable(),
    context: z.number().int().min(0).max(1_000_000),
    ignoreWhitespace: z.boolean(),
    full: z.boolean(),
  })
  .strict();

export const SYNC_PAGE = 20;
export const syncActivityInputSchema = z
  .object({
    filter: z.enum(['all', 'failed', 'unconfirmed']),
    offset: z.number().int().min(0).max(100_000),
  })
  .strict();
export type SyncActivityPage = {
  items: SyncOperation[];
  total: number;
  // Pushes per week for the last 8 weeks, oldest first, split by what the server said.
  weeks: { start: number; confirmed: number; other: number }[];
};

// The account's record of pushes to its Git URLs, from every device, as the Worker keeps it.
export type AccountPush = {
  operationId: string;
  repositoryId: string;
  repositoryName: string;
  ref: string;
  oldOid: string | null;
  newOid: string;
  result: 'confirmed' | 'unverified';
  // The branch tip the server saw when the push was reported.
  tip: string | null;
  createdAt: number;
};
export type AccountPushPage = {
  events: AccountPush[];
  nextCursor: string | null;
};
export type AccountPushStats = {
  // UTC weeks, oldest first.
  weeks: { start: number; confirmed: number; unverified: number }[];
};
export const accountActivityInputSchema = z
  .object({
    cursor: z
      .string()
      .regex(/^[A-Za-z0-9_-]{1,300}$/)
      .nullable(),
    result: z.enum(['all', 'unverified']),
  })
  .strict();

export const SYNC_IPC = {
  overview: 'sync:overview',
  compare: 'sync:compare',
  check: 'sync:check',
  pull: 'sync:pull',
  cancel: 'sync:cancel',
  publish: 'sync:publish',
  setUpstream: 'sync:set-upstream',
  checkPush: 'sync:check-push',
  activity: 'sync:activity',
  fileDiff: 'sync:file-diff',
  accountActivity: 'sync:account-activity',
  accountStats: 'sync:account-stats',
} as const;

export interface SyncApi {
  overview(id: string): Promise<SyncOverview>;
  compare(id: string): Promise<UpstreamComparison>;
  check(id: string): Promise<RemoteCheck>;
  pull(input: z.infer<typeof pullInputSchema>): Promise<PullResult>;
  cancel(jobId: string): Promise<void>;
  publish(input: z.infer<typeof publishInputSchema>): Promise<PushResult>;
  setUpstream(input: z.infer<typeof setUpstreamInputSchema>): Promise<void>;
  checkPush(input: z.infer<typeof checkPushInputSchema>): Promise<CheckResult>;
  activity(
    input: z.infer<typeof syncActivityInputSchema>,
  ): Promise<SyncActivityPage>;
  fileDiff(input: z.infer<typeof syncFileDiffInputSchema>): Promise<DiffResult>;
  accountActivity(
    input: z.infer<typeof accountActivityInputSchema>,
  ): Promise<AccountPushPage>;
  accountStats(): Promise<AccountPushStats>;
}
