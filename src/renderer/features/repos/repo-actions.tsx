import {
  CloudUpload,
  Copy,
  FolderOpen,
  FolderSearch,
  MoreHorizontal,
  Pin,
  PinOff,
  RefreshCw,
  Trash2,
  type LucideIcon,
} from 'lucide-react';
import { Fragment, type ReactNode } from 'react';
import type { RepositorySummary } from '../../../shared/repos';
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
  useRefreshRepositories,
  useRevealRepository,
} from '../../lib/queries';

type Action = {
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
// Removing is the caller's job: it asks for an inline confirmation first. A menu closes as soon
// as an item is chosen, so the row shows `busy` while the work runs and a toast reports how it
// ended; nothing finishes silently.
export function useRepoActions(repo: RepositorySummary, onRemove: () => void) {
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
    {
      key: 'reveal',
      label: fileManagerLabel(),
      icon: FolderOpen,
      disabled: !present || reveal.isPending,
      onSelect: () =>
        reveal.mutate(repo.id, { onError: failed("Couldn't open the folder") }),
    },
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
  ];
  if (!present)
    actions.push({
      key: 'locate',
      label: 'Locate folder…',
      icon: FolderSearch,
      disabled: locate.isPending,
      onSelect: () =>
        locate.mutate(repo.id, {
          onSuccess: (found) =>
            found &&
            toast({ tone: 'success', title: `${found.name} found again` }),
          onError: failed("Couldn't use that folder"),
        }),
    });
  if (present && !repo.remoteId && auth?.status === 'authenticated')
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
    icon: Trash2,
    danger: true,
    separatorBefore: true,
    onSelect: onRemove,
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

export function RepoMenuButton({
  repo,
  actions,
  className,
}: {
  repo: RepositorySummary;
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
            aria-label={`More actions for ${repo.name}`}
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
