import {
  CloudDownload,
  Clock,
  MoreHorizontal,
  Pencil,
  RefreshCw,
  Trash2,
} from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  descriptionSchema,
  repositoryNameSchema,
  type RemoteListInput,
  type RemoteRepository,
} from '../../../shared/repos';
import { OfflineArt, RemoteArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { EmptyState } from '../../components/ui/empty-state';
import { Segmented } from '../../components/ui/segmented';
import { InlineStatus, Loading } from '../../components/ui/status';
import { TextField } from '../../components/ui/text-field';
import { useToast } from '../../components/ui/toast';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAuthStatus,
  useDeleteRemote,
  useRefreshRemote,
  useRemoteList,
  useRemoteOverview,
  useRepositories,
  useSettings,
  useSignIn,
  useUpdateRemote,
} from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { useWorkspaceUi } from '../../app/workspace-ui';
import { useOpenRepo } from './repo-row';
import { SidePanel } from './side-panel';

const editSchema = z.object({
  name: repositoryNameSchema,
  description: descriptionSchema,
});

// Seconds until main allows the next manual refresh; the button says so instead of failing.
function useWait(until: number | null): number {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (!until || until <= Date.now()) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until) clearInterval(timer);
    }, 1000);
    return () => clearInterval(timer);
  }, [until]);
  return until ? Math.max(0, Math.ceil((until - now) / 1000)) : 0;
}

function EditRow({
  repo,
  onDone,
}: {
  repo: RemoteRepository;
  onDone: () => void;
}) {
  const update = useUpdateRemote();
  const toast = useToast();
  const [values, setValues] = useState({
    name: repo.name,
    description: repo.description ?? '',
  });
  const [errors, setErrors] = useState<{ name?: string; description?: string }>(
    {},
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = editSchema.safeParse(values);
    if (!parsed.success) {
      const fields = z.flattenError(parsed.error).fieldErrors;
      return setErrors({
        name: fields.name?.[0],
        description: fields.description?.[0],
      });
    }
    const name = parsed.data.name === repo.name ? undefined : parsed.data.name;
    const description =
      (parsed.data.description || null) === repo.description
        ? undefined
        : parsed.data.description || null;
    if (name === undefined && description === undefined) return onDone();
    update.mutate(
      { id: repo.id, name, description },
      {
        onSuccess: () => {
          toast({ tone: 'success', title: 'Remote details saved' });
          onDone();
        },
      },
    );
  };
  return (
    <form
      onSubmit={submit}
      noValidate
      className="grid gap-3 border-b border-line py-3"
    >
      <TextField
        label="Name"
        value={values.name}
        onChange={(event) =>
          setValues((v) => ({ ...v, name: event.target.value }))
        }
        error={errors.name}
        spellCheck={false}
        autoComplete="off"
        maxLength={100}
      />
      <TextField
        label="Description"
        value={values.description}
        onChange={(event) =>
          setValues((v) => ({ ...v, description: event.target.value }))
        }
        error={errors.description}
        hint="One line, up to 280 characters."
        maxLength={280}
      />
      {update.isError && (
        <InlineStatus tone="danger">
          {ipcErrorMessage(update.error, "Those details weren't saved.")}
        </InlineStatus>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          pending={update.isPending}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// Deleting a remote can't be undone, so the name must be typed. It stays inline: the app's CSP
// blocks the style tag a modal's scroll lock injects, and DESIGN.md keeps dialogs out of routine work.
function DeleteRow({
  repo,
  onDone,
}: {
  repo: RemoteRepository;
  onDone: () => void;
}) {
  const remove = useDeleteRemote();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === repo.name;
  return (
    <div
      role="group"
      aria-label={`Delete ${repo.name}`}
      className="grid gap-3 border-b border-line bg-danger-soft px-3 py-3"
    >
      <p className="text-[0.8125rem] leading-relaxed text-ink">
        Delete <b className="font-semibold">{repo.name}</b> from your account?
        This can't be undone. Local folders and their history stay on your
        computers.
      </p>
      <TextField
        label={`Type ${repo.name} to confirm`}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        spellCheck={false}
        autoComplete="off"
        autoFocus
      />
      {remove.isError && (
        <InlineStatus tone="danger">
          {ipcErrorMessage(remove.error, "The remote wasn't deleted.")}
        </InlineStatus>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="danger"
          pending={remove.isPending}
          aria-disabled={!matches || undefined}
          onClick={() =>
            matches &&
            remove.mutate(repo.id, {
              onSuccess: () => {
                toast({
                  tone: 'success',
                  title: `${repo.name} deleted from your account`,
                });
                onDone();
              },
            })
          }
        >
          Delete remote
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function RemoteRow({ repo }: { repo: RemoteRepository }) {
  const { data: local } = useRepositories();
  const { setPanel } = useWorkspaceUi();
  const openRepo = useOpenRepo();
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view');
  const linked = local?.find((l) => l.remoteId === repo.id);
  if (mode === 'edit')
    return (
      <li>
        <EditRow repo={repo} onDone={() => setMode('view')} />
      </li>
    );
  return (
    <li>
      <div className="flex items-center gap-2 border-b border-line py-3">
        <div className="min-w-0 flex-1">
          <div className="truncate text-sm font-semibold text-ink">
            {repo.name}
          </div>
          <div className="truncate text-xs text-muted">
            {repo.description ||
              `Private · updated ${relativeTime(repo.updatedAt)}`}
          </div>
        </div>
        {linked ? (
          <Button size="sm" onClick={() => openRepo(linked.id)}>
            Open
          </Button>
        ) : (
          <Button size="sm" onClick={() => setPanel('clone')}>
            <CloudDownload />
            Clone
          </Button>
        )}
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              aria-label={`More actions for ${repo.name}`}
            >
              <MoreHorizontal />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuItem onSelect={() => setMode('edit')}>
              <Pencil />
              Edit details
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem
              onSelect={() => setMode('delete')}
              className="text-danger [&_svg]:text-danger"
            >
              <Trash2 />
              Delete remote…
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>
      {mode === 'delete' && (
        <DeleteRow repo={repo} onDone={() => setMode('view')} />
      )}
    </li>
  );
}

export function RemotePanel({ onClose }: { onClose: () => void }) {
  const { navigate } = useNavigation();
  const { setPanel } = useWorkspaceUi();
  const { data: auth } = useAuthStatus();
  const { data: settings } = useSettings();
  const signedIn = auth?.status === 'authenticated' && !settings?.localOnly;
  const overview = useRemoteOverview();
  const refresh = useRefreshRemote();
  const signIn = useSignIn();
  const [sort, setSort] = useState<RemoteListInput['sort']>('updated');
  const list = useRemoteList(sort, signedIn);
  const remote = overview.data;
  const wait = useWait(remote?.nextRefreshAt ?? null);
  const repos = list.data?.pages.flatMap((page) => page.repositories) ?? [];

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
          Remote repositories need an account connection.
        </EmptyState>
      );
    if (auth?.status === 'offline' || remote?.error === 'offline')
      return (
        <EmptyState
          compact
          art={<OfflineArt />}
          title="You're offline"
          action={
            <Button
              size="sm"
              pending={refresh.isPending}
              onClick={() => refresh.mutate()}
            >
              Try again
            </Button>
          }
        >
          Local repositories keep working; the remote list loads once you're
          back.
        </EmptyState>
      );
    if (!signedIn)
      return (
        <EmptyState
          compact
          art={<RemoteArt />}
          title="Sign in to see your remote"
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
    if (list.isPending) return <Loading label="Loading remote repositories…" />;
    if (list.isError)
      return (
        <EmptyState
          compact
          art={<OfflineArt />}
          title="Can't load your remote"
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
          {ipcErrorMessage(
            list.error,
            'The server did not answer; your local work is unaffected.',
          )}
        </EmptyState>
      );
    if (!repos.length)
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
          Create a repository with "Also create a private remote" to add one.
        </EmptyState>
      );
    return (
      <>
        <ul className="border-t border-line">
          {repos.map((repo) => (
            <RemoteRow key={repo.id} repo={repo} />
          ))}
        </ul>
        {list.hasNextPage && (
          <Button
            size="sm"
            className="mt-4"
            pending={list.isFetchingNextPage}
            onClick={() => void list.fetchNextPage()}
          >
            Load more
          </Button>
        )}
      </>
    );
  };

  return (
    <SidePanel title="Remote repositories" onClose={onClose}>
      {signedIn && (
        <div className="mb-4 grid gap-3">
          <div className="flex items-center justify-between gap-3 text-[0.8125rem] text-muted">
            <span className="flex min-w-0 items-center gap-1.5">
              {remote?.state === 'cached' && (
                <Clock aria-hidden className="size-3.5 shrink-0 text-warning" />
              )}
              <span className="truncate">
                {remote?.fetchedAt
                  ? `${remote.state === 'cached' ? 'Cached' : 'Updated'} ${relativeTime(remote.fetchedAt)}${remote.total !== null ? ` · ${remote.total} in total` : ''}`
                  : 'Your gitdesk account'}
              </span>
            </span>
            <Button
              variant="ghost"
              size="sm"
              pending={refresh.isPending || list.isRefetching}
              aria-disabled={wait > 0 || undefined}
              onClick={() => {
                if (wait > 0) return;
                refresh.mutate();
                void list.refetch();
              }}
            >
              {!(refresh.isPending || list.isRefetching) && <RefreshCw />}
              {wait > 0 ? `${wait}s` : 'Refresh'}
            </Button>
          </div>
          <Segmented
            label="Sort"
            value={sort}
            onChange={setSort}
            options={[
              { value: 'updated', label: 'Recently updated' },
              { value: 'name', label: 'Name' },
            ]}
          />
        </div>
      )}
      {body()}
      {remote?.error === 'rate-limited' && (
        <InlineStatus tone="warning" className="mt-4">
          The server asked gitdesk to slow down. The list refreshes again
          shortly.
        </InlineStatus>
      )}
    </SidePanel>
  );
}
