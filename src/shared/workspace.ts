import { z } from 'zod';
import { gitDefaultsSchema, gitIdentityInputSchema } from './ipc';
import { repoIdSchema } from './repos';
import { EDITOR_IDS, type EditorId } from './settings';

// The local Git workspace contract. Repository-relative paths are the one place the renderer sends
// a path: main only acts on a path that a fresh `git status` (or the commit it names) reports, so
// a crafted path can't read or touch anything else.
export const repoPathSchema = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    (p) =>
      !p.includes('\0') &&
      !/^([A-Za-z]:|[\\/])/.test(p) &&
      !p.split(/[\\/]/).includes('..'),
    { message: 'Not a repository path.' },
  );

export const oidSchema = z.string().regex(/^[0-9a-f]{40,64}$/);

export const pathsInputSchema = z
  .object({ id: repoIdSchema, paths: z.array(repoPathSchema).min(1).max(1000) })
  .strict();
export type PathsInput = z.infer<typeof pathsInputSchema>;

export const DIFF_SIDES = [
  'unstaged',
  'staged',
  'untracked',
  'conflict',
] as const;
export type DiffSide = (typeof DIFF_SIDES)[number];

export const diffInputSchema = z
  .object({
    id: repoIdSchema,
    path: repoPathSchema,
    side: z.enum(DIFF_SIDES),
    // Lines of context around each change; a large number shows the whole file.
    context: z.number().int().min(0).max(1_000_000),
    ignoreWhitespace: z.boolean(),
    // Past the size guard, on an explicit "Load full diff".
    full: z.boolean(),
  })
  .strict();
export type DiffInput = z.infer<typeof diffInputSchema>;

export type DiffLine = {
  kind: 'context' | 'add' | 'del' | 'conflict';
  old: number | null;
  new: number | null;
  text: string;
};
export type DiffHunk = {
  header: string;
  oldStart: number;
  newStart: number;
  lines: DiffLine[];
};
export type DiffResult =
  | {
      status: 'text';
      path: string;
      oldPath: string | null;
      added: number;
      removed: number;
      hunks: DiffHunk[];
      // More lines than are shown; "Load full diff" asks again with full set.
      truncated: boolean;
      newFile: boolean;
      deleted: boolean;
      modeChange: string | null;
    }
  | { status: 'binary'; path: string; oldPath: string | null }
  | { status: 'too-large'; path: string; added: number; removed: number }
  // No text change to show: only a mode change, or whitespace hidden by the setting.
  | { status: 'empty'; path: string; modeChange: string | null };

export const commitInputSchema = z
  .object({
    id: repoIdSchema,
    summary: z
      .string()
      .trim()
      .min(1, 'Write a summary.')
      .max(500)
      .regex(/^[^\r\n\0]*$/, 'Keep the summary to one line.'),
    description: z
      .string()
      .max(10_000)
      .regex(/^[^\0]*$/),
  })
  .strict();
export type CommitInput = z.infer<typeof commitInputSchema>;
export type CommitResult =
  | { status: 'committed'; oid: string; branch: string | null }
  | {
      status: 'rejected';
      reason:
        | 'hook'
        | 'identity'
        | 'nothing-staged'
        | 'conflicts'
        | 'busy'
        | 'failed';
      // Sanitized Git or hook output, shown inline under the form.
      output: string | null;
    };

export const branchNameSchema = gitDefaultsSchema.shape.defaultBranch;

export type LocalBranch = {
  name: string;
  oid: string;
  upstream: string | null;
  ahead: number | null;
  behind: number | null;
  // The upstream is configured but its remote branch was deleted.
  gone: boolean;
  current: boolean;
  // Checked out in another worktree, so Git refuses to switch to it here.
  otherWorktree: boolean;
  at: number | null;
  subject: string;
};
export type RemoteBranch = {
  name: string;
  remote: string;
  branch: string;
  oid: string;
  at: number | null;
  subject: string;
  hasLocal: boolean;
};
export type BranchList = {
  current: string | null;
  detached: boolean;
  headOid: string | null;
  local: LocalBranch[];
  remote: RemoteBranch[];
  truncated: boolean;
};

export const switchInputSchema = z
  .object({
    id: repoIdSchema,
    // A local branch name, or remote/branch for a remote-tracking branch to check out.
    name: z.string().min(1).max(255),
    kind: z.enum(['local', 'remote']),
  })
  .strict();
export const createBranchInputSchema = z
  .object({ id: repoIdSchema, name: branchNameSchema })
  .strict();
export type SwitchResult =
  | { status: 'switched'; branch: string }
  | { status: 'blocked'; reason: 'local-changes'; files: string[] }
  | {
      status: 'blocked';
      reason: 'other-worktree' | 'operation' | 'exists' | 'not-found';
    };

export const fetchInputSchema = z
  .object({
    id: repoIdSchema,
    remote: z.string().min(1).max(255),
    jobId: z.uuid(),
  })
  .strict();
export type FetchResult =
  | { status: 'fetched'; remote: string; at: number }
  | {
      status: 'failed';
      reason:
        | 'auth'
        | 'not-found'
        | 'network'
        | 'cancelled'
        | 'refused'
        | 'failed';
      message: string;
    };

export const pushInputSchema = z
  .object({ id: repoIdSchema, jobId: z.uuid() })
  .strict();
export type PushResult =
  | { status: 'pushed'; remote: string; branch: string; at: number }
  | {
      status: 'failed';
      reason:
        | Extract<FetchResult, { status: 'failed' }>['reason']
        | 'rejected'
        | 'no-remote'
        | 'detached';
      message: string;
    };

export type RemoteInfo = {
  name: string;
  // Credentials and query strings removed; for display only. The raw URL stays in main.
  fetchUrl: string;
  pushUrl: string | null;
  hadCredentials: boolean;
  protocol: 'https' | 'http' | 'ssh' | 'git' | 'file' | 'other';
};

export const logInputSchema = z
  .object({
    id: repoIdSchema,
    // The head the first page was read from, so later commits never shift the next pages.
    oid: oidSchema.nullable(),
    skip: z.number().int().min(0).max(1_000_000),
  })
  .strict();
export const HISTORY_PAGE = 50;
export type CommitRow = {
  oid: string;
  parents: string[];
  author: string;
  // Git's author email: it lets the app show your own account picture on your commits.
  email: string;
  at: number;
  subject: string;
  refs: string[];
};
export type HistoryPage = {
  snapshot: string | null;
  commits: CommitRow[];
  nextSkip: number | null;
};

export const commitDetailInputSchema = z
  .object({ id: repoIdSchema, oid: oidSchema })
  .strict();
export type CommitDetail = {
  oid: string;
  parents: string[];
  author: string;
  email: string;
  at: number;
  message: string;
  files: {
    path: string;
    oldPath: string | null;
    added: number | null;
    removed: number | null;
  }[];
  filesTruncated: boolean;
};

export const ANALYTICS_RANGES = ['4w', '12w', '6m', '1y'] as const;
export type AnalyticsRange = (typeof ANALYTICS_RANGES)[number];
export const analyticsInputSchema = z
  .object({ id: repoIdSchema, range: z.enum(ANALYTICS_RANGES) })
  .strict();
// Local history only, for commits reachable from the current branch, by commit date in local time.
// Author names come from Git settings and are not verified identities.
export type RepositoryAnalytics = {
  branch: string | null;
  headOid: string | null;
  range: AnalyticsRange;
  since: number;
  totalCommits: number;
  commits: number;
  activeDays: number;
  added: number;
  removed: number;
  filesTouched: number;
  bucket: 'week' | 'month';
  buckets: { start: number; commits: number; added: number; removed: number }[];
  // [weekday Monday..Sunday][hour 0..23]
  heat: number[][];
  topFiles: { path: string; commits: number }[];
  authors: { name: string; email: string; commits: number }[];
  // More commits than were read, so every count is a lower bound.
  truncated: boolean;
  // Files left out of line counts because one change touched too many lines (lockfiles, output).
  skippedLarge: string[];
};

export type DetectedEditor = {
  id: Exclude<EditorId, 'system'>;
  name: string;
  // Where it was found, for display; the launch always uses main's own copy of the path.
  location: string;
};

export const openInEditorInputSchema = z
  .object({
    id: repoIdSchema,
    path: repoPathSchema.nullable(),
    line: z.number().int().min(1).max(10_000_000).nullable(),
  })
  .strict();

export const repoFileInputSchema = z
  .object({ id: repoIdSchema, path: repoPathSchema })
  .strict();

// Git config of one repository (its .git/config) next to the global value it overrides.
export type RepoGitConfig = {
  identity: { name: string | null; email: string | null };
  globalIdentity: { name: string | null; email: string | null };
  prune: boolean | null;
  globalPrune: boolean | null;
  autocrlf: 'true' | 'input' | 'false' | null;
  globalAutocrlf: 'true' | 'input' | 'false' | null;
  // Keys in the repository's own config that make Git run a program, and hooks that exist.
  programs: string[];
  hooks: string[];
  remotes: string[];
};

export const repoConfigInputSchema = z
  .object({
    id: repoIdSchema,
    // null removes the repository's own value so the global one applies again.
    identity: gitIdentityInputSchema.nullable().optional(),
    prune: z.boolean().nullable().optional(),
    autocrlf: gitDefaultsSchema.shape.autocrlf.nullable().optional(),
  })
  .strict();
export type RepoConfigInput = z.infer<typeof repoConfigInputSchema>;

// gitdesk's own per-repository choices. 'global' and null follow the matching app setting.
export type RepoPreferences = {
  layout: 'global' | 'centered' | 'split';
  openOn: 'changes' | 'overview';
  editor: EditorId | null;
  autoFetch: 'global' | 0 | 5 | 15 | 30;
  defaultRemote: string | null;
};
export const DEFAULT_REPO_PREFERENCES: RepoPreferences = {
  layout: 'global',
  openOn: 'changes',
  editor: null,
  autoFetch: 'global',
  defaultRemote: null,
};
export const repoPreferencesInputSchema = z
  .object({
    id: repoIdSchema,
    layout: z.enum(['global', 'centered', 'split']).optional(),
    openOn: z.enum(['changes', 'overview']).optional(),
    editor: z.enum(EDITOR_IDS).nullable().optional(),
    autoFetch: z
      .union([
        z.literal('global'),
        z.literal(0),
        z.literal(5),
        z.literal(15),
        z.literal(30),
      ])
      .optional(),
    defaultRemote: z.string().min(1).max(255).nullable().optional(),
  })
  .strict();
export type RepoPreferencesInput = z.infer<typeof repoPreferencesInputSchema>;

export const repoSizeInputSchema = z
  .object({ id: repoIdSchema, force: z.boolean() })
  .strict();
// Bytes on disk, measured by main. `tracked` is the size of the files in the last commit, so
// `other` (untracked and ignored files, plus unsaved edits) is the rest of the working tree.
export type RepoSize = {
  total: number;
  git: number;
  tracked: number;
  other: number;
  trackedFiles: number;
  workingFiles: number;
  objects: { loose: number; packed: number; packs: number };
  largest: { path: string; bytes: number }[];
  measuredAt: number;
  // The walk stopped at its file or time limit, so the working tree numbers are a lower bound.
  truncated: boolean;
};

export type GitInstall =
  | { available: false; custom: boolean }
  | {
      available: true;
      version: string;
      // Where the Git in use lives; display only.
      location: string | null;
      custom: boolean;
      prune: boolean | null;
      signing: boolean;
      credentialHelper: string | null;
    };

export const WORKSPACE_IPC = {
  diff: 'workspace:diff',
  stage: 'workspace:stage',
  stageAll: 'workspace:stage-all',
  unstage: 'workspace:unstage',
  discard: 'workspace:discard',
  commit: 'workspace:commit',
  branches: 'workspace:branches',
  switchBranch: 'workspace:switch',
  createBranch: 'workspace:create-branch',
  fetch: 'workspace:fetch',
  cancelFetch: 'workspace:fetch-cancel',
  push: 'workspace:push',
  cancelPush: 'workspace:push-cancel',
  remotes: 'workspace:remotes',
  log: 'workspace:log',
  commitDetail: 'workspace:commit-detail',
  analytics: 'workspace:analytics',
  revealFile: 'workspace:reveal-file',
  copyFilePath: 'workspace:copy-file-path',
  watch: 'workspace:watch',
  unwatch: 'workspace:unwatch',
  editors: 'workspace:editors',
  openInEditor: 'workspace:open-in-editor',
  gitConfig: 'workspace:git-config',
  setGitConfig: 'workspace:set-git-config',
  preferences: 'workspace:preferences',
  setPreferences: 'workspace:set-preferences',
  gitInstall: 'workspace:git-install',
  chooseGit: 'workspace:choose-git',
  usePathGit: 'workspace:use-path-git',
  setGlobalPrune: 'workspace:set-global-prune',
  size: 'workspace:size',
} as const;

export interface WorkspaceApi {
  diff(input: DiffInput): Promise<DiffResult>;
  stage(input: PathsInput): Promise<void>;
  // Every eligible change in this repository; ignored files are never staged.
  stageAll(id: string): Promise<void>;
  unstage(input: PathsInput): Promise<void>;
  // Unstaged edits go back to the staged version; untracked files go to the system trash.
  discard(input: PathsInput): Promise<void>;
  // A local commit only. Nothing is pushed.
  commit(input: CommitInput): Promise<CommitResult>;
  branches(id: string): Promise<BranchList>;
  switchBranch(input: z.infer<typeof switchInputSchema>): Promise<SwitchResult>;
  createBranch(
    input: z.infer<typeof createBranchInputSchema>,
  ): Promise<SwitchResult>;
  // Updates remote-tracking branches only; never merges into the current branch.
  fetch(input: z.infer<typeof fetchInputSchema>): Promise<FetchResult>;
  cancelFetch(jobId: string): Promise<void>;
  // Pushes the current branch to its upstream, or sets one on the default remote. Never forces.
  push(input: z.infer<typeof pushInputSchema>): Promise<PushResult>;
  cancelPush(jobId: string): Promise<void>;
  remotes(id: string): Promise<RemoteInfo[]>;
  log(input: z.infer<typeof logInputSchema>): Promise<HistoryPage>;
  commitDetail(
    input: z.infer<typeof commitDetailInputSchema>,
  ): Promise<CommitDetail>;
  analytics(
    input: z.infer<typeof analyticsInputSchema>,
  ): Promise<RepositoryAnalytics>;
  revealFile(input: z.infer<typeof repoFileInputSchema>): Promise<void>;
  copyFilePath(input: z.infer<typeof repoFileInputSchema>): Promise<void>;
  // The open workspace's files are watched so edits from other tools show up on their own.
  watch(id: string): Promise<void>;
  unwatch(id: string): Promise<void>;
  editors(refresh: boolean): Promise<DetectedEditor[]>;
  openInEditor(input: z.infer<typeof openInEditorInputSchema>): Promise<void>;
  gitConfig(id: string): Promise<RepoGitConfig>;
  setGitConfig(input: RepoConfigInput): Promise<RepoGitConfig>;
  preferences(id: string): Promise<RepoPreferences>;
  setPreferences(input: RepoPreferencesInput): Promise<RepoPreferences>;
  gitInstall(): Promise<GitInstall>;
  // Opens a file picker in main; the chosen program must answer as Git before it is used.
  chooseGit(): Promise<GitInstall>;
  usePathGit(): Promise<GitInstall>;
  setGlobalPrune(enabled: boolean): Promise<GitInstall>;
  // Measured again when asked, otherwise answered from a short cache.
  size(input: z.infer<typeof repoSizeInputSchema>): Promise<RepoSize>;
}
