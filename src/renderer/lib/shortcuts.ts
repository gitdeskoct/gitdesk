// One list drives the menu labels, the key handler and Settings › Shortcuts, so they can't drift.
// Keys follow GitHub Desktop where gitdesk has the same action and the key isn't already taken.
export type ShortcutId =
  | 'settings'
  | 'toggleSidebar'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'fullScreen'
  | 'quit'
  | 'goHome'
  | 'goRepositories'
  | 'newRepository'
  | 'openRepository'
  | 'cloneRepository'
  | 'search'
  | 'refresh'
  | 'repoTab'
  | 'fetch'
  | 'pull'
  | 'push'
  | 'openEditor'
  | 'reveal';

// app works everywhere, shell only once the main window is open, repository only on an open
// repository, where the page itself handles the key (see useShortcut).
export type ShortcutScope = 'app' | 'shell' | 'repository';

type Shortcut = {
  id: ShortcutId;
  label: string;
  group: 'App' | 'Repositories' | 'Repository';
  scope: ShortcutScope;
  mod: boolean;
  // true needs Shift; left out, Shift doesn't matter except on letters, which it would change.
  shift?: boolean;
  keys: string[];
  display: string;
};

export const SHORTCUTS: Shortcut[] = [
  {
    id: 'settings',
    label: 'Open settings',
    group: 'App',
    scope: 'shell',
    mod: true,
    keys: [','],
    display: ',',
  },
  {
    id: 'toggleSidebar',
    label: 'Toggle sidebar',
    group: 'App',
    scope: 'shell',
    mod: true,
    keys: ['b'],
    display: 'B',
  },
  {
    id: 'goHome',
    label: 'Go to Home',
    group: 'App',
    scope: 'shell',
    mod: true,
    shift: true,
    keys: ['h'],
    display: 'H',
  },
  {
    id: 'search',
    label: 'Search this page',
    group: 'App',
    scope: 'shell',
    mod: true,
    keys: ['f'],
    display: 'F',
  },
  {
    id: 'zoomIn',
    label: 'Zoom in',
    group: 'App',
    scope: 'app',
    mod: true,
    keys: ['=', '+'],
    display: '=',
  },
  {
    id: 'zoomOut',
    label: 'Zoom out',
    group: 'App',
    scope: 'app',
    mod: true,
    keys: ['-', '_'],
    display: '-',
  },
  {
    id: 'zoomReset',
    label: 'Actual size',
    group: 'App',
    scope: 'app',
    mod: true,
    keys: ['0'],
    display: '0',
  },
  {
    id: 'fullScreen',
    label: 'Toggle full screen',
    group: 'App',
    scope: 'app',
    mod: false,
    keys: ['F11'],
    display: 'F11',
  },
  {
    id: 'quit',
    label: 'Quit gitdesk',
    group: 'App',
    scope: 'app',
    mod: true,
    keys: ['q'],
    display: 'Q',
  },
  {
    id: 'goRepositories',
    label: 'Show your repositories',
    group: 'Repositories',
    scope: 'shell',
    mod: true,
    keys: ['t'],
    display: 'T',
  },
  {
    id: 'newRepository',
    label: 'New repository',
    group: 'Repositories',
    scope: 'shell',
    mod: true,
    keys: ['n'],
    display: 'N',
  },
  {
    id: 'openRepository',
    label: 'Open a folder that uses Git',
    group: 'Repositories',
    scope: 'shell',
    mod: true,
    keys: ['o'],
    display: 'O',
  },
  {
    id: 'cloneRepository',
    label: 'Clone a repository',
    group: 'Repositories',
    scope: 'shell',
    mod: true,
    shift: true,
    keys: ['o'],
    display: 'O',
  },
  {
    id: 'refresh',
    label: 'Check status again',
    group: 'Repositories',
    scope: 'shell',
    mod: false,
    keys: ['F5'],
    display: 'F5',
  },
  {
    id: 'repoTab',
    label: 'Changes, Files, History… (tabs in order)',
    group: 'Repository',
    scope: 'repository',
    mod: true,
    keys: ['1', '2', '3', '4', '5', '6', '7', '8', '9'],
    display: '1–9',
  },
  {
    id: 'fetch',
    label: 'Fetch',
    group: 'Repository',
    scope: 'repository',
    mod: true,
    shift: true,
    keys: ['t'],
    display: 'T',
  },
  {
    id: 'pull',
    label: 'Pull',
    group: 'Repository',
    scope: 'repository',
    mod: true,
    shift: true,
    keys: ['p'],
    display: 'P',
  },
  {
    id: 'push',
    label: 'Push',
    group: 'Repository',
    scope: 'repository',
    mod: true,
    keys: ['p'],
    display: 'P',
  },
  {
    id: 'openEditor',
    label: 'Open in your code editor',
    group: 'Repository',
    scope: 'repository',
    mod: true,
    shift: true,
    keys: ['a'],
    display: 'A',
  },
  {
    id: 'reveal',
    label: 'Show in your file manager',
    group: 'Repository',
    scope: 'repository',
    mod: true,
    shift: true,
    keys: ['f'],
    display: 'F',
  },
];

// Keys that work while a diff has focus. The diff view handles them itself; this list is what
// Settings › Shortcuts shows, so the two stay together here.
export const DIFF_SHORTCUTS = [
  { label: 'Next change in the diff', keys: [']'] },
  { label: 'Previous change in the diff', keys: ['['] },
  { label: 'Next changed file', keys: ['Alt', '↓'] },
  { label: 'Previous changed file', keys: ['Alt', '↑'] },
  {
    label: 'Select a changed line (then Shift+click for a range)',
    keys: ['Space'],
  },
  { label: 'Stage or unstage the file picked in Changes', keys: ['Space'] },
  { label: 'Check the picked file for a bulk action', keys: ['X'] },
  { label: 'Check a range of files', keys: ['Shift', '↓'] },
  { label: 'First or last changed file', keys: ['Home'] },
] as const;

// Keys that belong to one control: lists, fields and the commit form handle them themselves.
export const CONTROL_SHORTCUTS = [
  { label: 'Commit, from the summary or description', keys: ['mod', 'Enter'] },
  { label: 'Send a pull request comment', keys: ['mod', 'Enter'] },
  { label: 'Clear a search field', keys: ['Esc'] },
  { label: 'Move through a repository or pull request list', keys: ['↑', '↓'] },
  { label: 'Open the picked repository or pull request', keys: ['Enter'] },
  { label: 'Turn pages while the pager has focus', keys: ['←', '→'] },
  { label: 'Move focus to notifications', keys: ['F8'] },
] as const;

const mac = () => window.desktop?.platform === 'darwin';
export const modLabel = () => (mac() ? '⌘' : 'Ctrl');

export function shortcutKeys(id: ShortcutId): string[] {
  const shortcut = SHORTCUTS.find((s) => s.id === id)!;
  return [
    ...(shortcut.mod ? [modLabel()] : []),
    ...(shortcut.shift ? [mac() ? '⇧' : 'Shift'] : []),
    shortcut.display,
  ];
}

export const shortcutText = (id: ShortcutId) =>
  shortcutKeys(id).join(mac() ? '' : '+');

export function matchShortcut(event: KeyboardEvent): ShortcutId | null {
  const mod = mac() ? event.metaKey : event.ctrlKey;
  if (event.altKey) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  const letter = /^[a-z]$/.test(key);
  return (
    SHORTCUTS.find(
      (s) =>
        s.mod === mod &&
        s.keys.includes(key) &&
        (s.shift ? event.shiftKey : !(letter && event.shiftKey)),
    )?.id ?? null
  );
}

// Chromium zoom: each level multiplies by 1.2. Steps of 0.5 match the settings schema.
export const ZOOM_STEP = 0.5;
export const clampZoom = (level: number) => Math.min(3, Math.max(-3, level));
export const zoomPercent = (level: number) => Math.round(1.2 ** level * 100);
