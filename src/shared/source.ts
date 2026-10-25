import { z } from 'zod';
import type { FileIcon } from './file-types';
import { repoIdSchema } from './repos';
import { branchNameSchema, oidSchema } from './workspace';

// The Files tab contract. Paths are repository-relative with forward slashes. Main still checks
// every path against the registered root on disk, so these schemas are the first gate, not the only one.
const MiB = 1024 * 1024;

const pathSegmentOk = (segment: string): boolean =>
  segment !== '' &&
  segment !== '.' &&
  segment !== '..' &&
  // Windows drops trailing dots and spaces, so ".git. " would open .git.
  segment.replace(/[. ]+$/, '').toLowerCase() !== '.git';

export const sourcePathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      !p.includes('\0') &&
      !p.includes('\\') &&
      !/^([A-Za-z]:|\/)/.test(p) &&
      p.split('/').every(pathSegmentOk),
    { message: 'Not a repository path.' },
  );
// '' is the repository root.
export const sourceDirSchema = z.union([z.literal(''), sourcePathSchema]);

export const sourceSnapshotSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('worktree') }).strict(),
  z.object({ kind: z.literal('index') }).strict(),
  z.object({ kind: z.literal('commit'), oid: oidSchema }).strict(),
]);
export type SourceSnapshot = z.infer<typeof sourceSnapshotSchema>;

// A branch name, HEAD, or a full object id. Resolved once to an oid that every later call uses.
export const sourceRefSchema = z.union([
  oidSchema,
  z.literal('HEAD'),
  branchNameSchema,
]);

// shortcut: limits picked without benchmarking; tune them on modest hardware once people use it.
export const SOURCE_LIMITS = {
  maxText: 5 * MiB,
  maxImage: 5 * MiB,
  remoteImage: 1 * MiB,
  page: 2000,
  remotePage: 500,
  pathMatches: 200,
  recentFiles: 10,
} as const;
export const INLINE_LIMITS_MIB = [1, 2, 5] as const;
export type InlineLimitMiB = (typeof INLINE_LIMITS_MIB)[number];
export const mib = (value: number): number => value * MiB;

export type SourceEntryType = 'file' | 'dir' | 'symlink' | 'submodule';
export type SourceStatus = {
  // The letters Changes shows: M, A, D, R, C, T, U, ?.
  code: string;
  kind: 'staged' | 'modified' | 'untracked' | 'conflict';
  staged: boolean;
  unstaged: boolean;
};
export type SourceEntry = {
  name: string;
  path: string;
  type: SourceEntryType;
  size: number | null;
  oid: string | null;
  status: SourceStatus | null;
  ignored: boolean;
  // A folder with a changed path somewhere below it.
  changes: boolean;
};

export const sourceListInputSchema = z
  .object({
    id: repoIdSchema,
    snapshot: sourceSnapshotSchema,
    path: sourceDirSchema,
    offset: z.number().int().min(0).max(10_000_000),
    showIgnored: z.boolean(),
    showHidden: z.boolean(),
    foldersFirst: z.boolean(),
  })
  .strict();
export type SourceListInput = z.infer<typeof sourceListInputSchema>;
export type SourceListResult = {
  entries: SourceEntry[];
  total: number;
  nextOffset: number | null;
};

export type SourceFile =
  | {
      kind: 'text';
      text: string;
      size: number;
      oid: string | null;
      eol: 'lf' | 'crlf' | 'mixed' | 'none';
    }
  | { kind: 'image'; dataUrl: string; mime: string; size: number }
  | { kind: 'binary'; size: number; reason: 'binary' | 'encoding' }
  // size is null when the server stopped reading before it knew.
  | { kind: 'too-large'; size: number | null; limit: number; canForce: boolean }
  | { kind: 'symlink'; target: string }
  | { kind: 'submodule'; oid: string | null }
  | { kind: 'missing' };

export const sourceReadInputSchema = z
  .object({
    id: repoIdSchema,
    snapshot: sourceSnapshotSchema,
    path: sourcePathSchema,
    limitMiB: z.union([z.literal(1), z.literal(2), z.literal(5)]),
    // Past the inline limit, on an explicit "Show anyway". Never past maxText.
    force: z.boolean(),
  })
  .strict();
export type SourceReadInput = z.infer<typeof sourceReadInputSchema>;

export const sourceResolveInputSchema = z
  .object({ id: repoIdSchema, ref: sourceRefSchema })
  .strict();

export const sourcePathsInputSchema = z
  .object({
    id: repoIdSchema,
    query: z
      .string()
      .min(1)
      .max(200)
      .regex(/^[^\0]*$/),
  })
  .strict();
export type SourcePathsResult = {
  matches: string[];
  total: number;
  // The listing stopped at its cap, so some paths were never searched.
  truncated: boolean;
};

export const sourceFileInputSchema = z
  .object({
    id: repoIdSchema,
    snapshot: sourceSnapshotSchema,
    path: sourcePathSchema,
  })
  .strict();

export const sourceRevealInputSchema = z
  .object({ id: repoIdSchema, path: sourceDirSchema })
  .strict();

export type SourceLastChange = {
  oid: string;
  author: string;
  at: number;
  subject: string;
} | null;

export type SourceStats = {
  files: number;
  dirs: number;
  changed: number;
  // File counts by language label, largest first; the rest is folded into "Other".
  groups: { label: string; count: number; icon: FileIcon }[];
  truncated: boolean;
  countedAt: number;
};

// Remote, from the gitdesk Worker. Every call after the first names the commit it resolved.
// Expected failures come back as a problem the screen explains, not as an error string.
export type RemoteProblem =
  | 'signed-out'
  | 'local-only'
  | 'hosting-off'
  | 'not-found'
  | 'not-ready'
  | 'ref-gone'
  | 'path-gone'
  | 'offline'
  | 'rate-limited'
  | 'failed';
export type Remote<T> =
  | ({ ok: true } & T)
  | { ok: false; problem: RemoteProblem };

export type RemoteSourceBranches = Remote<{
  defaultBranch: string;
  branches: { name: string; oid: string }[];
}>;
const remoteCursorSchema = z
  .string()
  .regex(/^[A-Za-z0-9_-]{1,600}$/)
  .nullable();
export const remoteSourceListInputSchema = z
  .object({
    id: repoIdSchema,
    ref: sourceRefSchema,
    path: sourceDirSchema,
    cursor: remoteCursorSchema,
  })
  .strict();
export type RemoteSourceListResult = Remote<{
  commit: string;
  entries: SourceEntry[];
  nextCursor: string | null;
}>;
export const remoteSourceReadInputSchema = z
  .object({
    id: repoIdSchema,
    oid: oidSchema,
    path: sourcePathSchema,
    limitMiB: z.union([z.literal(1), z.literal(2), z.literal(5)]),
    force: z.boolean(),
  })
  .strict();
export type RemoteSourceFile = Remote<{ file: SourceFile }>;
export const remoteSourceSaveInputSchema = z
  .object({ id: repoIdSchema, oid: oidSchema, path: sourcePathSchema })
  .strict();
export type RemoteSaveResult = Remote<{
  outcome: 'saved' | 'cancelled' | 'too-large';
}>;

export type SourceChange = { id: string; dirs: string[] | null };

export const SOURCE_IPC = {
  list: 'source:list',
  read: 'source:read',
  resolve: 'source:resolve',
  paths: 'source:paths',
  lastChange: 'source:last-change',
  reveal: 'source:reveal',
  stats: 'source:stats',
  remoteBranches: 'source:remote-branches',
  remoteList: 'source:remote-list',
  remoteRead: 'source:remote-read',
  remoteSave: 'source:remote-save',
  // Pushed from main when watched folders change.
  changed: 'source:changed',
} as const;

export interface SourceApi {
  list(input: SourceListInput): Promise<SourceListResult>;
  read(input: SourceReadInput): Promise<SourceFile>;
  resolve(
    input: z.infer<typeof sourceResolveInputSchema>,
  ): Promise<{ oid: string }>;
  paths(
    input: z.infer<typeof sourcePathsInputSchema>,
  ): Promise<SourcePathsResult>;
  lastChange(
    input: z.infer<typeof sourceFileInputSchema>,
  ): Promise<SourceLastChange>;
  // Selects the file or folder in the system file manager. Nothing is opened or run.
  reveal(input: z.infer<typeof sourceRevealInputSchema>): Promise<void>;
  stats(id: string): Promise<SourceStats>;
  remoteBranches(id: string): Promise<RemoteSourceBranches>;
  remoteList(
    input: z.infer<typeof remoteSourceListInputSchema>,
  ): Promise<RemoteSourceListResult>;
  remoteRead(
    input: z.infer<typeof remoteSourceReadInputSchema>,
  ): Promise<RemoteSourceFile>;
  // Asks where to save with the system dialog in main; the renderer never names a path.
  remoteSave(
    input: z.infer<typeof remoteSourceSaveInputSchema>,
  ): Promise<RemoteSaveResult>;
  onChanged(callback: (change: SourceChange) => void): () => void;
}
