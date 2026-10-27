import { useEffect, useRef } from 'react';
import type { WindowCommand } from '../../shared/ipc';
import {
  useRefreshRepositories,
  useSettings,
  useUpdateSettings,
} from '../lib/queries';
import {
  clampZoom,
  matchShortcut,
  SHORTCUTS,
  ZOOM_STEP,
  type ShortcutId,
} from '../lib/shortcuts';
import { useNavigation } from './navigation';
import { useWorkspaceUi, type Panel } from './workspace-ui';

export const windowCommand = (command: WindowCommand) =>
  void window.desktop.window.command(command);

type AppShortcut = Exclude<
  ShortcutId,
  'repoTab' | 'fetch' | 'pull' | 'push' | 'openEditor' | 'reveal'
>;

// What each shortcut does. Shared by the menu bar and the keyboard handler.
export function useAppActions() {
  const { route, navigate } = useNavigation();
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const refresh = useRefreshRepositories();
  const ui = useWorkspaceUi();
  const zoom = settings?.zoomLevel ?? 0;
  // Create and Clone are side panels on Home and Repositories; elsewhere they open on Repositories.
  const openPanel = (panel: Panel) => {
    if (route.name !== 'home' && route.name !== 'repositories')
      navigate({ name: 'repositories' });
    ui.setPanel(panel);
  };

  return (id: AppShortcut) => {
    switch (id) {
      case 'settings':
        return navigate({ name: 'settings', section: 'general' });
      case 'toggleSidebar':
        return update.mutate({ sidebarCollapsed: !settings?.sidebarCollapsed });
      case 'goHome':
        return navigate({ name: 'home' });
      case 'goRepositories':
        return navigate({ name: 'repositories' });
      case 'newRepository':
        return openPanel('create');
      case 'cloneRepository':
        return openPanel('clone');
      case 'openRepository':
        return ui.addRepository();
      case 'search':
        // The page's own search field, if it has one: Repositories, Settings, branch and file filters.
        return document
          .querySelector<HTMLInputElement>('input[type="search"]')
          ?.focus();
      case 'refresh':
        return refresh.mutate(route.name === 'repository' ? route.id : null);
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

const scopeOf = (id: ShortcutId) => SHORTCUTS.find((s) => s.id === id)!.scope;

export function useShortcutKeys(inShell: boolean) {
  const run = useAppActions();
  const latest = useRef({ run, inShell });
  latest.current = { run, inShell };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      const id = matchShortcut(event);
      if (!id) return;
      const scope = scopeOf(id);
      // Repository keys belong to the page that owns the action and its spinner.
      if (
        scope === 'repository' ||
        (scope === 'shell' && !latest.current.inShell)
      )
        return;
      event.preventDefault();
      latest.current.run(id as AppShortcut);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
}

// A repository shortcut handled where its action lives, so the key and the button share one
// running state. Only one mounted handler per id should be enabled at a time.
export function useShortcut(
  id: ShortcutId,
  run: (event: KeyboardEvent) => void,
  enabled = true,
) {
  const latest = useRef(run);
  latest.current = run;
  useEffect(() => {
    if (!enabled) return;
    const onKey = (event: KeyboardEvent) => {
      if (matchShortcut(event) !== id) return;
      event.preventDefault();
      latest.current(event);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [id, enabled]);
}
