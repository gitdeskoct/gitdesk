import { z } from 'zod';
import { cursor } from '../../lib/cursor';
import { MERGEABILITY, PULL_STATUSES, REVIEW_DECISIONS } from '../../db/schema';

const oid = z.string().regex(/^[0-9a-f]{40,64}$/);

// Git's branch name rules, as far as a name in a request can break them: no leading dash, no "..",
// no control or special characters, no "/" at either end or twice, no ".lock" or "." at the end.
export const branchName = z
  .string()
  .min(1)
  .max(255)
  .regex(/^[A-Za-z0-9._/-]+$/)
  .refine(
    (name) =>
      !name.startsWith('-') &&
      !name.startsWith('/') &&
      !name.endsWith('/') &&
      !name.endsWith('.') &&
      !name.endsWith('.lock') &&
      !name.includes('..') &&
      !name.includes('//') &&
      !name.includes('/.') &&
      !name.startsWith('.'),
  );

const title = z.string().trim().min(1).max(200).regex(/^[^\r\n\0]*$/);
const description = z.string().max(10_000).regex(/^[^\0]*$/);
const body = z.string().trim().min(1).max(10_000).regex(/^[^\0]*$/);
const repoPath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0') && !/^([A-Za-z]:|[\\/])/.test(p) && !p.split(/[\\/]/).includes('..'));

export const repositoryParams = z.object({ repositoryId: z.uuid() });
export const pullParams = z.object({ pullRequestId: z.uuid() });
export const commentParams = z.object({ pullRequestId: z.uuid(), commentId: z.uuid() });

export const listQuery = z.object({
  status: z.enum(PULL_STATUSES).default('open'),
  q: z.string().trim().max(100).default(''),
  limit: z.coerce.number().int().min(1).max(50).default(25),
  cursor: cursor(z.tuple([z.number().int().nonnegative(), z.uuid()])).optional(),
});

export const createBody = z
  .object({ title, description, sourceRef: branchName, targetRef: branchName, isDraft: z.boolean() })
  .strict()
  .refine((input) => input.sourceRef !== input.targetRef);
export const createHeaders = z.object({ 'idempotency-key': z.uuid().optional() });

export const updateBody = z
  .object({ title: title.optional(), description: description.optional(), isDraft: z.boolean().optional() })
  .strict()
  .refine((input) => Object.values(input).some((value) => value !== undefined));

// A client-computed comparison. A changed source or target starts a new snapshot version; a check
// is stored on the version whose commits it ran against.
export const comparisonBody = z
  .object({
    sourceOid: oid,
    targetOid: oid,
    mergeBaseOid: oid.nullable(),
    check: z
      .object({
        mergeability: z.enum(MERGEABILITY),
        reason: z.enum(['source-missing', 'target-missing', 'unrelated', 'git-too-old', 'failed']).nullable(),
        conflicts: z.array(repoPath).max(200),
      })
      .strict()
      .optional(),
  })
  .strict();

export const reviewBody = z
  .object({
    decision: z.enum(REVIEW_DECISIONS),
    body: z.string().trim().max(10_000).regex(/^[^\0]*$/),
    comparisonVersion: z.number().int().min(1),
    sourceOid: oid,
    targetOid: oid,
  })
  .strict();

export const anchorBody = z
  .object({
    comparisonVersion: z.number().int().min(1),
    sourceOid: oid,
    targetOid: oid,
    path: repoPath,
    side: z.enum(['old', 'new']),
    oldLine: z.number().int().min(1).max(10_000_000).nullable(),
    newLine: z.number().int().min(1).max(10_000_000).nullable(),
    contextHash: z.string().regex(/^[0-9a-f]{40}$/),
  })
  .strict()
  .refine((anchor) => (anchor.side === 'new' ? anchor.newLine : anchor.oldLine) !== null);

export const commentBody = z
  .object({ body, parentCommentId: z.uuid().nullable(), anchor: anchorBody.nullable() })
  .strict()
  .refine((input) => !(input.parentCommentId && input.anchor));

export const commentPatch = z
  .object({ body: body.optional(), resolved: z.boolean().optional() })
  .strict()
  .refine((input) => input.body !== undefined || input.resolved !== undefined);

export const activityQuery = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(30),
  cursor: cursor(z.tuple([z.number().int().nonnegative(), z.uuid()])).optional(),
});

// Events only the desktop knows about; the rest are written as side effects of a change here.
export const REPORTED_EVENTS = [
  'merge_started',
  'merge_conflicts',
  'merge_aborted',
  'merge_failed',
  'pushed',
  'reverted',
  'branch_deleted',
] as const;
export const eventBody = z
  .object({ type: z.enum(REPORTED_EVENTS), detail: z.string().max(300).regex(/^[^\0]*$/).nullable() })
  .strict();

export const mergeResultBody = z
  .object({ operationId: z.uuid(), mergeCommitOid: oid, targetOid: oid })
  .strict();

export const statsQuery = z.object({ range: z.enum(['3m', '6m', '1y']).default('6m') });
