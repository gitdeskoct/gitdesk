import { CloudOff, Info, KeyRound } from 'lucide-react';
import type { ReactNode } from 'react';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import {
  useAuthStatus,
  useRetryConnection,
  useSignIn,
} from '../../lib/queries';
import { authNoticeMessages } from '../auth/messages';

function Line({
  icon,
  tone,
  children,
  action,
}: {
  icon: ReactNode;
  tone: 'warning' | 'info';
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role="status"
      className={cn(
        'flex-none border-b border-line px-6 py-2.5 text-[0.8125rem] text-ink',
        tone === 'warning' ? 'bg-warning-soft' : 'bg-sunken',
      )}
    >
      <div
        className={cn(
          'flex items-center gap-2.5 [&>svg]:size-4 [&>svg]:shrink-0',
          tone === 'warning' ? '[&>svg]:text-warning' : '[&>svg]:text-muted',
        )}
      >
        {icon}
        <span className="min-w-0 flex-1">{children}</span>
        {action}
      </div>
    </div>
  );
}

// One inline line under the page header: never a modal, never blocks local work.
export function ConnectionStatus() {
  const { data: status } = useAuthStatus();
  const retry = useRetryConnection();
  const signIn = useSignIn();
  if (!status) return null;

  if (status.status === 'offline') {
    return (
      <Line
        icon={<CloudOff />}
        tone="warning"
        action={
          <Button
            size="sm"
            pending={retry.isPending}
            onClick={() => retry.mutate()}
          >
            {retry.isPending ? 'Trying again…' : 'Try again'}
          </Button>
        }
      >
        Can't reach the gitdesk server. Showing your last known account; remote
        features are paused.
      </Line>
    );
  }
  if (status.status === 'authenticated' && status.persistence === 'memory') {
    return (
      <Line icon={<KeyRound />} tone="warning">
        No system keychain was found, so your sign-in is kept in memory. You'll
        sign in again after quitting.
      </Line>
    );
  }
  if (status.status === 'signed-out' && status.notice) {
    const message = authNoticeMessages[status.notice];
    return (
      <Line
        icon={<Info />}
        tone={message.tone === 'warning' ? 'warning' : 'info'}
        action={
          status.notice !== 'remote_signout_unconfirmed' && (
            <Button
              size="sm"
              pending={signIn.isPending}
              onClick={() => signIn.mutate()}
            >
              Sign in
            </Button>
          )
        }
      >
        <span className="font-semibold">{message.title}</span> {message.body}
      </Line>
    );
  }
  return null;
}
