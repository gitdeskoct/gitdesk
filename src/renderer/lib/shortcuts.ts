// One list drives the menu labels, the key handler and Settings › Shortcuts, so they can't drift.
export type ShortcutId =
  | 'settings'
  | 'toggleSidebar'
  | 'zoomIn'
  | 'zoomOut'
  | 'zoomReset'
  | 'fullScreen'
  | 'quit';

type Shortcut = {
  id: ShortcutId;
  label: string;
  mod: boolean;
  keys: string[];
  display: string;
};

export const SHORTCUTS: Shortcut[] = [
  {
    id: 'settings',
    label: 'Open settings',
    mod: true,
    keys: [','],
    display: ',',
  },
  {
    id: 'toggleSidebar',
    label: 'Toggle sidebar',
    mod: true,
    keys: ['b'],
    display: 'B',
  },
  { id: 'zoomIn', label: 'Zoom in', mod: true, keys: ['=', '+'], display: '=' },
  {
    id: 'zoomOut',
    label: 'Zoom out',
    mod: true,
    keys: ['-', '_'],
    display: '-',
  },
  {
    id: 'zoomReset',
    label: 'Actual size',
    mod: true,
    keys: ['0'],
    display: '0',
  },
  {
    id: 'fullScreen',
    label: 'Toggle full screen',
    mod: false,
    keys: ['F11'],
    display: 'F11',
  },
  { id: 'quit', label: 'Quit gitdesk', mod: true, keys: ['q'], display: 'Q' },
];

const mac = () => window.desktop?.platform === 'darwin';
export const modLabel = () => (mac() ? '⌘' : 'Ctrl');

export function shortcutKeys(id: ShortcutId): string[] {
  const shortcut = SHORTCUTS.find((s) => s.id === id)!;
  return shortcut.mod ? [modLabel(), shortcut.display] : [shortcut.display];
}

export const shortcutText = (id: ShortcutId) =>
  shortcutKeys(id).join(mac() ? '' : '+');

export function matchShortcut(event: KeyboardEvent): ShortcutId | null {
  const mod = mac() ? event.metaKey : event.ctrlKey;
  if (event.altKey) return null;
  const key = event.key.length === 1 ? event.key.toLowerCase() : event.key;
  return (
    SHORTCUTS.find((s) => s.mod === mod && s.keys.includes(key))?.id ?? null
  );
}

// Chromium zoom: each level multiplies by 1.2. Steps of 0.5 match the settings schema.
export const ZOOM_STEP = 0.5;
export const clampZoom = (level: number) => Math.min(3, Math.max(-3, level));
export const zoomPercent = (level: number) => Math.round(1.2 ** level * 100);
