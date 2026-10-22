import type { SettingsSection } from '../../app/navigation';

export const SECTION_LABELS: Record<SettingsSection, string> = {
  general: 'General',
  appearance: 'Appearance',
  workspace: 'Workspace',
  git: 'Git',
  shortcuts: 'Shortcuts',
  account: 'Account',
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
