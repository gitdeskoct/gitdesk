import { useEffect } from 'react';
import type { Settings } from '../../shared/settings';

// The theme itself flows through nativeTheme.themeSource -> prefers-color-scheme; the rest are root attributes.
export function useAppearance(settings: Settings | undefined): void {
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
