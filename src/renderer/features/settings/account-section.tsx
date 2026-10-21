import { CircleCheck, KeyRound } from 'lucide-react';
import type { AuthStatus } from '../../../shared/ipc';
import { Avatar } from '../../components/ui/avatar';
import { Button } from '../../components/ui/button';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { useSignIn, useSignOut } from '../../lib/queries';
import { accountOf } from '../shell/account-menu';
import { PageTitle } from '../shell/page';

function StorageBadge({ status }: { status: AuthStatus }) {
  if (status.status === 'authenticated' && status.persistence === 'secure') {
    return (
      <span className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-success">
        <CircleCheck className="size-4" aria-hidden />
        Secure
      </span>
    );
  }
  return (
    <span className="flex items-center gap-1.5 text-[0.8125rem] font-semibold text-warning">
      <KeyRound className="size-4" aria-hidden />
      {status.status === 'offline' ? 'Offline' : 'Memory only'}
    </span>
  );
}

export function AccountSection({ status }: { status: AuthStatus }) {
  const signIn = useSignIn();
  const signOut = useSignOut();
  const account = accountOf(status);

  if (!account) {
    return (
      <>
        <PageTitle title="Account">
          You are using gitdesk without an account.
        </PageTitle>
        <SettingGroup>
          <SettingRow
            id="sign-in"
            label="Sign in with Google"
            description="Needed for private remote repositories. Local Git keeps working either way."
          >
            <Button
              variant="primary"
              size="sm"
              pending={signIn.isPending}
              onClick={() => signIn.mutate()}
            >
              {signIn.isPending ? 'Opening browser…' : 'Sign in'}
            </Button>
          </SettingRow>
        </SettingGroup>
      </>
    );
  }

  const storage =
    status.status === 'offline'
      ? "gitdesk can't reach the server right now. This is your last known account."
      : status.status === 'authenticated' && status.persistence === 'memory'
        ? 'No system keychain was found, so your sign-in lasts until you quit gitdesk.'
        : 'Your sign-in is encrypted in the system keychain on this computer.';

  return (
    <>
      <div className="mb-7 flex items-center gap-3.5">
        <Avatar
          name={account.displayName}
          src={account.avatarUrl}
          className="size-12 text-base"
        />
        <div className="min-w-0">
          <h1 className="truncate text-xl font-semibold tracking-[-0.02em] text-ink">
            {account.displayName}
          </h1>
          <p className="mt-0.5 truncate text-sm text-muted">
            {account.email} · Google
          </p>
        </div>
      </div>
      <SettingGroup>
        <SettingRow
          id="session-storage"
          label="Session storage"
          description={storage}
        >
          <StorageBadge status={status} />
        </SettingRow>
        <SettingRow
          id="sign-out"
          label="Sign out"
          description="Ends the session on this computer and on the server."
        >
          <Button
            variant="danger"
            size="sm"
            pending={signOut.isPending}
            onClick={() => signOut.mutate()}
          >
            {signOut.isPending ? 'Signing out…' : 'Sign out'}
          </Button>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
