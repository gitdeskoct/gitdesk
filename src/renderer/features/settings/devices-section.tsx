import { CircleCheck } from 'lucide-react';
import type { AuthStatus } from '../../../shared/ipc';
import { DevicesArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { InlineStatus, Loading } from '../../components/ui/status';
import { formatDate, relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useRevokeOtherSessions,
  useRevokeSession,
  useSessions,
  useSignIn,
} from '../../lib/queries';
import { PageTitle } from '../shell/page';

export function DevicesSection({ status }: { status: AuthStatus }) {
  const signedIn = status.status === 'authenticated';
  const sessions = useSessions(signedIn);
  const revoke = useRevokeSession();
  const revokeOthers = useRevokeOtherSessions();
  const signIn = useSignIn();

  if (status.status === 'signed-out') {
    return (
      <EmptyState
        art={<DevicesArt />}
        title="Sign in to see your devices"
        action={
          <Button pending={signIn.isPending} onClick={() => signIn.mutate()}>
            Sign in
          </Button>
        }
      >
        Once you are signed in, every computer using your account is listed
        here.
      </EmptyState>
    );
  }

  const title = (
    <PageTitle title="Devices">
      Computers where your account is signed in.
    </PageTitle>
  );
  if (!signedIn) {
    return (
      <>
        {title}
        <InlineStatus tone="warning">
          Devices load when gitdesk can reach the server again.
        </InlineStatus>
      </>
    );
  }
  if (sessions.isPending)
    return (
      <>
        {title}
        <Loading label="Loading devices…" />
      </>
    );
  if (sessions.isError) {
    return (
      <>
        {title}
        <InlineStatus
          tone="danger"
          action={
            <Button
              size="sm"
              pending={sessions.isFetching}
              onClick={() => void sessions.refetch()}
            >
              Try again
            </Button>
          }
        >
          {ipcErrorMessage(sessions.error, "Couldn't load your devices.")}
        </InlineStatus>
      </>
    );
  }

  const list = [...sessions.data].sort(
    (a, b) => Number(b.current) - Number(a.current),
  );
  return (
    <>
      {title}
      <div id="devices" className="scroll-mt-6">
        <SettingGroup>
          {list.map((session) => (
            <SettingRow
              key={session.id}
              label={session.deviceName}
              description={
                session.current
                  ? `This device. Signed in ${formatDate(session.createdAt)}.`
                  : `Last used ${relativeTime(session.lastUsedAt)}. Signed in ${formatDate(session.createdAt)}.`
              }
            >
              {session.current ? (
                <span className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-success">
                  <CircleCheck className="size-4" aria-hidden />
                  Current
                </span>
              ) : (
                <Button
                  variant="danger"
                  size="sm"
                  pending={revoke.isPending && revoke.variables === session.id}
                  onClick={() => revoke.mutate(session.id)}
                >
                  {revoke.isPending && revoke.variables === session.id
                    ? 'Signing out device…'
                    : 'Sign out'}
                </Button>
              )}
            </SettingRow>
          ))}
        </SettingGroup>
      </div>
      {list.length > 1 && (
        <div className="mt-4 flex justify-end">
          <Button
            size="sm"
            pending={revokeOthers.isPending}
            onClick={() =>
              revokeOthers.mutate(
                list.filter((s) => !s.current).map((s) => s.id),
              )
            }
          >
            {revokeOthers.isPending
              ? 'Signing out…'
              : 'Sign out all other devices'}
          </Button>
        </div>
      )}
      {(revoke.isError || revokeOthers.isError) && (
        <InlineStatus tone="danger" className="mt-4">
          {ipcErrorMessage(
            revoke.error ?? revokeOthers.error,
            "Couldn't sign out every device. Try again.",
          )}
        </InlineStatus>
      )}
      {list.length === 1 && (
        <EmptyState
          compact
          art={<DevicesArt />}
          title="Only this device"
          className="mt-4"
          action={
            <Button
              size="sm"
              pending={sessions.isFetching}
              onClick={() => void sessions.refetch()}
            >
              Check again
            </Button>
          }
        >
          Other computers appear here after you sign in on them.
        </EmptyState>
      )}
    </>
  );
}
