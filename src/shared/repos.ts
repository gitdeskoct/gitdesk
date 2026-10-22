import { z } from 'zod';

// The repository contract between main and the renderer. The renderer gets ids and display
// strings only: it never sends a filesystem path, a Git argument or a command.

// Local working-tree and upstream state from `git status --porcelain=v2 --branch`. Local change
// state and synchronization are separate fields on purpose: a clean tree can still be behind.
export type RepoStatus = {
  branch: string | null;
  detached: boolean;
  headOid: string | null;
  upstream: string | null;
  // null when there is no upstream, or the upstream ref is gone.
  ahead: number | null;
  behind: number | null;
  staged: number;
  unstaged: number;
  untracked: number;
  conflicts: number;
  operation: 'merge' | 'rebase' | 'cherry-pick' | 'revert' | null;
  hasRemotes: boolean;
  lastCommit: { oid: string; at: number; subject: string } | null;
};

export type RepoAvailability = 'available' | 'missing' | 'not-a-repo';

export type RepositorySummary = {
  id: string;
  name: string;
  description: string | null;
  // Home-relative where possible (~\Projects\app); for display and nothing else.
  displayPath: string;
  pinned: boolean;
  addedAt: number;
  lastOpenedAt: number | null;
  availability: RepoAvailability;
  // The last successful inspection. A snapshot, never proof of the current state.
  status: RepoStatus | null;
  // When `status` was taken. inspectedAt is the last attempt, which may have failed.
  statusAt: number | null;
  inspectedAt: number | null;
  inspecting: boolean;
  error: string | null;
  remoteId: string | null;
};

export type ChangedFile = {
  path: string;
  kind: 'staged' | 'modified' | 'untracked' | 'conflict';
  // Git's one-letter status for this side: M, A, D, R, C, T, ? or U.
  code: string;
};

export type RepositoryChanges = { files: ChangedFile[]; truncated: boolean };

export type LocalActivity = {
  id: number;
  repositoryId: string;
  repositoryName: string;
  type: 'added' | 'created' | 'opened' | 'commit' | 'checkout' | 'cloned';
  at: number;
  detail: string | null;
};

export type AddRepositoryResult =
  | { status: 'canceled' }
  | { status: 'added' | 'exists'; repository: RepositorySummary }
  // A one-time token for the chosen folder, so initializing it later never takes a path from the renderer.
  | { status: 'not-a-repository'; displayPath: string; token: string };

// Mirrors `git check-ref-format`-safe folder names; also blocks Windows reserved names.
export const repositoryNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(100, 'Keep the name under 100 characters.')
  .regex(
    /^[A-Za-z0-9._-]+$/,
    'Use letters, numbers, dots, dashes and underscores.',
  )
  .refine((name) => !/^\.+$/.test(name) && !name.startsWith('.'), {
    message: "The name can't start with a dot.",
  })
  .refine((name) => !/\.(git|lock)$/i.test(name), {
    message: "The name can't end in .git or .lock.",
  })
  .refine((name) => !/^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i.test(name), {
    message: 'Windows reserves that name. Pick another.',
  });

export const descriptionSchema = z
  .string()
  .trim()
  .max(280, 'Keep the description under 280 characters.')
  .regex(/^[^\r\n\0]*$/, 'Use a single line.');

export const repoIdSchema = z.uuid();
const tokenSchema = z.string().regex(/^[A-Za-z0-9_-]{20,64}$/);

export const createRepositoryInputSchema = z.object({
  name: repositoryNameSchema,
  description: descriptionSchema.optional(),
  locationToken: tokenSchema,
  readme: z.boolean(),
  remote: z.boolean(),
  // Lets the panel follow this create's steps on the progress channel.
  jobId: z.uuid().optional(),
});
export type CreateRepositoryInput = z.infer<typeof createRepositoryInputSchema>;

// The order create works through; a step that doesn't apply (no README, no remote) is skipped.
export const CREATE_STEPS = [
  'folder',
  'init',
  'readme',
  'register',
  'remote',
] as const;
export type CreateStep = (typeof CREATE_STEPS)[number];

export type CreateRepositoryResult = {
  repository: RepositorySummary;
  // The local repository always exists by the time this returns; the remote step is reported apart.
  remote:
    | { status: 'skipped' }
    | { status: 'created'; remote: RemoteRepository }
    | { status: 'failed'; message: string };
  // A README the identity could not commit is left in place, uncommitted.
  readmeCommitted: boolean | null;
  // Measured, not estimated: the whole create, and the server round trip for the remote step.
  timing: { totalMs: number; remoteMs: number | null };
};

// Cloning from your account needs the sync transport (Git objects in R2 behind a Git-compatible
// endpoint). Until that ships, the clone flow runs up to its final step and says why it stops.
export const SYNC_TRANSPORT_READY = false;

export const cloneInputSchema = z.object({
  jobId: z.uuid(),
  remoteId: z.uuid(),
  name: repositoryNameSchema,
  locationToken: tokenSchema,
});
export type CloneInput = z.infer<typeof cloneInputSchema>;
export type CloneResult =
  | { status: 'unavailable' }
  | { status: 'cloned'; repository: RepositorySummary };
// Progress of one long job (a clone or a create), pushed from main as it happens.
// receivedBytes and bytesPerSecond come from Git's own transfer line, so they are null until
// Git reports them and stay null for work that moves no data over the network.
export type ProgressEvent = {
  jobId: string;
  stage: string;
  percent: number;
  receivedBytes: number | null;
  bytesPerSecond: number | null;
};

export const pinInputSchema = z.object({
  id: repoIdSchema,
  pinned: z.boolean(),
});
export const initializeInputSchema = z.object({ token: tokenSchema });
export const refreshInputSchema = repoIdSchema.nullable();

// Remote metadata from the Worker. Treated as untrusted input and validated on arrival.
export const remoteRepositorySchema = z.object({
  id: z.string().min(1).max(64),
  // Lenient on purpose: one legacy name must not fail a whole list. The clone step checks the
  // folder name with repositoryNameSchema before anything is written.
  name: z.string().min(1).max(100),
  description: z.string().max(280).nullable(),
  visibility: z.enum(['private']),
  defaultBranch: z.string().max(100),
  createdAt: z.number(),
  updatedAt: z.number(),
});
export type RemoteRepository = z.infer<typeof remoteRepositorySchema>;

// Events the Worker records for the account. repositoryId is null once the repository is deleted.
export const remoteActivitySchema = z.object({
  id: z.string().min(1).max(64),
  type: z.enum([
    'repository.created',
    'repository.updated',
    'repository.deleted',
  ]),
  repositoryId: z.string().max(64).nullable(),
  repositoryName: z.string().min(1).max(100),
  createdAt: z.number(),
});
export type RemoteActivity = z.infer<typeof remoteActivitySchema>;

export type RemotePage = {
  repositories: RemoteRepository[];
  nextCursor: string | null;
};

export const remoteListInputSchema = z.object({
  sort: z.enum(['updated', 'name']),
  cursor: z
    .string()
    .regex(/^[A-Za-z0-9_-]{1,400}$/)
    .nullable(),
});
export type RemoteListInput = z.infer<typeof remoteListInputSchema>;

export const remoteUpdateInputSchema = z
  .object({
    id: z.uuid(),
    name: repositoryNameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (input) => input.name !== undefined || input.description !== undefined,
    {
      message: 'Change the name or the description.',
    },
  );
export type RemoteUpdateInput = z.infer<typeof remoteUpdateInputSchema>;

export type RemoteOverview = {
  // signed-out: no account. live: fetched this session. cached: last known, with fetchedAt.
  // never: signed in, nothing fetched yet (manual refresh mode or still loading).
  state: 'signed-out' | 'live' | 'cached' | 'never';
  total: number | null;
  recent: RemoteRepository[];
  activity: RemoteActivity[];
  fetchedAt: number | null;
  // Why the last attempt failed, if it did. The cached data stays visible.
  error: 'offline' | 'rate-limited' | 'failed' | null;
  // Manual refreshes are spaced out; until this time a refresh returns the cache.
  nextRefreshAt: number | null;
  requestsToday: number;
};

export const remoteOverviewInputSchema = z.object({ force: z.boolean() });

export const REPOS_IPC = {
  list: 'repos:list',
  add: 'repos:add',
  initialize: 'repos:initialize',
  locate: 'repos:locate',
  refresh: 'repos:refresh',
  open: 'repos:open',
  pin: 'repos:pin',
  remove: 'repos:remove',
  forgetAll: 'repos:forget-all',
  reveal: 'repos:reveal',
  copyPath: 'repos:copy-path',
  changes: 'repos:changes',
  chooseLocation: 'repos:choose-location',
  create: 'repos:create',
  linkRemote: 'repos:link-remote',
  activity: 'repos:activity',
  clearActivity: 'repos:clear-activity',
  changed: 'repos:changed',
  clone: 'repos:clone',
  cloneCancel: 'repos:clone-cancel',
  progress: 'repos:progress',
  remoteOverview: 'remote:overview',
  remoteList: 'remote:list',
  remoteUpdate: 'remote:update',
  remoteDelete: 'remote:delete',
} as const;

export interface ReposApi {
  list(): Promise<RepositorySummary[]>;
  add(): Promise<AddRepositoryResult>;
  initialize(token: string): Promise<RepositorySummary>;
  locate(id: string): Promise<RepositorySummary | null>;
  refresh(id: string | null): Promise<void>;
  open(id: string): Promise<RepositorySummary>;
  pin(id: string, pinned: boolean): Promise<RepositorySummary>;
  remove(id: string): Promise<void>;
  forgetAll(): Promise<void>;
  reveal(id: string): Promise<void>;
  copyPath(id: string): Promise<void>;
  changes(id: string): Promise<RepositoryChanges>;
  chooseLocation(): Promise<{ token: string; displayPath: string } | null>;
  create(input: CreateRepositoryInput): Promise<CreateRepositoryResult>;
  linkRemote(id: string): Promise<RemoteRepository>;
  activity(): Promise<LocalActivity[]>;
  // Empties this computer's activity list; repositories and their history are not touched.
  clearActivity(): Promise<void>;
  remoteOverview(force: boolean): Promise<RemoteOverview>;
  remoteList(input: RemoteListInput): Promise<RemotePage>;
  remoteUpdate(input: RemoteUpdateInput): Promise<RemoteRepository>;
  // Deletes the remote for good; local repositories linked to it are unlinked, never deleted.
  remoteDelete(id: string): Promise<void>;
  clone(input: CloneInput): Promise<CloneResult>;
  cancelClone(jobId: string): Promise<void>;
  onProgress(callback: (event: ProgressEvent) => void): () => void;
  onChanged(callback: (repositories: RepositorySummary[]) => void): () => void;
}
