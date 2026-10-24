import {
  CloudOff,
  CloudUpload,
  Copy,
  FolderOpen,
  FolderSearch,
  Info,
  Minus,
  MoreHorizontal,
  Pencil,
  Pin,
  PinOff,
  RefreshCw,
  Trash2,
  Unlink,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import type {
  RemoteRepository,
  RepositorySummary,
} from '../../../shared/repos';
import { Button } from '../../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { useToast } from '../../components/ui/toast';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/cn';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAuthStatus,
  useCopyRepositoryPath,
  useLinkRemote,
  useLocateRepository,
  usePinRepository,
  useProvisionRemote,
  useRefreshRepositories,
  useRevealRepository,
} from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { trashName, type ManageMode } from './manage';

export type Action = {
  key: string;
  label: string;
  icon: LucideIcon;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
};

export const fileManagerLabel = () =>
  window.desktop.platform === 'darwin'
    ? 'Show in Finder'
    : window.desktop.platform === 'win32'
      ? 'Show in Explorer'
      : 'Open folder';

// One list of actions for the overflow menu and the right-click menu, so they never disagree.
// Anything that needs a confirmation or a form opens it inline through `open`. A menu closes as
// soon as an item is chosen, so the row shows `busy` while the work runs and a toast reports how
// it ended; nothing finishes silently. Actions that can't apply are left out, not shown disabled.
export function useRepoActions(
  repo: RepositorySummary,
  open: (mode: ManageMode) => void,
  remote: RemoteRepository | null = null,
) {
  const pin = usePinRepository();
  const reveal = useRevealRepository();
  const copy = useCopyRepositoryPath();
  const refresh = useRefreshRepositories();
  const locate = useLocateRepository();
  const link = useLinkRemote();
  const toast = useToast();
  const { data: auth } = useAuthStatus();
  const present = repo.availability === 'available';
  const failed = (title: string) => (err: unknown) =>
    toast({
      tone: 'danger',
      title,
      description: ipcErrorMessage(err, 'Try again in a moment.'),
    });

  const actions: Action[] = [
    {
      key: 'rename',
      label: 'Rename or describe…',
      icon: Pencil,
      onSelect: () => open('rename'),
    },
    {
      key: 'pin',
      label: repo.pinned ? 'Unpin' : 'Pin to top',
      icon: repo.pinned ? PinOff : Pin,
      disabled: pin.isPending,
      onSelect: () =>
        pin.mutate(
          { id: repo.id, pinned: !repo.pinned },
          {
            onError: failed(
              `Couldn't ${repo.pinned ? 'unpin' : 'pin'} ${repo.name}`,
            ),
          },
        ),
    },
  ];
  if (present)
    actions.push({
      key: 'reveal',
      label: fileManagerLabel(),
      icon: FolderOpen,
      disabled: reveal.isPending,
      onSelect: () =>
        reveal.mutate(repo.id, { onError: failed("Couldn't open the folder") }),
    });
  actions.push(
    {
      key: 'copy',
      label: 'Copy path',
      icon: Copy,
      onSelect: () =>
        copy.mutate(repo.id, {
          onSuccess: () => toast({ tone: 'success', title: 'Path copied' }),
          onError: failed("Couldn't copy the path"),
        }),
    },
    {
      key: 'refresh',
      label: 'Refresh status',
      icon: RefreshCw,
      disabled: repo.inspecting || refresh.isPending,
      onSelect: () =>
        refresh.mutate(repo.id, {
          onError: failed(`Couldn't check ${repo.name}`),
        }),
    },
  );
  if (!present)
    actions.push({
      key: 'locate',
      label: 'Locate folder…',
      icon: FolderSearch,
      disabled: locate.isPending,
      onSelect: () =>
        locate.mutate(repo.id, {
          onSuccess: (found) => {
            if (found.status === 'located')
              toast({
                tone: 'success',
                title: `${found.repository.name} found again`,
              });
            else if (found.status === 'different')
              toast({
                tone: 'danger',
                title: 'That folder holds a different repository',
                description: `Its history starts at ${found.found ?? 'no commit'}, not ${found.expected}. Open ${repo.name} and locate it there to use that folder anyway.`,
              });
          },
          onError: failed("Couldn't use that folder"),
        }),
    });
  if (repo.remoteId)
    actions.push({
      key: 'unlink',
      label: 'Disconnect remote…',
      icon: Unlink,
      onSelect: () => open('unlink'),
    });
  else if (present && auth?.status === 'authenticated')
    actions.push({
      key: 'remote',
      label: 'Create private remote',
      icon: CloudUpload,
      disabled: link.isPending,
      onSelect: () =>
        link.mutate(repo.id, {
          onSuccess: () =>
            toast({
              tone: 'success',
              title: `Private remote created for ${repo.name}`,
            }),
          onError: failed("The remote wasn't created"),
        }),
    });
  actions.push({
    key: 'remove',
    label: 'Remove from gitdesk…',
    icon: Minus,
    separatorBefore: true,
    onSelect: () => open('remove'),
  });
  if (present)
    actions.push({
      key: 'trash',
      label: `Move folder to ${trashName()}…`,
      icon: Trash2,
      danger: true,
      onSelect: () => open('trash'),
    });
  if (remote && auth?.status === 'authenticated')
    actions.push({
      key: 'delete-remote',
      label: 'Delete remote repository…',
      icon: CloudOff,
      danger: true,
      onSelect: () => open('delete-remote'),
    });

  const busy = pin.isPending
    ? repo.pinned
      ? 'Unpinning…'
      : 'Pinning…'
    : reveal.isPending
      ? 'Opening folder…'
      : locate.isPending
        ? 'Waiting for a folder…'
        : link.isPending
          ? 'Creating remote…'
          : refresh.isPending
            ? 'Checking…'
            : null;
  return { actions, busy, reveal };
}

// A repository that only exists in the account: everything here is a server call.
export function useRemoteActions(
  remote: RemoteRepository,
  open: (mode: ManageMode) => void,
) {
  const { navigate } = useNavigation();
  const provision = useProvisionRemote();
  const toast = useToast();
  const actions: Action[] = [
    {
      key: 'details',
      label: 'View details',
      icon: Info,
      onSelect: () => navigate({ name: 'remote-repository', id: remote.id }),
    },
  ];
  if (remote.status !== 'deleting')
    actions.push({
      key: 'edit',
      label: 'Rename or describe…',
      icon: Pencil,
      onSelect: () => open('edit-remote'),
    });
  if (remote.status === 'failed' || remote.status === 'provisioning')
    actions.push({
      key: 'provision',
      label: 'Retry storage setup',
      icon: RefreshCw,
      disabled: provision.isPending,
      onSelect: () =>
        provision.mutate(remote.id, {
          onSuccess: (next) =>
            toast(
              next.status === 'ready'
                ? { tone: 'success', title: `${remote.name} is ready` }
                : {
                    tone: 'danger',
                    title: `Storage for ${remote.name} still isn't ready`,
                  },
            ),
          onError: (err) =>
            toast({
              tone: 'danger',
              title: "Storage setup didn't run",
              description: ipcErrorMessage(err, 'Try again in a moment.'),
            }),
        }),
    });
  actions.push({
    key: 'delete-remote',
    label:
      remote.status === 'deleting'
        ? 'Finish deleting…'
        : 'Delete remote repository…',
    icon: CloudOff,
    danger: true,
    separatorBefore: true,
    onSelect: () => open('delete-remote'),
  });
  return {
    actions,
    busy: provision.isPending ? 'Setting up storage…' : null,
  };
}

export function RepoMenuButton({
  name,
  actions,
  className,
}: {
  name: string;
  actions: Action[];
  className?: string;
}) {
  return (
    <DropdownMenu>
      <Tooltip label="More actions" side="left">
        <DropdownMenuTrigger asChild>
          <Button
            variant="ghost"
            size="icon"
            aria-label={`More actions for ${name}`}
            className={className}
          >
            <MoreHorizontal />
          </Button>
        </DropdownMenuTrigger>
      </Tooltip>
      <DropdownMenuContent align="end">
        {actions.map((action) => (
          <Fragment key={action.key}>
            {action.separatorBefore && <DropdownMenuSeparator />}
            <DropdownMenuItem
              disabled={action.disabled}
              onSelect={action.onSelect}
              className={cn(action.danger && 'text-danger [&_svg]:text-danger')}
            >
              <action.icon />
              {action.label}
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

export function RepoContextMenu({
  actions,
  onOpen,
  children,
}: {
  actions: Action[];
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent>
        <ContextMenuItem onSelect={onOpen}>
          <FolderOpen />
          Open
        </ContextMenuItem>
        <ContextMenuSeparator />
        {actions.map((action) => (
          <Fragment key={action.key}>
            {action.separatorBefore && <ContextMenuSeparator />}
            <ContextMenuItem
              disabled={action.disabled}
              onSelect={action.onSelect}
              className={cn(action.danger && 'text-danger [&_svg]:text-danger')}
            >
              <action.icon />
              {action.label}
            </ContextMenuItem>
          </Fragment>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}
