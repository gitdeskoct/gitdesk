import type { SettingsSection } from '../../app/navigation';

export const SECTION_LABELS: Record<SettingsSection, string> = {
  general: 'General',
  appearance: 'Appearance',
  git: 'Git',
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
    id: 'git-identity',
    label: 'Commit identity',
    section: 'git',
    keywords: 'name email author user.name user.email config',
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
    keywords: 'electron platform release',
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
