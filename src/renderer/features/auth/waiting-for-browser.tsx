import { ExternalLink } from 'lucide-react';
import { LogoMark } from '../../components/brand/logo';
import { Button } from '../../components/ui/button';
import {
  useCancelSignIn,
  useMotionAllowed,
  useReopenBrowser,
} from '../../lib/queries';
import { TitleBar } from '../shell/title-bar';

// Shown while main waits on the loopback callback. The 5 minutes match the loopback server's timeout.
export function WaitingForBrowser() {
  const reopen = useReopenBrowser();
  const cancel = useCancelSignIn();
  const motion = useMotionAllowed();

  return (
    <div className="flex h-full flex-col bg-canvas">
      <TitleBar brand={false} sidebarToggle={false} />
      <main className="flex min-h-0 flex-1 items-center justify-center px-10 pb-10">
        <div className="w-full max-w-[360px]" role="status">
          <LogoMark size={48} animate={motion} className="mb-6 text-accent" />
          <h1 className="text-[1.375rem] font-semibold tracking-[-0.02em] text-ink">
            Finish signing in in your browser
          </h1>
          <p className="mt-1.5 mb-6 text-sm leading-relaxed text-muted">
            A Google tab opened. This window updates by itself when you are
            done. The link expires in 5 minutes.
          </p>
          <div className="flex gap-2">
            <Button pending={reopen.isPending} onClick={() => reopen.mutate()}>
              {!reopen.isPending && <ExternalLink />}
              Open browser again
            </Button>
            <Button
              variant="ghost"
              pending={cancel.isPending}
              onClick={() => cancel.mutate()}
            >
              Cancel
            </Button>
          </div>
        </div>
      </main>
    </div>
  );
}
