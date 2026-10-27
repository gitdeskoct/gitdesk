import { z } from 'zod';

// Each name is a Shiki light and dark theme pair, resolved in the renderer's highlighter.
export const CODE_THEMES = [
  'github',
  'github-high-contrast',
  'one',
  'catppuccin',
  'solarized',
  'rose-pine',
] as const;
export type CodeTheme = (typeof CODE_THEMES)[number];

export const EDITOR_IDS = [
  'system',
  'vscode',
  'vscode-insiders',
  'vscodium',
  'cursor',
  'windsurf',
  'zed',
  'sublime',
  'notepadpp',
  'webstorm',
  'intellij',
  'intellij-ce',
  'pycharm',
  'pycharm-ce',
  'phpstorm',
  'goland',
  'rider',
  'clion',
  'rubymine',
  'rustrover',
] as const;
export type EditorId = (typeof EDITOR_IDS)[number];

// No `.default()` here: a partial patch must never be filled with defaults and overwrite saved values.
export const settingsSchema = z.object({
  theme: z.enum(['system', 'light', 'dark']),
  accentTone: z.enum(['blue', 'violet', 'green', 'amber', 'rose']),
  fontSize: z.enum(['small', 'default', 'large']),
  fontFamily: z.enum(['inter', 'system']),
  motion: z.enum(['full', 'reduced', 'off']),
  contentWidth: z.enum(['compact', 'default', 'wide']),
  // Chromium zoom level: each step of 0.5 is roughly 10%, so -3..3 is about 50% to 200%.
  zoomLevel: z.number().min(-3).max(3).multipleOf(0.5),
  // More contrast darkens hairlines and secondary text; it never changes the accent.
  contrast: z.enum(['standard', 'more']),
  underlineLinks: z.boolean(),
  // How long a pointer rests before a tooltip opens.
  tooltipDelay: z.enum(['standard', 'instant']),
  sidebarCollapsed: z.boolean(),
  // Pinned, then recently opened repositories under the sidebar's links; 0 hides them.
  sidebarRecent: z.union([z.literal(0), z.literal(5), z.literal(8)]),
  // What the window shows when gitdesk starts: Home, Repositories or the last opened repository.
  startPage: z.enum(['home', 'repositories', 'last']),
  localOnly: z.boolean(),
  // Workspace: how Home is laid out and how often repositories are checked.
  dashboardLayout: z.enum(['auto', 'centered', 'split']),
  dashboardDensity: z.enum(['comfortable', 'compact']),
  // Repositories: one centered column, or the list beside the selected repository. Auto splits on wide windows.
  repositoriesLayout: z.enum(['auto', 'centered', 'split']),
  // The list shows names; branch, state and path open per row, or on every row when expanded.
  repositoriesExpandRows: z.boolean(),
  // The All, Local, Remote and Linked counts with their context, above the list.
  repositoriesShowStats: z.boolean(),
  repositoriesSort: z.enum(['opened', 'name', 'tree', 'sync']),
  watchRepositories: z.boolean(),
  refreshOnFocus: z.boolean(),
  // Minutes between background checks while the window is open; 0 turns them off.
  backgroundRefresh: z.union([
    z.literal(0),
    z.literal(5),
    z.literal(15),
    z.literal(30),
  ]),
  remoteRefresh: z.enum(['auto', 'manual']),
  // Home sections and what Recent activity lists.
  homeShowAttention: z.boolean(),
  homeShowActivity: z.boolean(),
  homePageSize: z.union([z.literal(6), z.literal(10), z.literal(20)]),
  activitySource: z.enum(['both', 'local', 'account']),
  activityIncludeOpens: z.boolean(),
  // System notifications; while gitdesk is in front the same news is an in-app toast.
  notifications: z.boolean(),
  notifyClone: z.boolean(),
  notifyProblems: z.boolean(),
  notifyOnlyInBackground: z.boolean(),
  // Settings › Updates: check GitHub for a new version at start and every 6 hours. Never downloads by itself.
  autoCheckUpdates: z.boolean(),
  // The repository workspace: Changes beside the diff, or one centered column.
  workspaceLayout: z.enum(['auto', 'centered', 'split']),
  // Code and diffs. The font is applied through a CSS variable, so it is limited to name characters.
  codeTheme: z.enum(CODE_THEMES),
  codeFont: z
    .string()
    .max(80)
    .regex(/^[A-Za-z0-9 _-]*$/),
  codeSize: z.union([
    z.literal(12),
    z.literal(13),
    z.literal(14),
    z.literal(15),
  ]),
  codeLineHeight: z.enum(['compact', 'default', 'relaxed']),
  codeTabWidth: z.union([z.literal(2), z.literal(4), z.literal(8)]),
  codeLigatures: z.boolean(),
  diffLayout: z.enum(['auto', 'unified', 'split']),
  diffContext: z.union([z.literal(3), z.literal(5), z.literal(10)]),
  diffWordHighlight: z.boolean(),
  diffIgnoreWhitespace: z.boolean(),
  diffWrap: z.boolean(),
  diffSyntax: z.boolean(),
  // Lockfiles and minified files open folded; only the view changes, never the patch.
  diffCollapseGenerated: z.boolean(),
  // The Changes list: how Git's status is asked for, and what the diff lets you stage.
  changesUntracked: z.enum(['all', 'normal']),
  changesRenames: z.boolean(),
  changesSubmodules: z.enum(['none', 'dirty', 'all']),
  changesPartial: z.boolean(),
  // Every discard first saves the discarded changes as a patch in the app data folder.
  changesKeepDiscarded: z.boolean(),
  // The Files tab: tree, viewer and how large a text file opens without asking (in MiB).
  sourceLayout: z.enum(['auto', 'centered', 'split']),
  sourceShowIgnored: z.boolean(),
  sourceShowHidden: z.boolean(),
  sourceFoldersFirst: z.boolean(),
  sourceFileIcons: z.boolean(),
  sourceLineNumbers: z.boolean(),
  sourceWrap: z.boolean(),
  sourceSyntax: z.boolean(),
  sourceInlineLimit: z.union([z.literal(1), z.literal(2), z.literal(5)]),
  sourceLastChange: z.boolean(),
  sourceTreeWidth: z.number().int().min(200).max(560),
  // Committing and fetching. 0 turns the summary guide or automatic fetch off.
  commitSummaryGuide: z.union([z.literal(0), z.literal(50), z.literal(72)]),
  commitSignoff: z.boolean(),
  autoFetch: z.union([
    z.literal(0),
    z.literal(5),
    z.literal(15),
    z.literal(30),
  ]),
  // An editor id from the detected list, or system for the OS default app. Main only ever
  // launches an executable it found itself, so this can't name a program.
  // Pull requests: list layout and what the Merge tab starts with.
  pullRequestsLayout: z.enum(['auto', 'centered', 'split']),
  pullMergeMethod: z.enum(['default', 'no-ff']),
  pullPushAfterMerge: z.boolean(),
  pullOfferDeleteBranch: z.boolean(),
  pullWarnBeforeMerge: z.boolean(),
  // Branches tab: what a merge and a new branch start with, and how much Git checks by itself.
  branchAutoMergeability: z.enum(['off', 'compare', 'list']),
  branchMergeMethod: z.enum(['default', 'no-ff', 'ff-only']),
  branchPushAfterMerge: z.boolean(),
  branchOfferDelete: z.boolean(),
  branchSwitchNew: z.boolean(),
  // git follows branch.autoSetupMerge; always and never pass --track and --no-track.
  branchTrack: z.enum(['git', 'always', 'never']),
  branchSort: z.enum(['recent', 'name']),
  branchShowRemote: z.boolean(),
  // Days without a commit before a branch reads as stale; 0 never does.
  branchStaleDays: z.union([z.literal(0), z.literal(30), z.literal(90)]),
  // Git hosting: the remote name used when linking adds the account's Git URL, and how long a
  // token in a copied terminal command lasts, in seconds.
  hostingRemoteName: z.enum(['auto', 'gitdesk', 'none']),
  // Adding, creating or cloning a project gives it a private remote in the account. Nothing is pushed.
  autoHostedRemote: z.boolean(),
  // How Pull integrates the upstream unless one pull picks another method.
  pullStrategy: z.enum(['ff-only', 'merge', 'rebase']),
  hostingTokenLifetime: z.union([
    z.literal(900),
    z.literal(3600),
    z.literal(28_800),
  ]),
  editor: z.enum(EDITOR_IDS),
  editorGotoLine: z.boolean(),
  editorOpenFolder: z.boolean(),
});

export const settingsPatchSchema = settingsSchema.partial().strict();

export type Settings = z.infer<typeof settingsSchema>;
export type SettingsPatch = z.infer<typeof settingsPatchSchema>;

export const DEFAULT_SETTINGS: Settings = {
  theme: 'system',
  accentTone: 'blue',
  fontSize: 'default',
  fontFamily: 'inter',
  motion: 'full',
  contentWidth: 'default',
  zoomLevel: 0,
  contrast: 'standard',
  underlineLinks: false,
  tooltipDelay: 'standard',
  sidebarCollapsed: false,
  sidebarRecent: 5,
  startPage: 'home',
  localOnly: false,
  dashboardLayout: 'auto',
  dashboardDensity: 'comfortable',
  repositoriesLayout: 'auto',
  repositoriesExpandRows: false,
  repositoriesShowStats: false,
  repositoriesSort: 'opened',
  watchRepositories: true,
  refreshOnFocus: true,
  backgroundRefresh: 5,
  remoteRefresh: 'auto',
  homeShowAttention: true,
  homeShowActivity: true,
  homePageSize: 6,
  activitySource: 'both',
  activityIncludeOpens: false,
  notifications: true,
  notifyClone: true,
  notifyProblems: true,
  notifyOnlyInBackground: true,
  autoCheckUpdates: true,
  workspaceLayout: 'auto',
  codeTheme: 'github',
  codeFont: '',
  codeSize: 13,
  codeLineHeight: 'default',
  codeTabWidth: 4,
  codeLigatures: false,
  diffLayout: 'auto',
  diffContext: 3,
  diffWordHighlight: true,
  diffIgnoreWhitespace: false,
  diffWrap: false,
  diffSyntax: true,
  diffCollapseGenerated: true,
  changesUntracked: 'all',
  changesRenames: true,
  changesSubmodules: 'none',
  changesPartial: true,
  changesKeepDiscarded: true,
  sourceLayout: 'auto',
  sourceShowIgnored: false,
  sourceShowHidden: true,
  sourceFoldersFirst: true,
  sourceFileIcons: true,
  sourceLineNumbers: true,
  sourceWrap: false,
  sourceSyntax: true,
  sourceInlineLimit: 1,
  sourceLastChange: true,
  sourceTreeWidth: 300,
  commitSummaryGuide: 72,
  commitSignoff: false,
  autoFetch: 0,
  pullRequestsLayout: 'auto',
  pullMergeMethod: 'default',
  pullPushAfterMerge: true,
  pullOfferDeleteBranch: false,
  pullWarnBeforeMerge: true,
  branchAutoMergeability: 'list',
  branchMergeMethod: 'default',
  branchPushAfterMerge: false,
  branchOfferDelete: true,
  branchSwitchNew: true,
  branchTrack: 'git',
  branchSort: 'recent',
  branchShowRemote: true,
  branchStaleDays: 90,
  hostingRemoteName: 'auto',
  autoHostedRemote: true,
  pullStrategy: 'ff-only',
  hostingTokenLifetime: 3600,
  editor: 'system',
  editorGotoLine: true,
  editorOpenFolder: true,
};

// Field by field, so one bad or retired value falls back alone instead of resetting everything.
export function mergeSettings(stored: unknown): Settings {
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === 'object') {
    for (const [key, field] of Object.entries(settingsSchema.shape)) {
      const parsed = field.safeParse((stored as Record<string, unknown>)[key]);
      if (parsed.success) merged[key] = parsed.data;
    }
  }
  return merged as Settings;
}
