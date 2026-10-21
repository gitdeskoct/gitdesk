import type { AuthErrorCode, AuthNotice } from '../../../shared/ipc';

export type AuthMessage = {
  tone: 'danger' | 'warning' | 'info';
  title: string;
  body: string;
};

export const authErrorMessages: Record<AuthErrorCode, AuthMessage> = {
  timed_out: {
    tone: 'danger',
    title: 'Sign-in timed out.',
    body: 'The browser step took longer than 5 minutes. Start again when you are ready.',
  },
  unreachable: {
    tone: 'danger',
    title: "Can't reach the gitdesk server.",
    body: 'Check your connection, then try again.',
  },
  provider_error: {
    tone: 'danger',
    title: "Google couldn't complete the sign-in.",
    body: 'Try again. If it keeps failing, Google may be having trouble.',
  },
  cancelled_in_browser: {
    tone: 'warning',
    title: 'Sign-in was cancelled in the browser.',
    body: 'Start again when you are ready.',
  },
  rate_limited: {
    tone: 'danger',
    title: 'Too many sign-in attempts.',
    body: 'Wait a minute, then try again.',
  },
  invalid_grant: {
    tone: 'danger',
    title: 'That sign-in link was already used or has expired.',
    body: 'Start again from this window.',
  },
  unknown: {
    tone: 'danger',
    title: "Sign-in didn't finish.",
    body: 'Try again.',
  },
};

export const authNoticeMessages: Record<AuthNotice, AuthMessage> = {
  session_expired: {
    tone: 'warning',
    title: 'Your session expired.',
    body: 'Sign in again to reach your remote repositories.',
  },
  session_revoked: {
    tone: 'warning',
    title: 'This device was signed out.',
    body: 'It was signed out from another device or to protect your account. Sign in again to continue.',
  },
  remote_signout_unconfirmed: {
    tone: 'info',
    title: 'Signed out on this computer.',
    body: "The server couldn't be reached to end the session there, but the saved sign-in was deleted from this computer.",
  },
};
