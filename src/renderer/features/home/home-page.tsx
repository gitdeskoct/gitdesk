import type { AuthStatus } from '../../../shared/ipc';
import { Button } from '../../components/ui/button';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { Loading } from '../../components/ui/status';
import { useGitIdentity, useSignIn } from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { accountOf } from '../shell/account-menu';
import { Page, PageTitle } from '../shell/page';

function GitIdentityRow() {
  const { navigate } = useNavigation();
  const identity = useGitIdentity();
  const toGit = () =>
    navigate({ name: 'settings', section: 'git', row: 'git-identity' });

  if (identity.isPending) return <Loading label="Reading your Git identity…" />;
  if (identity.isError || !identity.data.available) {
    return (
      <SettingRow
        label="Git"
        description="Git isn't installed on this computer, so commits can't be made yet."
      >
        <Button size="sm" onClick={toGit}>
          See how to install
        </Button>
      </SettingRow>
    );
  }
  const { name, email } = identity.data;
  return (
    <SettingRow
      label="Git identity"
      description={
        name && email
          ? `Commits are signed as ${name} <${email}>.`
          : 'Name and email written into every commit on this computer.'
      }
    >
      <Button size="sm" onClick={toGit}>
        {name && email ? 'Change' : 'Set up'}
      </Button>
    </SettingRow>
  );
}

export function HomePage({ status }: { status: AuthStatus }) {
  const { navigate } = useNavigation();
  const signIn = useSignIn();
  const account = accountOf(status);
  const firstName = account?.displayName.split(/\s+/)[0];

  return (
    <Page crumbs={[{ label: 'Home' }]}>
      <PageTitle
        title={account ? `Good to see you, ${firstName}` : 'Working locally'}
      >
        {status.status === 'authenticated' && 'Signed in on this device.'}
        {status.status === 'offline' &&
          "You're offline. Local Git keeps working."}
        {!account &&
          'Local Git works without an account. Sign in to reach remote repositories later.'}
      </PageTitle>
      <SettingGroup title="Before your first commit">
        <GitIdentityRow />
        {account ? (
          <SettingRow
            label="Signed-in devices"
            description="See where you are signed in and sign out other computers."
          >
            <Button
              variant="link"
              onClick={() => navigate({ name: 'settings', section: 'devices' })}
            >
              Manage
            </Button>
          </SettingRow>
        ) : (
          <SettingRow
            label="Account"
            description="Sign in with Google to use private remote repositories when they arrive."
          >
            <Button
              size="sm"
              pending={signIn.isPending}
              onClick={() => signIn.mutate()}
            >
              Sign in
            </Button>
          </SettingRow>
        )}
        <SettingRow
          label="Repositories"
          description="Opening, cloning and creating repositories arrive in the next feature."
        >
          <span className="text-[0.8125rem] text-muted">Not built yet</span>
        </SettingRow>
      </SettingGroup>
    </Page>
  );
}
