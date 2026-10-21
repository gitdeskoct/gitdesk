import { z } from 'zod';

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
  sidebarCollapsed: z.boolean(),
  localOnly: z.boolean(),
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
  sidebarCollapsed: false,
  localOnly: false,
};

export function mergeSettings(stored: unknown): Settings {
  const parsed = settingsSchema.partial().safeParse(stored);
  return { ...DEFAULT_SETTINGS, ...(parsed.success ? parsed.data : {}) };
}
