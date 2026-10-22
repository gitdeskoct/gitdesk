import { JobProgress } from '../../components/ui/job-progress';
import * as RadioGroup from '@radix-ui/react-radio-group';
import { Check, Lock } from 'lucide-react';
import { useState } from 'react';
import {
  repositoryNameSchema,
  type RemoteRepository,
} from '../../../shared/repos';
import { OfflineArt, RemoteArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { InlineStatus, Loading } from '../../components/ui/status';
import { TextField } from '../../components/ui/text-field';
import { useToast } from '../../components/ui/toast';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAuthStatus,
  useCancelClone,
  useChooseLocation,
  useJobProgress,
  useCloneRepository,
  useRemoteList,
  useRepositories,
  useSettings,
  useSignIn,
} from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { useWorkspaceUi } from '../../app/workspace-ui';
import { useOpenRepo } from './repo-row';
import { SidePanel } from './side-panel';

const BLOCKED_REASON =
  "This repository has no Git URL, so there's nothing to clone. The gitdesk server needs Git hosting turned on.";

function Running({
  jobId,
  name,
  onCancel,
}: {
  jobId: string;
  name: string;
  onCancel: () => void;
}) {
  const progress = useJobProgress(jobId);
  const cancel = useCancelClone();
  const percent = progress?.percent ?? 0;
  return (
    <div className="grid gap-4">
      <div className="grid gap-2">
        <JobProgress
          label={`Cloning ${name}`}
          stage={progress?.stage ?? 'Connecting…'}
          right={`${percent}%`}
          percent={percent}
          progress={progress}
          network
        />
        <p className="text-[0.8125rem] text-muted">
          Written to a temporary folder first, then moved into place.
        </p>
      </div>
      <div>
        <Button
          pending={cancel.isPending}
          onClick={() => cancel.mutate(jobId, { onSuccess: onCancel })}
        >
          Cancel
        </Button>
      </div>
      <p className="text-[0.8125rem] text-muted">
        Cancel removes only the temporary folder this clone made.
      </p>
    </div>
  );
}

// The whole clone flow: pick a repository from the account, pick a folder, clone with progress.
// The final step waits on the sync transport; until then the button says so instead of failing.
// `initial` preselects a repository, as when cloning from its own page.
export function ClonePanel({
  onClose,
  initial = null,
}: {
  onClose: () => void;
  initial?: RemoteRepository | null;
}) {
  const { navigate } = useNavigation();
  const { setPanel } = useWorkspaceUi();
  const { data: auth } = useAuthStatus();
  const { data: settings } = useSettings();
  const signIn = useSignIn();
  const signedIn = auth?.status === 'authenticated' && !settings?.localOnly;
  const list = useRemoteList('updated', signedIn);
  const { data: local } = useRepositories();
  const choose = useChooseLocation();
  const clone = useCloneRepository();
  const openRepo = useOpenRepo();
  const toast = useToast();
  const [picked, setPicked] = useState<RemoteRepository | null>(initial);
  const [name, setName] = useState(initial?.name ?? '');
  const [nameError, setNameError] = useState<string>();
  const [location, setLocation] = useState<{
    token: string;
    displayPath: string;
  } | null>(null);
  const [jobId, setJobId] = useState<string | null>(null);

  const remotes = list.data?.pages.flatMap((page) => page.repositories) ?? [];
  const linked = new Set(
    (local ?? []).map((repo) => repo.remoteId).filter(Boolean),
  );

  const start = () => {
    const parsed = repositoryNameSchema.safeParse(name);
    if (!parsed.success) return setNameError(parsed.error.issues[0]?.message);
    if (!picked || !location) return;
    const id = crypto.randomUUID();
    setJobId(id);
    clone.mutate(
      {
        jobId: id,
        remoteId: picked.id,
        name: parsed.data,
        locationToken: location.token,
      },
      {
        onSuccess: (result) => {
          if (result.status !== 'cloned') return;
          toast({ tone: 'success', title: `${result.repository.name} cloned` });
          onClose();
          openRepo(result.repository.id);
        },
        onSettled: () => setJobId(null),
      },
    );
  };

  const body = () => {
    if (settings?.localOnly)
      return (
        <EmptyState
          compact
          art={<RemoteArt />}
          title="gitdesk is in local-only mode"
          action={
            <Button
              size="sm"
              onClick={() =>
                navigate({
                  name: 'settings',
                  section: 'general',
                  row: 'local-only',
                })
              }
            >
              Open settings
            </Button>
          }
        >
          Cloning from your account needs an account connection.
        </EmptyState>
      );
    if (!signedIn)
      return (
        <EmptyState
          compact
          art={<RemoteArt />}
          title="Sign in to clone"
          action={
            <Button
              size="sm"
              pending={signIn.isPending}
              onClick={() => signIn.mutate()}
            >
              Sign in
            </Button>
          }
        >
          Remote repositories belong to your gitdesk account.
        </EmptyState>
      );
    if (list.isPending)
      return <Loading label="Loading your remote repositories…" />;
    if (list.isError)
      return (
        <EmptyState
          compact
          art={<OfflineArt />}
          title="Couldn't load your remote repositories"
          action={
            <Button
              size="sm"
              pending={list.isFetching}
              onClick={() => void list.refetch()}
            >
              Try again
            </Button>
          }
        >
          {ipcErrorMessage(list.error, 'The server did not answer.')}
        </EmptyState>
      );
    if (!remotes.length)
      return (
        <EmptyState
          compact
          art={<RemoteArt />}
          title="No remote repositories yet"
          action={
            <Button size="sm" onClick={() => setPanel('create')}>
              Create repository
            </Button>
          }
        >
          A repository created with a private remote can be cloned on your other
          computers.
        </EmptyState>
      );
    if (jobId && clone.isPending)
      return (
        <Running jobId={jobId} name={name} onCancel={() => setJobId(null)} />
      );

    return (
      <div className="grid gap-5">
        <div className="grid gap-1.5">
          <span id="clone-from" className="text-sm font-medium text-ink">
            From your account
          </span>
          <RadioGroup.Root
            aria-labelledby="clone-from"
            value={picked?.id ?? ''}
            onValueChange={(id) => {
              const next = remotes.find((r) => r.id === id) ?? null;
              setPicked(next);
              if (next) {
                setName(next.name);
                setNameError(undefined);
              }
            }}
            className="border-t border-line"
          >
            {remotes.map((repo) => {
              const here = linked.has(repo.id);
              return (
                <RadioGroup.Item
                  key={repo.id}
                  value={repo.id}
                  disabled={here}
                  className={cn(
                    'flex w-full items-center gap-3 border-b border-line px-1 py-2.5 text-left data-[state=checked]:bg-accent-soft',
                    here ? 'text-muted' : 'hover:bg-row-hover',
                  )}
                >
                  <span className="grid size-4 shrink-0 place-items-center text-accent">
                    <RadioGroup.Indicator>
                      <Check aria-hidden className="size-4" />
                    </RadioGroup.Indicator>
                  </span>
                  <span className="min-w-0 flex-1">
                    <span
                      className={cn(
                        'block truncate text-sm font-medium',
                        !here && 'text-ink',
                      )}
                    >
                      {repo.name}
                    </span>
                    <span className="block truncate text-xs text-muted">
                      {here
                        ? 'Already on this computer'
                        : `Private · updated ${relativeTime(repo.updatedAt)}`}
                    </span>
                  </span>
                </RadioGroup.Item>
              );
            })}
          </RadioGroup.Root>
          {list.hasNextPage && (
            <Button
              variant="link"
              className="justify-self-start text-[0.8125rem]"
              pending={list.isFetchingNextPage}
              onClick={() => void list.fetchNextPage()}
            >
              Load more
            </Button>
          )}
        </div>

        <div className="grid gap-1.5">
          <span id="clone-location" className="text-sm font-medium text-ink">
            Location
          </span>
          <div className="flex gap-2">
            <div
              aria-labelledby="clone-location"
              className="field flex h-9 min-w-0 flex-1 items-center px-3 font-mono text-[0.78125rem] text-muted"
            >
              <span className="truncate">
                {location?.displayPath ?? 'No folder chosen'}
              </span>
            </div>
            <Button
              pending={choose.isPending}
              onClick={() =>
                choose.mutate(undefined, {
                  onSuccess: (next) => next && setLocation(next),
                })
              }
            >
              Choose…
            </Button>
          </div>
        </div>

        <TextField
          label="Folder name"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setNameError(undefined);
          }}
          error={nameError}
          hint={
            location && name
              ? `Creates a folder named ${name} there. An existing folder is never touched.`
              : 'An existing folder is never touched.'
          }
          spellCheck={false}
          autoComplete="off"
          maxLength={100}
        />

        {picked && !picked.gitUrl && (
          <InlineStatus>
            <span className="flex items-start gap-2">
              <Lock
                aria-hidden
                className="mt-0.5 size-3.5 shrink-0 text-muted"
              />
              <span id="clone-blocked">{BLOCKED_REASON}</span>
            </span>
          </InlineStatus>
        )}
        {clone.data?.status === 'unavailable' && (
          <InlineStatus>{BLOCKED_REASON}</InlineStatus>
        )}
        {clone.isError && (
          <InlineStatus tone="danger">
            {ipcErrorMessage(
              clone.error,
              "The clone didn't finish. Nothing was left behind.",
            )}
          </InlineStatus>
        )}

        <div className="flex gap-2">
          <Button
            variant="primary"
            aria-disabled={!picked?.gitUrl || !location || undefined}
            aria-describedby={
              picked && !picked.gitUrl ? 'clone-blocked' : undefined
            }
            onClick={() => picked?.gitUrl && start()}
          >
            Clone
          </Button>
          <Button variant="ghost" onClick={onClose}>
            Cancel
          </Button>
        </div>
      </div>
    );
  };

  return (
    <SidePanel
      title="Clone a repository"
      onClose={onClose}
      locked={clone.isPending}
    >
      {body()}
    </SidePanel>
  );
}
