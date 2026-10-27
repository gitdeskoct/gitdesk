import { Check, Link2, SquareTerminal } from 'lucide-react';
import { useState } from 'react';
import type { RepositorySummary } from '../../../shared/repos';
import type { RemoteInfo } from '../../../shared/workspace';
import { OfflineArt, RemoteArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { InlineStatus } from '../../components/ui/status';
import { useToast } from '../../components/ui/toast';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAddHostedRemote,
  useAuthStatus,
  useCopyGitCommand,
  useLinkRemote,
  useProvisionRemote,
  useRemoteOverview,
  useRemoteRepository,
  useRevokeGitTokens,
  useSignIn,
} from '../../lib/queries';
import { GitUrlField } from './git-url';
import { REMOTE_STATUS, Section } from './history';

const LIFETIME_WORDS: Record<number, string> = {
  900: '15 minutes',
  3600: '1 hour',
  28_800: '8 hours',
};

// The same remote whatever spelling Git kept: parsing lowercases the host; a trailing / is ignored.
export function sameGitUrl(a: string, b: string): boolean {
  try {
    const clean = (value: string) => new URL(value).href.replace(/\/+$/, '');
    return clean(a) === clean(b);
  } catch {
    return false;
  }
}

const clock = (at: number) =>
  new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

// The account side of a repository: its link, its Git URL, and the tokens gitdesk hands to Git.
export function HostedRemoteSection({
  repo,
  gitRemotes,
  tokenLifetime,
}: {
  repo: RepositorySummary;
  gitRemotes: RemoteInfo[] | undefined;
  tokenLifetime: number;
}) {
  const { data: auth } = useAuthStatus();
  const { data: overview } = useRemoteOverview();
  const signedIn = auth?.status === 'authenticated';
  // Shares its cache with the repository header, so this is no extra request.
  const query = useRemoteRepository(
    repo.remoteId ?? '',
    !!repo.remoteId && signedIn,
  );
  const remote = query.data ?? null;
  const signIn = useSignIn();
  const link = useLinkRemote();
  const provision = useProvisionRemote();
  const addRemote = useAddHostedRemote(repo.id);
  const copy = useCopyGitCommand();
  const revoke = useRevokeGitTokens();
  const toast = useToast();
  const [confirmRevoke, setConfirmRevoke] = useState(false);

  if (!repo.remoteId)
    return (
      <Section
        id="account-link-heading"
        title="Hosted in your account"
        meta="Not linked"
      >
        <EmptyState
          compact
          className="border-t border-line"
          art={<RemoteArt />}
          title="Not linked to your account"
          action={
            signedIn ? (
              <Button
                size="sm"
                pending={link.isPending}
                onClick={() => link.mutate(repo.id)}
              >
                Create private remote
              </Button>
            ) : (
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
          Link it to get a private Git URL you can push to and clone from.
        </EmptyState>
        {link.isError && (
          <InlineStatus tone="danger" className="mt-3">
            {ipcErrorMessage(link.error, "The remote wasn't created.")}
          </InlineStatus>
        )}
      </Section>
    );

  if (!remote)
    return (
      <Section
        id="account-link-heading"
        title="Hosted in your account"
        meta="Linked"
      >
        <EmptyState
          compact
          className="border-t border-line"
          art={<OfflineArt />}
          title={
            signedIn
              ? query.isPending
                ? 'Loading the link'
                : "Couldn't load the link"
              : 'Sign in to see it'
          }
          action={
            signedIn ? (
              <Button
                size="sm"
                pending={query.isFetching}
                onClick={() => void query.refetch()}
              >
                Try again
              </Button>
            ) : (
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
          {signedIn
            ? query.isPending
              ? 'Asking your account for this repository.'
              : ipcErrorMessage(
                  query.error,
                  'The gitdesk server did not answer.',
                )
            : 'This repository is linked to your account. Its Git URL shows once you are signed in.'}
        </EmptyState>
      </Section>
    );

  const url = remote.gitUrl;
  const added = url
    ? gitRemotes?.find((entry) => sameGitUrl(entry.fetchUrl, url))
    : undefined;
  const hostingOff = overview?.gitHosting === false;

  return (
    <Section
      id="account-link-heading"
      title="Hosted in your account"
      meta="Private · only you can fetch or push"
    >
      <dl className="grid grid-cols-[9rem_minmax(0,1fr)] items-center gap-x-4 gap-y-2.5 border-y border-line py-3 text-sm">
        <dt className="text-muted">Linked remote</dt>
        <dd className="min-w-0 text-ink">
          {remote.name} · {REMOTE_STATUS[remote.status].label}
        </dd>
        <dt className="self-start pt-1.5 text-muted">Git URL</dt>
        <dd className="min-w-0">
          {url ? (
            <>
              <GitUrlField url={url} />
              <div className="mt-1 text-xs text-muted">
                Holds no password. Copying it is safe.
              </div>
            </>
          ) : hostingOff ? (
            <span className="text-muted">
              None. The gitdesk server doesn't have Git hosting turned on.
            </span>
          ) : (
            <span className="flex flex-wrap items-center gap-3">
              <span className="text-muted">Not set up yet.</span>
              <Button
                size="sm"
                pending={provision.isPending}
                onClick={() => provision.mutate(remote.id)}
              >
                Set up the Git URL
              </Button>
            </span>
          )}
        </dd>
        {url && (
          <>
            <dt className="text-muted">In this repository</dt>
            <dd className="flex min-w-0 items-center gap-3">
              {added ? (
                <span className="inline-flex items-center gap-1.5 font-medium text-ink">
                  <Check aria-hidden className="size-3.5 text-success" />
                  Added as{' '}
                  <span className="font-mono text-[0.8125rem]">
                    {added.name}
                  </span>
                </span>
              ) : (
                <Button
                  size="sm"
                  pending={addRemote.isPending}
                  onClick={() =>
                    addRemote.mutate(undefined, {
                      onSuccess: (result) =>
                        toast({
                          tone: 'success',
                          title: result.added
                            ? `Added as ${result.name}`
                            : `Already added as ${result.name}`,
                        }),
                    })
                  }
                >
                  {!addRemote.isPending && <Link2 />}
                  Add as a Git remote
                </Button>
              )}
            </dd>
            <dt className="self-start text-muted">How gitdesk signs in</dt>
            <dd className="text-ink">
              Each fetch, push and clone gets a token from your account that
              lasts 15 minutes. It is passed to Git for that command only and
              never written to .git/config.
            </dd>
          </>
        )}
      </dl>

      {(provision.isError || addRemote.isError) && (
        <InlineStatus tone="danger" className="mt-3">
          {ipcErrorMessage(
            provision.error ?? addRemote.error,
            "That didn't work. Try again.",
          )}
        </InlineStatus>
      )}

      {url && (
        <div className="mt-3 flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            pending={copy.isPending}
            onClick={() =>
              copy.mutate(repo.id, {
                onSuccess: ({ expiresAt }) =>
                  toast({
                    tone: 'success',
                    title: 'Push command copied',
                    description: `Its token works until ${clock(expiresAt)}.`,
                  }),
              })
            }
          >
            {!copy.isPending && <SquareTerminal />}
            Copy terminal command
          </Button>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => setConfirmRevoke(true)}
          >
            Revoke tokens
          </Button>
          <span className="text-xs text-muted">
            Git saves a {LIFETIME_WORDS[tokenLifetime] ?? '1 hour'} token in
            your configured credential helper, then the command uses plain
            <code className="mx-1">git push</code>. Anyone with that helper
            entry can push until it expires.
          </span>
        </div>
      )}

      {copy.isError && (
        <InlineStatus tone="danger" className="mt-3">
          {ipcErrorMessage(copy.error, "The command wasn't copied.")}
        </InlineStatus>
      )}

      {confirmRevoke && (
        <div
          role="alert"
          className="mt-3 flex flex-wrap items-center gap-3 bg-danger-soft px-3 py-2.5 text-[0.8125rem] text-ink"
        >
          <span className="min-w-0 flex-1">
            <b className="font-semibold">
              Revoke every token for {remote.name}?
            </b>{' '}
            Copied terminal commands stop working. gitdesk gets a new token the
            next time it fetches.
          </span>
          <Button
            size="sm"
            variant="danger"
            pending={revoke.isPending}
            onClick={() =>
              revoke.mutate(repo.id, {
                onSuccess: ({ revoked }) => {
                  setConfirmRevoke(false);
                  toast({
                    tone: 'success',
                    title:
                      revoked === 1
                        ? 'Revoked 1 token'
                        : `Revoked ${revoked} tokens`,
                  });
                },
              })
            }
          >
            Revoke tokens
          </Button>
          <Button size="sm" onClick={() => setConfirmRevoke(false)}>
            Keep them
          </Button>
        </div>
      )}
      {revoke.isError && (
        <InlineStatus tone="danger" className="mt-3">
          {ipcErrorMessage(revoke.error, "The tokens weren't revoked.")}
        </InlineStatus>
      )}
    </Section>
  );
}
