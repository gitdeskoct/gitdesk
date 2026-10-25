import { CircleAlert, CircleCheck } from 'lucide-react';
import type { AuthStatus } from '../../../shared/ipc';
import type { Settings } from '../../../shared/settings';
import { RemoteArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { Segmented } from '../../components/ui/segmented';
import { Switch } from '../../components/ui/switch';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import {
  useRefreshRemote,
  useRemoteOverview,
  useSettings,
  useSignIn,
  useUpdateSettings,
} from '../../lib/queries';
import { PageTitle } from '../shell/page';

const REMOTE_NAMES: { value: Settings['hostingRemoteName']; label: string }[] =
  [
    { value: 'auto', label: 'origin if free' },
    { value: 'gitdesk', label: 'gitdesk' },
    { value: 'none', label: "Don't add" },
  ];

// Segmented values are strings; the setting stores seconds.
const LIFETIMES = [
  { value: '900', label: '15 min' },
  { value: '3600', label: '1 hour' },
  { value: '28800', label: '8 hours' },
] as const;

export function HostingSection({ status }: { status: AuthStatus }) {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const overview = useRemoteOverview();
  const refresh = useRefreshRemote();
  const signIn = useSignIn();
  if (!settings) return null;

  const title = (
    <PageTitle title="Git hosting">
      Repositories linked to your account get a private Git URL. gitdesk signs
      each fetch, push and clone to it with a short-lived token.
    </PageTitle>
  );

  if (status.status === 'signed-out' || settings.localOnly)
    return (
      <>
        {title}
        <EmptyState
          art={<RemoteArt />}
          title="Sign in to use Git hosting"
          action={
            <Button pending={signIn.isPending} onClick={() => signIn.mutate()}>
              Sign in
            </Button>
          }
        >
          Git URLs belong to repositories in your account, so they need a
          signed-in account and gitdesk not set to local-only.
        </EmptyState>
      </>
    );

  const hosting = overview.data?.gitHosting ?? null;
  return (
    <>
      {title}
      <SettingGroup title="This server">
        <SettingRow
          id="hosting-status"
          label="Git hosting"
          description={
            hosting === true
              ? 'Cloudflare Artifacts, on the gitdesk server you sign in to.'
              : hosting === false
                ? 'The gitdesk server has it turned off. Linked repositories keep their names and activity but get no Git URL.'
                : "The server hasn't said yet. It answers with the next account refresh."
          }
        >
          {hosting === null ? (
            <Button
              size="sm"
              pending={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              Check now
            </Button>
          ) : (
            <span className="inline-flex items-center gap-3">
              <span className="inline-flex items-center gap-1.5 text-sm font-medium text-ink">
                {hosting ? (
                  <CircleCheck aria-hidden className="size-4 text-success" />
                ) : (
                  <CircleAlert aria-hidden className="size-4 text-warning" />
                )}
                {hosting ? 'Available' : 'Off'}
              </span>
              {/* A server that turns hosting on would otherwise show up only at the next
                  automatic refresh, up to 10 minutes later. */}
              {!hosting && (
                <Button
                  size="sm"
                  pending={refresh.isPending}
                  onClick={() => refresh.mutate()}
                >
                  Check again
                </Button>
              )}
            </span>
          )}
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Linking">
        <SettingRow
          id="hosting-auto-remote"
          label="Create a private remote for new projects"
          description="Adding or cloning a project gives it a private remote in your account and adds its Git URL. Added while signed out, it gets one right after you sign in. Nothing is pushed until you publish."
        >
          <Switch
            aria-label="Create a private remote for new projects"
            checked={settings.autoHostedRemote}
            onCheckedChange={(autoHostedRemote) =>
              update.mutate({ autoHostedRemote })
            }
          />
        </SettingRow>
        <SettingRow
          id="hosting-remote-name"
          label="Add the Git URL as"
          description='When you link a repository. "origin if free" uses origin when the repository has none and gitdesk otherwise. An existing remote is never replaced; Move to gitdesk on a repository&apos;s Remotes tab switches one that points elsewhere.'
        >
          <Segmented
            label="Add the Git URL as"
            value={settings.hostingRemoteName}
            options={REMOTE_NAMES}
            onChange={(hostingRemoteName) =>
              update.mutate({ hostingRemoteName })
            }
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Terminal access">
        <SettingRow
          id="hosting-token-lifetime"
          label="Token lifetime for copied commands"
          description="Copy terminal command puts a token on the command line. A shorter life limits what a leaked command can do."
        >
          <Segmented
            label="Token lifetime"
            value={String(settings.hostingTokenLifetime)}
            options={LIFETIMES}
            onChange={(value) =>
              update.mutate({
                hostingTokenLifetime: Number(
                  value,
                ) as Settings['hostingTokenLifetime'],
              })
            }
          />
        </SettingRow>
        <SettingRow
          id="hosting-own-tokens"
          label="Tokens gitdesk uses itself"
          description="Last 15 minutes and live only in memory, never on disk or in .git/config. Read-only for fetch and clone, write only for push."
        />
      </SettingGroup>
    </>
  );
}
