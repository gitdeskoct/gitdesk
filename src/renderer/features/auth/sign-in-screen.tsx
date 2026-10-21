import { LogoMark } from '../../components/brand/logo';
import {
  BrowserLockArt,
  CommitGraphArt,
  KeychainArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { WobbleTile } from '../../components/ui/wobble-tile';
import {
  useMotionAllowed,
  useSignIn,
  useUpdateSettings,
} from '../../lib/queries';
import { TitleBar } from '../shell/title-bar';
import { AuthMessageLine } from './auth-message';
import { authErrorMessages, authNoticeMessages } from './messages';
import type { AuthStatus } from '../../../shared/ipc';

// Google's sign-in branding asks for the standard four-color "G" on a neutral button.
function GoogleG() {
  return (
    <svg viewBox="0 0 48 48" aria-hidden className="size-[18px]">
      <path
        fill="#EA4335"
        d="M24 9.5c3.54 0 6.71 1.22 9.21 3.6l6.85-6.85C35.9 2.38 30.47 0 24 0 14.62 0 6.51 5.38 2.56 13.22l7.98 6.19C12.43 13.72 17.74 9.5 24 9.5z"
      />
      <path
        fill="#4285F4"
        d="M46.98 24.55c0-1.57-.15-3.09-.38-4.55H24v9.02h12.94c-.58 2.96-2.26 5.48-4.78 7.18l7.73 6c4.51-4.18 7.09-10.36 7.09-17.65z"
      />
      <path
        fill="#FBBC05"
        d="M10.53 28.59c-.48-1.45-.76-2.99-.76-4.59s.27-3.14.76-4.59l-7.98-6.19C.92 16.46 0 20.12 0 24c0 3.88.92 7.54 2.56 10.78l7.97-6.19z"
      />
      <path
        fill="#34A853"
        d="M24 48c6.48 0 11.93-2.13 15.89-5.81l-7.73-6c-2.15 1.45-4.92 2.3-8.16 2.3-6.26 0-11.57-4.22-13.47-9.91l-7.98 6.19C6.51 42.62 14.62 48 24 48z"
      />
    </svg>
  );
}

// Each tile states one real property of how gitdesk works, so the tile boundary carries meaning.
function Tiles() {
  return (
    <div className="hidden items-center justify-center pt-2 pr-4 pb-8 pl-8 min-[1000px]:flex">
      <div className="grid h-full max-h-[480px] w-full max-w-[560px] grid-cols-2 grid-rows-[1.15fr_1fr] gap-1.5">
        <WobbleTile className="col-span-2 bg-accent text-on-accent">
          <h2 className="max-w-[15ch] text-[1.3125rem] leading-tight font-semibold tracking-[-0.015em]">
            Your history stays on this computer.
          </h2>
          <p className="mt-2.5 max-w-[30ch] text-sm leading-relaxed">
            Commits, branches and history run on the Git you already have. No
            network needed.
          </p>
          <CommitGraphArt className="absolute -right-6.5 -bottom-7.5" />
        </WobbleTile>
        <WobbleTile className="bg-ink text-canvas">
          <h2 className="max-w-[12ch] text-[1.0625rem] leading-tight font-semibold tracking-[-0.015em]">
            Sign-in happens in your browser.
          </h2>
          <p className="mt-2.5 max-w-[18ch] text-sm leading-relaxed">
            gitdesk never sees your Google password.
          </p>
          <BrowserLockArt className="absolute -right-3.5 -bottom-4.5" />
        </WobbleTile>
        <WobbleTile className="bg-sunken text-ink shadow-[inset_0_0_0_1px_var(--line)]">
          <h2 className="max-w-[12ch] text-[1.0625rem] leading-tight font-semibold tracking-[-0.015em]">
            Kept in your system keychain.
          </h2>
          <p className="mt-2.5 max-w-[18ch] text-sm leading-relaxed text-muted">
            Sessions rotate on use. Sign out any device.
          </p>
          <KeychainArt className="absolute -right-4 -bottom-5 text-faint" />
        </WobbleTile>
      </div>
    </div>
  );
}

export function SignInScreen({
  status,
}: {
  status: Extract<AuthStatus, { status: 'signed-out' }>;
}) {
  const signIn = useSignIn();
  const update = useUpdateSettings();
  const motion = useMotionAllowed();
  const message = status.error
    ? authErrorMessages[status.error]
    : status.notice
      ? authNoticeMessages[status.notice]
      : null;

  return (
    <div className="flex h-full flex-col bg-canvas">
      <TitleBar brand={false} sidebarToggle={false} />
      <main className="grid min-h-0 flex-1 min-[1000px]:grid-cols-[1.15fr_1fr]">
        <Tiles />
        <div className="flex items-center justify-center px-10 pt-2 pb-10">
          <div className="w-full max-w-[340px]">
            <div className="mb-9 flex items-center gap-3 text-ink">
              <LogoMark size={44} animate={motion} />
              <span className="text-[1.625rem] font-semibold tracking-[-0.03em]">
                gitdesk
              </span>
            </div>
            <h1 className="text-[1.375rem] font-semibold tracking-[-0.02em] text-ink">
              Sign in
            </h1>
            <p className="mt-1.5 mb-6 text-sm leading-relaxed text-muted">
              Google opens in your browser. This window updates when you finish.
            </p>
            <Button
              size="lg"
              className="w-full"
              pending={signIn.isPending}
              onClick={() => signIn.mutate()}
            >
              {signIn.isPending ? (
                'Opening browser…'
              ) : (
                <>
                  <GoogleG />
                  Continue with Google
                </>
              )}
            </Button>
            <Button
              variant="ghost"
              className="mt-1.5 w-full"
              onClick={() => update.mutate({ localOnly: true })}
            >
              Continue without an account
            </Button>
            {message && <AuthMessageLine message={message} className="mt-5" />}
            <p className="mt-6 text-[0.8125rem] leading-relaxed text-muted">
              Local Git keeps working when you are signed out.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
}
