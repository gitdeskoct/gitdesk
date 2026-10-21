import { useEffect, useRef } from 'react';
import type { WindowCommand } from '../../shared/ipc';
import { useSettings, useUpdateSettings } from '../lib/queries';
import {
  clampZoom,
  matchShortcut,
  ZOOM_STEP,
  type ShortcutId,
} from '../lib/shortcuts';
import { useNavigation } from './navigation';

export const windowCommand = (command: WindowCommand) =>
  void window.desktop.window.command(command);

// What each shortcut does. Shared by the menu bar and the keyboard handler.
export function useAppActions() {
  const { navigate } = useNavigation();
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const zoom = settings?.zoomLevel ?? 0;

  return (id: ShortcutId) => {
    switch (id) {
      case 'settings':
        return navigate({ name: 'settings', section: 'general' });
      case 'toggleSidebar':
        return update.mutate({ sidebarCollapsed: !settings?.sidebarCollapsed });
      case 'zoomIn':
        return update.mutate({ zoomLevel: clampZoom(zoom + ZOOM_STEP) });
      case 'zoomOut':
        return update.mutate({ zoomLevel: clampZoom(zoom - ZOOM_STEP) });
      case 'zoomReset':
        return update.mutate({ zoomLevel: 0 });
      case 'fullScreen':
        return windowCommand('toggleFullScreen');
      case 'quit':
        return windowCommand('quit');
    }
  };
}

// Navigation shortcuts only apply inside the shell; zoom, full screen and quit work everywhere.
const SHELL_ONLY: ShortcutId[] = ['settings', 'toggleSidebar'];

export function useShortcutKeys(inShell: boolean) {
  const run = useAppActions();
  const latest = useRef({ run, inShell });
  latest.current = { run, inShell };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const id = matchShortcut(event);
      if (!id || (SHELL_ONLY.includes(id) && !latest.current.inShell)) return;
      event.preventDefault();
      latest.current.run(id);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}
