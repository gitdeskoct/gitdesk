import { GoogleG } from '../../components/brand/google-g';
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
          <div className="w-full max-w-[380px]">
            <div className="mb-10 flex items-center gap-3 text-ink">
              <LogoMark size={48} animate={motion} />
              <span className="text-[1.875rem] font-semibold tracking-[-0.03em]">
                gitdesk
              </span>
            </div>
            <h1 className="text-[1.75rem] leading-tight font-semibold tracking-[-0.02em] text-ink">
              Sign in
            </h1>
            <p className="mt-2 mb-7 text-[0.9375rem] leading-relaxed text-muted">
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
              pending={update.isPending}
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
