import { z } from 'zod';

// The repository contract between main and the renderer. The renderer gets ids and display
// strings only: it never sends a filesystem path, a Git argument or a command. The one exception,
// repository-relative paths for diffs and staging, lives in workspace.ts and is checked in main.

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
  // When any fetch last wrote FETCH_HEAD, from this app or a terminal. Missing in older snapshots.
  fetchedAt?: number | null;
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
  // The automatic private remote (Settings › Git hosting) while it isn't made yet. null once it
  // exists, or when nothing is pending.
  autoLink: AutoLinkState | null;
};

// waiting: added while signed out, made right after sign-in. name-taken: the folder name and its
// numbered variants are all used in the account, so the person picks one.
export type AutoLinkState =
  | { state: 'waiting' }
  | { state: 'creating' }
  | { state: 'name-taken'; name: string }
  | { state: 'failed'; message: string };

// Git's unmerged XY pair in words: which side added, changed or deleted the path.
export type ConflictKind =
  | 'both-modified'
  | 'both-added'
  | 'both-deleted'
  | 'added-by-us'
  | 'added-by-them'
  | 'deleted-by-us'
  | 'deleted-by-them';

export type ChangedFile = {
  path: string;
  kind: 'staged' | 'modified' | 'untracked' | 'conflict';
  // Git's one-letter status for this side: M, A, D, R, C, T, ? or U.
  code: string;
  // The path before a rename or copy.
  origPath?: string | null;
  submodule?: boolean;
  // What changed in a submodule: its recorded commit, tracked files inside, untracked files inside.
  submoduleState?: { commit: boolean; tracked: boolean; untracked: boolean };
  conflict?: ConflictKind;
  // File mode change on this side, such as "100644 → 100755".
  modeChange?: string | null;
  // Line counts from this side's own diff; binary files have none.
  added?: number;
  removed?: number;
  binary?: boolean;
};

export type RepositoryChanges = { files: ChangedFile[]; truncated: boolean };

export type LocalActivity = {
  id: number;
  repositoryId: string;
  repositoryName: string;
  type:
    | 'added'
    | 'created'
    | 'opened'
    | 'commit'
    | 'checkout'
    | 'cloned'
    | 'renamed'
    | 'unlinked'
    | 'fetched'
    | 'pushed'
    | 'hosted-remote-added'
    | 'moved'
    | 'move-undone'
    | 'pulled'
    | 'pr-merged'
    | 'pr-reverted'
    | 'branch-created';
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

// A local display name only labels the registration, so folder-style names with spaces are fine.
// A linked repository's name also goes to the remote, which checks it with repositoryNameSchema.
export const displayNameSchema = z
  .string()
  .trim()
  .min(1, 'Enter a name.')
  .max(100, 'Keep the name under 100 characters.')
  .regex(/^[^\p{Cc}]*$/u, 'Use a single line.');

export const repoUpdateInputSchema = z
  .object({
    id: repoIdSchema,
    name: displayNameSchema.optional(),
    description: descriptionSchema.nullable().optional(),
  })
  .strict()
  .refine(
    (input) => input.name !== undefined || input.description !== undefined,
    { message: 'Change the name or the description.' },
  );
export type RepoUpdateInput = z.infer<typeof repoUpdateInputSchema>;

// The typed name is checked again in main against the registration, never trusted as a path.
export const repoTrashInputSchema = z
  .object({ id: repoIdSchema, confirmName: z.string().min(1).max(100) })
  .strict();
export type RepoTrashInput = z.infer<typeof repoTrashInputSchema>;

// Local history numbers for the details page, read from Git on this computer only. Every count is
// for commits reachable from the current branch; branches can share history, so nothing is summed.
export type RepositoryHistory = {
  branch: string | null;
  commitCount: number;
  localBranches: number;
  remoteBranches: number;
  // Commits per week by committer date in local time, oldest first; start is the week's Monday.
  weeks: { start: number; commits: number }[];
  // More commits fell in the window than were read, so the weekly counts are a lower bound.
  weeksTruncated: boolean;
  // Author names come from Git config and are not verified identities.
  recent: {
    oid: string;
    at: number;
    author: string;
    email: string;
    subject: string;
  }[];
};

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

// A hosted Git remote: plain https with no user name, password, query or fragment. A server that
// sends anything else is refused, so gitdesk never adds a URL that carries a secret.
export const gitUrlSchema = z
  .string()
  .max(2048)
  .refine((value) => {
    try {
      const url = new URL(value);
      return (
        url.protocol === 'https:' &&
        !url.username &&
        !url.password &&
        !url.search &&
        !url.hash
      );
    } catch {
      return false;
    }
  });

// Remote metadata from the Worker. Treated as untrusted input and validated on arrival.
export const remoteRepositorySchema = z.object({
  id: z.string().min(1).max(64),
  // Lenient on purpose: one legacy name must not fail a whole list. The clone step checks the
  // folder name with repositoryNameSchema before anything is written.
  name: z.string().min(1).max(100),
  description: z.string().max(280).nullable(),
  visibility: z.enum(['private']),
  defaultBranch: z.string().max(100),
  // provisioning: storage is being set up. failed: setup stopped and can be retried.
  // deleting: deletion started and didn't finish; deleting again resumes it.
  // Workers from before the lifecycle don't send it; their repositories are ready.
  status: z
    .enum(['provisioning', 'ready', 'failed', 'deleting'])
    .default('ready'),
  // Where Git clones and pushes. null while the server has Git hosting off or setup hasn't run.
  gitUrl: gitUrlSchema.nullable().default(null),
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
    'repository.provisioned',
    'repository.provisioning_failed',
    'repository.deletion_failed',
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

// A remote-only repository. The key makes a retried create return the first result.
export const remoteCreateInputSchema = z
  .object({
    name: repositoryNameSchema,
    description: descriptionSchema.nullable(),
    key: z.uuid(),
  })
  .strict();
export type RemoteCreateInput = z.infer<typeof remoteCreateInputSchema>;

// incomplete: the server removed what it could and kept the repository as `deleting` to retry.
export type RemoteDeleteResult =
  | { status: 'deleted' }
  | { status: 'incomplete'; repository: RemoteRepository };

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
  // Whether the server gives linked repositories a Git URL. null until the server has said.
  gitHosting: boolean | null;
};

// added: a new Git remote was written to .git/config. existing: a remote already had the URL.
export type HostedRemoteResult = { name: string; added: boolean };

// different: the folder holds a repository whose first commit isn't this one's. The token names
// the picked folder, so confirming never sends a path from the renderer.
export type LocateResult =
  | { status: 'canceled' }
  | { status: 'located'; repository: RepositorySummary }
  | {
      status: 'different';
      token: string;
      displayPath: string;
      expected: string;
      found: string | null;
    };
export const locateConfirmInputSchema = z
  .object({ id: repoIdSchema, token: tokenSchema })
  .strict();

export const linkNamedInputSchema = z
  .object({ id: repoIdSchema, name: repositoryNameSchema })
  .strict();

// Moving a repository to its gitdesk remote: every branch and tag is copied and checked there
// before any remote in .git/config changes. URLs are redacted for display.
export type MovePreview =
  | {
      status: 'ready';
      remotes: { name: string; url: string }[];
      branches: number;
      tags: number;
    }
  | {
      status: 'refused';
      reason: 'lfs' | 'too-large' | 'operation' | 'not-linked' | 'nothing';
      message: string;
    };
// The latest move that can still be undone.
export type MoveUndo = {
  operationId: string;
  at: number;
  remotes: string[];
} | null;

export const moveInputSchema = z
  .object({ id: repoIdSchema, jobId: z.uuid() })
  .strict();
export type MoveResult =
  | { status: 'moved'; branches: number; tags: number; removed: string[] }
  | {
      status: 'refused';
      reason:
        | 'lfs'
        | 'too-large'
        | 'operation'
        | 'not-linked'
        | 'nothing'
        | 'diverged'
        | 'unverified';
      message: string;
    }
  | {
      status: 'failed';
      reason: 'cancelled' | 'network' | 'auth' | 'failed';
      message: string;
    };

export const remoteOverviewInputSchema = z.object({ force: z.boolean() });

export const REPOS_IPC = {
  list: 'repos:list',
  add: 'repos:add',
  initialize: 'repos:initialize',
  locate: 'repos:locate',
  locateConfirm: 'repos:locate-confirm',
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
  history: 'repos:history',
  update: 'repos:update',
  unlink: 'repos:unlink',
  trash: 'repos:trash',
  remoteCreate: 'remote:create',
  remoteGet: 'remote:get',
  remoteProvision: 'remote:provision',
  remoteActivity: 'remote:activity',
  addHostedRemote: 'repos:add-hosted-remote',
  copyGitCommand: 'repos:copy-git-command',
  revokeGitTokens: 'repos:revoke-git-tokens',
  linkNamed: 'repos:link-named',
  movePreview: 'repos:move-preview',
  move: 'repos:move',
  moveCancel: 'repos:move-cancel',
  moveUndoState: 'repos:move-undo-state',
  undoMove: 'repos:undo-move',
} as const;

export interface ReposApi {
  list(): Promise<RepositorySummary[]>;
  add(): Promise<AddRepositoryResult>;
  initialize(token: string): Promise<RepositorySummary>;
  locate(id: string): Promise<LocateResult>;
  // Uses the folder Locate found anyway, after the person confirmed it is a different repository.
  locateConfirm(
    input: z.infer<typeof locateConfirmInputSchema>,
  ): Promise<RepositorySummary>;
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
  // The automatic remote under a name the person chose after theirs was taken.
  linkNamed(
    input: z.infer<typeof linkNamedInputSchema>,
  ): Promise<RemoteRepository>;
  movePreview(id: string): Promise<MovePreview>;
  move(input: z.infer<typeof moveInputSchema>): Promise<MoveResult>;
  moveCancel(jobId: string): Promise<void>;
  moveUndoState(id: string): Promise<MoveUndo>;
  undoMove(id: string): Promise<void>;
  activity(): Promise<LocalActivity[]>;
  // Empties this computer's activity list; repositories and their history are not touched.
  clearActivity(): Promise<void>;
  remoteOverview(force: boolean): Promise<RemoteOverview>;
  remoteList(input: RemoteListInput): Promise<RemotePage>;
  remoteUpdate(input: RemoteUpdateInput): Promise<RemoteRepository>;
  // Deletes the remote for good; local repositories linked to it are unlinked, never deleted.
  remoteDelete(id: string): Promise<RemoteDeleteResult>;
  // Creates a repository in the account only; nothing is written on this computer.
  remoteCreate(input: RemoteCreateInput): Promise<RemoteRepository>;
  remoteGet(id: string): Promise<RemoteRepository>;
  // Retries storage setup for a repository whose setup failed or stopped.
  remoteProvision(id: string): Promise<RemoteRepository>;
  remoteActivity(id: string): Promise<RemoteActivity[]>;
  // Adds the account's Git URL to this repository's Git remotes, or names the one that has it.
  addHostedRemote(id: string): Promise<HostedRemoteResult>;
  // Copies a push command carrying a token to the clipboard. The token never reaches the renderer.
  copyGitCommand(id: string): Promise<{ expiresAt: number }>;
  // Revokes every token for the linked remote, including commands copied earlier.
  revokeGitTokens(id: string): Promise<{ revoked: number }>;
  history(id: string): Promise<RepositoryHistory>;
  // Renames the registration (and its remote, when linked). The folder keeps its name.
  update(input: RepoUpdateInput): Promise<RepositorySummary>;
  // Forgets the link to the remote. Files, Git config and the remote itself are left as they are.
  unlink(id: string): Promise<RepositorySummary>;
  // Moves the folder to the system trash, then removes the registration. Never a permanent delete.
  trash(input: RepoTrashInput): Promise<void>;
  clone(input: CloneInput): Promise<CloneResult>;
  cancelClone(jobId: string): Promise<void>;
  onProgress(callback: (event: ProgressEvent) => void): () => void;
  onChanged(callback: (repositories: RepositorySummary[]) => void): () => void;
}
