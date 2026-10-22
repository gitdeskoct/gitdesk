import type { SettingsSection } from '../../app/navigation';

export const SECTION_LABELS: Record<SettingsSection, string> = {
  general: 'General',
  appearance: 'Appearance',
  code: 'Code',
  workspace: 'Workspace',
  pulls: 'Pull requests',
  editor: 'Code editor',
  git: 'Git',
  shortcuts: 'Shortcuts',
  account: 'Account',
  hosting: 'Git hosting',
  devices: 'Devices',
  about: 'About',
};

export type SettingEntry = {
  id: string;
  label: string;
  section: SettingsSection;
  keywords: string;
};

// Ids match the SettingRow ids so a result can scroll to and highlight its row.
export const SETTINGS_INDEX: SettingEntry[] = [
  {
    id: 'local-only',
    label: 'Use gitdesk without an account',
    section: 'general',
    keywords: 'offline local sign in account',
  },
  {
    id: 'collapse-sidebar',
    label: 'Collapse sidebar',
    section: 'general',
    keywords: 'navigation icons rail',
  },
  {
    id: 'open-at-login',
    label: 'Open at login',
    section: 'general',
    keywords: 'startup start launch boot',
  },
  {
    id: 'theme',
    label: 'Theme',
    section: 'appearance',
    keywords: 'dark light system mode color scheme',
  },
  {
    id: 'accent',
    label: 'Accent',
    section: 'appearance',
    keywords: 'color tone blue violet green amber rose',
  },
  {
    id: 'text-size',
    label: 'Text size',
    section: 'appearance',
    keywords: 'font size zoom scale large small',
  },
  {
    id: 'font',
    label: 'Font',
    section: 'appearance',
    keywords: 'typeface inter system',
  },
  {
    id: 'motion',
    label: 'Motion',
    section: 'appearance',
    keywords: 'animation reduce reduced off',
  },
  {
    id: 'content-width',
    label: 'Content width',
    section: 'appearance',
    keywords: 'layout wide compact',
  },
  {
    id: 'zoom',
    label: 'Zoom',
    section: 'appearance',
    keywords: 'scale bigger smaller magnify',
  },
  {
    id: 'dashboard-layout',
    label: 'Home layout',
    section: 'workspace',
    keywords: 'dashboard split centered columns attention activity',
  },
  {
    id: 'repositories-layout',
    label: 'Repositories layout',
    section: 'workspace',
    keywords: 'repositories list split centered inspector details wide',
  },
  {
    id: 'dashboard-density',
    label: 'Home density',
    section: 'workspace',
    keywords: 'compact comfortable rows dense',
  },
  {
    id: 'watch-repositories',
    label: 'Watch repositories for changes',
    section: 'workspace',
    keywords: 'watcher status refresh files',
  },
  {
    id: 'refresh-on-focus',
    label: 'Check when gitdesk comes to the front',
    section: 'workspace',
    keywords: 'focus window status refresh',
  },
  {
    id: 'background-refresh',
    label: 'Background check',
    section: 'workspace',
    keywords: 'interval timer minutes status refresh',
  },
  {
    id: 'remote-refresh',
    label: 'Refresh remote details',
    section: 'workspace',
    keywords: 'remote account sync automatic manual',
  },
  {
    id: 'home-show-attention',
    label: 'Show "Needs attention" on Home',
    section: 'workspace',
    keywords: 'home section attention hide show',
  },
  {
    id: 'home-show-activity',
    label: 'Show "Recent activity" on Home',
    section: 'workspace',
    keywords: 'home section activity hide show',
  },
  {
    id: 'home-page-size',
    label: 'Items per page',
    section: 'workspace',
    keywords: 'pagination pages paging list length',
  },
  {
    id: 'activity-source',
    label: 'Show activity from',
    section: 'workspace',
    keywords: 'activity source computer account remote local',
  },
  {
    id: 'activity-include-opens',
    label: 'Include opens in activity',
    section: 'workspace',
    keywords: 'activity opened opens history',
  },
  {
    id: 'clear-activity',
    label: 'Clear activity on this computer',
    section: 'workspace',
    keywords: 'activity history clear delete reset',
  },
  {
    id: 'notifications',
    label: 'Desktop notifications',
    section: 'workspace',
    keywords: 'notification alert toast system notify',
  },
  {
    id: 'notify-clone',
    label: 'Notify when a clone finishes',
    section: 'workspace',
    keywords: 'notification clone done failed',
  },
  {
    id: 'notify-problems',
    label: 'Notify about conflicts and missing folders',
    section: 'workspace',
    keywords: 'notification conflict missing problem',
  },
  {
    id: 'notify-test',
    label: 'Send a test notification',
    section: 'workspace',
    keywords: 'notification test check',
  },
  {
    id: 'workspace-layout',
    label: 'Repository workspace layout',
    section: 'workspace',
    keywords: 'changes diff split centered workspace files',
  },
  {
    id: 'code-theme',
    label: 'Syntax theme',
    section: 'code',
    keywords:
      'shiki highlight colors theme github catppuccin solarized one rose pine',
  },
  {
    id: 'code-font',
    label: 'Code font',
    section: 'code',
    keywords: 'monospace font family cascadia consolas menlo',
  },
  {
    id: 'code-size',
    label: 'Code size',
    section: 'code',
    keywords: 'font size diff text',
  },
  {
    id: 'code-line-height',
    label: 'Code line height',
    section: 'code',
    keywords: 'spacing lines compact relaxed',
  },
  {
    id: 'code-tab-width',
    label: 'Tab width',
    section: 'code',
    keywords: 'tabs indentation spaces',
  },
  {
    id: 'code-ligatures',
    label: 'Font ligatures',
    section: 'code',
    keywords: 'ligature arrows fira',
  },
  {
    id: 'diff-layout',
    label: 'Diff layout',
    section: 'code',
    keywords: 'unified split side by side',
  },
  {
    id: 'diff-context',
    label: 'Diff context lines',
    section: 'code',
    keywords: 'context hidden lines expand',
  },
  {
    id: 'diff-words',
    label: 'Highlight changed words',
    section: 'code',
    keywords: 'word diff inline changes',
  },
  {
    id: 'diff-whitespace',
    label: 'Hide whitespace changes',
    section: 'code',
    keywords: 'whitespace ignore spaces -w',
  },
  {
    id: 'diff-wrap',
    label: 'Wrap long lines',
    section: 'code',
    keywords: 'wrap overflow scroll',
  },
  {
    id: 'diff-syntax',
    label: 'Syntax highlighting',
    section: 'code',
    keywords: 'colors plain text performance',
  },
  {
    id: 'editor-goto-line',
    label: 'Open files at the changed line',
    section: 'editor',
    keywords: 'editor vs code cursor jump line',
  },
  {
    id: 'editor-open-folder',
    label: 'Open the repository folder with a file',
    section: 'editor',
    keywords: 'editor folder project workspace',
  },
  {
    id: 'git-install',
    label: 'Git version and location',
    section: 'git',
    keywords: 'git executable path version installed',
  },
  {
    id: 'git-binary',
    label: 'Which Git to use',
    section: 'git',
    keywords: 'git executable path custom binary',
  },
  {
    id: 'commit-guide',
    label: 'Summary length guide',
    section: 'git',
    keywords: 'commit message length 50 72',
  },
  {
    id: 'commit-signoff',
    label: 'Add Signed-off-by',
    section: 'git',
    keywords: 'signoff dco commit',
  },
  {
    id: 'commit-signing',
    label: 'Signed commits',
    section: 'git',
    keywords: 'gpg ssh signing gpgsign',
  },
  {
    id: 'git-hooks',
    label: 'Git hooks',
    section: 'git',
    keywords: 'hooks pre-commit husky',
  },
  {
    id: 'auto-fetch',
    label: 'Fetch automatically',
    section: 'git',
    keywords: 'fetch interval background remote',
  },
  {
    id: 'fetch-prune',
    label: 'Prune deleted remote branches',
    section: 'git',
    keywords: 'prune fetch.prune remote branches',
  },
  {
    id: 'git-credentials',
    label: 'Credentials',
    section: 'git',
    keywords: 'credential helper manager password ssh',
  },
  {
    id: 'git-identity',
    label: 'Commit identity',
    section: 'git',
    keywords: 'name email author user.name user.email config',
  },
  {
    id: 'git-defaults',
    label: 'Default branch and line endings',
    section: 'git',
    keywords: 'main master init.defaultBranch autocrlf crlf lf newline',
  },
  {
    id: 'shortcuts',
    label: 'Keyboard shortcuts',
    section: 'shortcuts',
    keywords: 'keys hotkeys keyboard',
  },
  {
    id: 'session-storage',
    label: 'Session storage',
    section: 'account',
    keywords: 'keychain security credential',
  },
  {
    id: 'sign-out',
    label: 'Sign out',
    section: 'account',
    keywords: 'logout log out session',
  },
  {
    id: 'pull-requests-layout',
    label: 'Pull requests layout',
    section: 'pulls',
    keywords: 'pull request list split centered review',
  },
  {
    id: 'pull-merge-method',
    label: 'Merge method',
    section: 'pulls',
    keywords: 'merge commit no-ff fast forward pull request',
  },
  {
    id: 'pull-push-after-merge',
    label: 'Push after merging',
    section: 'pulls',
    keywords: 'push merge remote pull request',
  },
  {
    id: 'pull-offer-delete-branch',
    label: 'Offer to delete the merged branch',
    section: 'pulls',
    keywords: 'delete branch merged cleanup',
  },
  {
    id: 'pull-warn-before-merge',
    label: 'Warn before merging',
    section: 'pulls',
    keywords: 'stale approval changes requested unresolved threads',
  },
  {
    id: 'pull-diff-settings',
    label: 'Review diff settings',
    section: 'pulls',
    keywords: 'diff split unified whitespace review',
  },
  {
    id: 'hosting-status',
    label: 'Git hosting',
    section: 'hosting',
    keywords: 'git url clone push remote artifacts server',
  },
  {
    id: 'hosting-remote-name',
    label: 'Add the Git URL as',
    section: 'hosting',
    keywords: 'origin remote name link gitdesk url',
  },
  {
    id: 'hosting-token-lifetime',
    label: 'Token lifetime for copied commands',
    section: 'hosting',
    keywords: 'terminal token expiry push command credentials',
  },
  {
    id: 'hosting-own-tokens',
    label: 'Tokens gitdesk uses itself',
    section: 'hosting',
    keywords: 'token security credentials memory',
  },
  {
    id: 'devices',
    label: 'Signed-in devices',
    section: 'devices',
    keywords: 'sessions computers revoke sign out',
  },
  {
    id: 'version',
    label: 'Version',
    section: 'about',
    keywords: 'electron platform release logs diagnostics',
  },
];

export function searchSettings(query: string): SettingEntry[] {
  const words = query.toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return [];
  return SETTINGS_INDEX.filter((entry) => {
    const haystack =
      `${entry.label} ${SECTION_LABELS[entry.section]} ${entry.keywords}`.toLowerCase();
    return words.every((word) => haystack.includes(word));
  });
}
