import { z } from 'zod';
import type {
  Comparison,
  CompareProblem,
  ConflictFile,
  Mergeability,
  MergeabilityReason,
  MergeOperation,
} from './pulls';
import { repoIdSchema } from './repos';
import type { SyncCode } from './sync';
import {
  branchNameSchema,
  oidSchema,
  repoPathSchema,
  type BranchList,
  type CommitRow,
  type DiffResult,
  type PushResult,
} from './workspace';

export { isProtected, protectedPatternSchema } from './workspace';

// Branch Management: every local ref, merge and comparison is Git's on this computer. A hosted
// branch is reached only through Git (ls-remote, push); the account just records what Git confirmed.

export const BRANCH_MERGE_METHODS = ['default', 'no-ff', 'ff-only'] as const;
export type BranchMergeMethod = (typeof BRANCH_MERGE_METHODS)[number];
export type AutoMergeability = 'off' | 'compare' | 'list';
// How many unmerged branches the list checks against the compare-against branch.
export const LIST_MERGEABILITY_LIMIT = 20;

// Names already in the repository may use characters gitdesk wouldn't pick for a new one, so
// existing refs are only bounded here and then looked up in Git's own list.
const existingName = z.string().min(1).max(255);

export const branchRefSchema = z
  .object({ kind: z.enum(['local', 'remote']), name: existingName })
  .strict();
export type BranchRef = z.infer<typeof branchRefSchema>;

export type BranchTarget = {
  name: string;
  oid: string;
  // setting: Compare against in the repository's Settings; remote-head: <remote>/HEAD.
  source: 'setting' | 'remote-head' | 'default' | 'current';
};

export type BranchOverview = BranchList & {
  // The branch Merged, Unmerged, the Compare base and the automatic checks use.
  target: BranchTarget | null;
  // Local branches whose tip the target already contains.
  merged: string[];
  // Local branches the repository's Settings protect from rename and delete.
  protected: string[];
};

const startSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('head') }).strict(),
  z.object({ kind: z.literal('local'), name: existingName }).strict(),
  z.object({ kind: z.literal('remote'), name: existingName }).strict(),
  z
    .object({
      kind: z.literal('commit'),
      oid: z.string().regex(/^[0-9a-f]{4,64}$/i, 'Paste a commit hash.'),
    })
    .strict(),
]);
export type BranchStart = z.infer<typeof startSchema>;

export const createBranchInputSchema = z
  .object({
    id: repoIdSchema,
    name: branchNameSchema,
    start: startSchema,
    switchTo: z.boolean(),
    track: z.enum(['git', 'always', 'never']),
  })
  .strict();
export const renameBranchInputSchema = z
  .object({ id: repoIdSchema, from: existingName, to: branchNameSchema })
  .strict();
export const deleteBranchInputSchema = z
  .object({
    id: repoIdSchema,
    name: existingName,
    // Git's -D, only with the name typed out in full.
    force: z.boolean(),
    typedName: z.string().max(255).optional(),
  })
  .strict();
export const setUpstreamInputSchema = z
  .object({
    id: repoIdSchema,
    name: existingName,
    // remote/branch of a remote-tracking branch, or null to stop tracking.
    upstream: existingName.nullable(),
  })
  .strict();
export const pushBranchInputSchema = z
  .object({ id: repoIdSchema, name: existingName, jobId: z.uuid() })
  .strict();
export const deleteRemoteInputSchema = z
  .object({
    id: repoIdSchema,
    remote: existingName,
    branch: existingName,
    // Deleted only while the remote still points here (--force-with-lease).
    expectedOid: oidSchema,
    typedName: z.string().max(255),
    jobId: z.uuid(),
  })
  .strict();
export const checkRemoteInputSchema = z
  .object({ id: repoIdSchema, remote: existingName })
  .strict();
export const compareBranchesInputSchema = z
  .object({ id: repoIdSchema, base: branchRefSchema, source: branchRefSchema })
  .strict();
export const branchFileDiffInputSchema = z
  .object({
    id: repoIdSchema,
    baseOid: oidSchema,
    sourceOid: oidSchema,
    path: repoPathSchema,
    oldPath: repoPathSchema.nullable(),
    context: z.number().int().min(0).max(1_000_000),
    ignoreWhitespace: z.boolean(),
    full: z.boolean(),
  })
  .strict();
export const mergeabilityInputSchema = z
  .object({ id: repoIdSchema, targetOid: oidSchema, sourceOid: oidSchema })
  .strict();
export const listMergeabilityInputSchema = z
  .object({
    id: repoIdSchema,
    targetOid: oidSchema,
    sourceOids: z.array(oidSchema).max(LIST_MERGEABILITY_LIMIT),
  })
  .strict();
export const mergeBranchesInputSchema = z
  .object({
    id: repoIdSchema,
    // The local branch that gets the changes; gitdesk switches to it first.
    target: existingName,
    source: branchRefSchema,
    targetOid: oidSchema,
    sourceOid: oidSchema,
    method: z.enum(BRANCH_MERGE_METHODS),
    push: z.boolean(),
    // Merging into a protected branch asks once more; main checks this, not only the page.
    confirmProtected: z.boolean(),
    jobId: z.uuid(),
  })
  .strict();
export type MergeBranchesInput = z.infer<typeof mergeBranchesInputSchema>;

export type BranchBlock =
  | 'exists'
  | 'not-found'
  | 'current'
  | 'other-worktree'
  | 'protected'
  | 'operation'
  | 'local-changes'
  | 'invalid-name'
  | 'no-commit'
  | 'confirm-name';

export type BranchActionResult =
  | {
      status: 'done';
      branch: string;
      switched: boolean;
      // Rename: the upstream the branch still tracks under its old remote name.
      upstream: string | null;
    }
  | { status: 'blocked'; reason: BranchBlock; message: string; files: string[] }
  // Git kept the branch: these commits are on no upstream and not in HEAD.
  | {
      status: 'not-merged';
      commits: CommitRow[];
      total: number;
      upstream: string | null;
    };

export type DeleteRemoteResult =
  | { status: 'deleted'; remote: string; branch: string; operationId?: string }
  | {
      status: 'failed';
      reason:
        | 'moved'
        | 'not-found'
        | 'protected'
        | 'confirm-name'
        | 'auth'
        | 'network'
        | 'cancelled'
        | 'unknown'
        | 'failed';
      code?: SyncCode;
      message: string;
      operationId?: string;
    };

export type RemoteHeadsCheck =
  | {
      status: 'checked';
      remote: string;
      at: number;
      // Compared with this computer's remote-tracking branches, without downloading anything.
      moved: string[];
      gone: string[];
      added: string[];
    }
  | { status: 'failed'; remote: string; message: string };

export type BranchComparison =
  | {
      status: 'ok';
      base: { name: string; oid: string; kind: BranchRef['kind'] };
      source: { name: string; oid: string; kind: BranchRef['kind'] };
      comparison: Comparison;
      // Commits on the base since the two split, which make a fast-forward impossible.
      behind: number;
      capturedAt: number;
    }
  | {
      status: 'problem';
      problem: CompareProblem | 'same-commit';
      base: string;
      source: string;
    };

export type MergeabilityCheck = {
  targetOid: string;
  sourceOid: string;
  mergeability: Exclude<Mergeability, 'needs_refresh'>;
  reason: MergeabilityReason | null;
  conflicts: string[];
  checkedAt: number;
};

export type BranchMergeResult =
  | {
      status: 'merged';
      operation: MergeOperation;
      fastForward: boolean;
      push: 'pushed' | 'skipped' | 'failed';
      pushMessage: string | null;
    }
  | { status: 'conflicts'; operation: MergeOperation; files: ConflictFile[] }
  | {
      status: 'blocked';
      reason:
        | 'changed'
        | 'local-changes'
        | 'operation'
        | 'source-missing'
        | 'target-missing'
        | 'target-elsewhere'
        | 'protected'
        | 'not-fast-forward'
        | 'same-branch';
      message: string;
      files: string[];
    }
  | { status: 'failed'; message: string };

export const BRANCHES_IPC = {
  overview: 'branches:overview',
  create: 'branches:create',
  rename: 'branches:rename',
  remove: 'branches:delete',
  setUpstream: 'branches:set-upstream',
  push: 'branches:push',
  deleteRemote: 'branches:delete-remote',
  checkRemote: 'branches:check-remote',
  compare: 'branches:compare',
  fileDiff: 'branches:file-diff',
  mergeability: 'branches:mergeability',
  listMergeability: 'branches:list-mergeability',
  merge: 'branches:merge',
} as const;

export interface BranchesApi {
  overview(id: string): Promise<BranchOverview>;
  create(
    input: z.infer<typeof createBranchInputSchema>,
  ): Promise<BranchActionResult>;
  rename(
    input: z.infer<typeof renameBranchInputSchema>,
  ): Promise<BranchActionResult>;
  // Git's safe delete; a branch with unmerged work comes back as not-merged with its commits.
  remove(
    input: z.infer<typeof deleteBranchInputSchema>,
  ): Promise<BranchActionResult>;
  setUpstream(
    input: z.infer<typeof setUpstreamInputSchema>,
  ): Promise<BranchActionResult>;
  push(input: z.infer<typeof pushBranchInputSchema>): Promise<PushResult>;
  deleteRemote(
    input: z.infer<typeof deleteRemoteInputSchema>,
  ): Promise<DeleteRemoteResult>;
  checkRemote(
    input: z.infer<typeof checkRemoteInputSchema>,
  ): Promise<RemoteHeadsCheck>;
  compare(
    input: z.infer<typeof compareBranchesInputSchema>,
  ): Promise<BranchComparison>;
  fileDiff(
    input: z.infer<typeof branchFileDiffInputSchema>,
  ): Promise<DiffResult>;
  mergeability(
    input: z.infer<typeof mergeabilityInputSchema>,
  ): Promise<MergeabilityCheck>;
  listMergeability(
    input: z.infer<typeof listMergeabilityInputSchema>,
  ): Promise<MergeabilityCheck[]>;
  merge(input: MergeBranchesInput): Promise<BranchMergeResult>;
}
