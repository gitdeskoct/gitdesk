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
  // Workspace: how Home is laid out and how often repositories are checked.
  dashboardLayout: z.enum(['auto', 'centered', 'split']),
  dashboardDensity: z.enum(['comfortable', 'compact']),
  watchRepositories: z.boolean(),
  refreshOnFocus: z.boolean(),
  // Minutes between background checks while the window is open; 0 turns them off.
  backgroundRefresh: z.union([
    z.literal(0),
    z.literal(5),
    z.literal(15),
    z.literal(30),
  ]),
  remoteRefresh: z.enum(['auto', 'manual']),
  // Home sections and what Recent activity lists.
  homeShowAttention: z.boolean(),
  homeShowActivity: z.boolean(),
  homePageSize: z.union([z.literal(6), z.literal(10), z.literal(20)]),
  activitySource: z.enum(['both', 'local', 'account']),
  activityIncludeOpens: z.boolean(),
  // System notifications; while gitdesk is in front the same news is an in-app toast.
  notifications: z.boolean(),
  notifyClone: z.boolean(),
  notifyProblems: z.boolean(),
  notifyOnlyInBackground: z.boolean(),
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
  dashboardLayout: 'auto',
  dashboardDensity: 'comfortable',
  watchRepositories: true,
  refreshOnFocus: true,
  backgroundRefresh: 5,
  remoteRefresh: 'auto',
  homeShowAttention: true,
  homeShowActivity: true,
  homePageSize: 6,
  activitySource: 'both',
  activityIncludeOpens: false,
  notifications: true,
  notifyClone: true,
  notifyProblems: true,
  notifyOnlyInBackground: true,
};

// Field by field, so one bad or retired value falls back alone instead of resetting everything.
export function mergeSettings(stored: unknown): Settings {
  const merged: Record<string, unknown> = { ...DEFAULT_SETTINGS };
  if (stored && typeof stored === 'object') {
    for (const [key, field] of Object.entries(settingsSchema.shape)) {
      const parsed = field.safeParse((stored as Record<string, unknown>)[key]);
      if (parsed.success) merged[key] = parsed.data;
    }
  }
  return merged as Settings;
}
