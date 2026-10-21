import { z } from 'zod';
import type { ReposApi } from './repos';
import type { Settings, SettingsPatch } from './settings';

export const accountSummarySchema = z.object({
  id: z.string(),
  displayName: z.string(),
  email: z.string(),
  avatarUrl: z.string().nullable(),
});
export type AccountSummary = z.infer<typeof accountSummarySchema>;

export type AuthErrorCode =
  | 'timed_out'
  | 'unreachable'
  | 'provider_error'
  | 'cancelled_in_browser'
  | 'rate_limited'
  | 'invalid_grant'
  | 'unknown';

export type AuthNotice =
  | 'session_expired'
  | 'session_revoked'
  | 'remote_signout_unconfirmed';

export type AuthStatus =
  | { status: 'signed-out'; error?: AuthErrorCode; notice?: AuthNotice }
  | { status: 'authenticating' }
  | {
      status: 'authenticated';
      account: AccountSummary;
      persistence: 'secure' | 'memory';
    }
  | { status: 'offline'; account: AccountSummary | null };

export const sessionInfoSchema = z.object({
  id: z.string(),
  deviceName: z.string(),
  createdAt: z.number(),
  lastUsedAt: z.number(),
  current: z.boolean(),
});
export type SessionInfo = z.infer<typeof sessionInfoSchema>;

export type GitIdentity =
  | { available: false }
  | {
      available: true;
      name: string | null;
      email: string | null;
      defaultBranch: string | null;
      autocrlf: GitDefaults['autocrlf'] | null;
    };

export const gitIdentityInputSchema = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'Enter a name.')
    .max(100, 'Keep the name under 100 characters.')
    .regex(/^[^\r\n\0]*$/, 'The name cannot contain line breaks.'),
  email: z.email('Enter a valid email address.').max(254),
});
export type GitIdentityInput = z.infer<typeof gitIdentityInputSchema>;

// A safe subset of git check-ref-format: no spaces, "..", "@{", leading "-" or ".", or ".lock" ending.
export const gitDefaultsSchema = z.object({
  defaultBranch: z
    .string()
    .trim()
    .min(1, 'Enter a branch name.')
    .max(100, 'Keep the branch name under 100 characters.')
    .regex(
      /^(?![-./])(?!.*\.\.)(?!.*@\{)(?!.*\/\/)[A-Za-z0-9._/-]+(?<![./])(?<!\.lock)$/,
      'Use letters, numbers, dots, dashes, underscores or slashes, like main.',
    ),
  autocrlf: z.enum(['true', 'input', 'false']),
});
export type GitDefaults = z.infer<typeof gitDefaultsSchema>;

export const windowCommandSchema = z.enum([
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'selectAll',
  'toggleFullScreen',
  'quit',
]);
export type WindowCommand = z.infer<typeof windowCommandSchema>;

export type AppInfo = {
  version: string;
  electron: string;
  platform: 'win32' | 'darwin' | 'linux';
  openAtLogin: boolean | null;
};

export const IPC = {
  appGetInfo: 'app:get-info',
  appSetOpenAtLogin: 'app:set-open-at-login',
  appOpenLogs: 'app:open-logs',
  appCopyDiagnostics: 'app:copy-diagnostics',
  windowCommand: 'window:command',
  authGetStatus: 'auth:get-status',
  authRetry: 'auth:retry',
  authSignIn: 'auth:sign-in',
  authCancelSignIn: 'auth:cancel-sign-in',
  authReopenBrowser: 'auth:reopen-browser',
  authSignOut: 'auth:sign-out',
  authListSessions: 'auth:list-sessions',
  authRevokeSession: 'auth:revoke-session',
  authStatusChanged: 'auth:status-changed',
  settingsGet: 'settings:get',
  settingsUpdate: 'settings:update',
  gitGetIdentity: 'git:get-identity',
  gitSetIdentity: 'git:set-identity',
  gitSetDefaults: 'git:set-defaults',
  gitOpenInstallPage: 'git:open-install-page',
} as const;

export interface DesktopApi {
  platform: AppInfo['platform'];
  app: {
    getInfo(): Promise<AppInfo>;
    setOpenAtLogin(enabled: boolean): Promise<AppInfo>;
    openLogs(): Promise<void>;
    copyDiagnostics(): Promise<void>;
  };
  window: {
    command(command: WindowCommand): Promise<void>;
  };
  auth: {
    getStatus(): Promise<AuthStatus>;
    retry(): Promise<AuthStatus>;
    signIn(): Promise<AuthStatus>;
    cancelSignIn(): Promise<void>;
    reopenBrowser(): Promise<void>;
    signOut(): Promise<AuthStatus>;
    listSessions(): Promise<SessionInfo[]>;
    revokeSession(id: string): Promise<void>;
    onStatusChanged(callback: (status: AuthStatus) => void): () => void;
  };
  settings: {
    get(): Promise<Settings>;
    update(patch: SettingsPatch): Promise<Settings>;
  };
  git: {
    getIdentity(): Promise<GitIdentity>;
    setIdentity(input: GitIdentityInput): Promise<GitIdentity>;
    setDefaults(input: GitDefaults): Promise<GitIdentity>;
    openInstallPage(): Promise<void>;
  };
  repos: ReposApi;
}
