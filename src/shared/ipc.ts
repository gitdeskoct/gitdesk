import { z } from 'zod';
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
  | { available: true; name: string | null; email: string | null };

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

export type AppInfo = {
  version: string;
  electron: string;
  platform: 'win32' | 'darwin' | 'linux';
};

export const IPC = {
  appGetInfo: 'app:get-info',
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
  gitOpenInstallPage: 'git:open-install-page',
} as const;

export interface DesktopApi {
  platform: AppInfo['platform'];
  app: {
    getInfo(): Promise<AppInfo>;
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
    openInstallPage(): Promise<void>;
  };
}
