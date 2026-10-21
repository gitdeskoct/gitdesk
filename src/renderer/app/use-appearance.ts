import { useEffect, useSyncExternalStore } from 'react';
import type { Settings } from '../../shared/settings';

const darkQuery = () => window.matchMedia('(prefers-color-scheme: dark)');

// main sets nativeTheme.themeSource first, so the media query already reports the chosen theme
// before settings load; System keeps following the OS through it.
export const systemTheme = (): 'light' | 'dark' =>
  darkQuery().matches ? 'dark' : 'light';

function useSystemTheme(): 'light' | 'dark' {
  return useSyncExternalStore((notify) => {
    const query = darkQuery();
    query.addEventListener('change', notify);
    return () => query.removeEventListener('change', notify);
  }, systemTheme);
}

// Theme is applied here, from the setting, instead of waiting for the round trip through main,
// so the switch is immediate and every surface flips in the same frame.
export function applyTheme(theme: 'light' | 'dark'): void {
  const root = document.documentElement;
  if (root.dataset.theme === theme) return;
  root.dataset.themeSwitching = '';
  root.dataset.theme = theme;
  requestAnimationFrame(() =>
    requestAnimationFrame(() => delete root.dataset.themeSwitching),
  );
}

export function useAppearance(settings: Settings | undefined): void {
  const system = useSystemTheme();
  const theme =
    !settings || settings.theme === 'system' ? system : settings.theme;

  useEffect(() => applyTheme(theme), [theme]);

  useEffect(() => {
    if (!settings) return;
    const root = document.documentElement.dataset;
    root.accentTone = settings.accentTone;
    root.font = settings.fontFamily;
    root.fontSize = settings.fontSize;
    root.contentWidth = settings.contentWidth;
    root.motion = settings.motion;
  }, [settings]);
}
