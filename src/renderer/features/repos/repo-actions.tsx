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
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/cn';
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
// Removing is the caller's job: it asks for an inline confirmation first.
export function useRepoActions(
  repo: RepositorySummary,
  onRemove: () => void,
) {
  const pin = usePinRepository();
  const reveal = useRevealRepository();
  const copy = useCopyRepositoryPath();
  const refresh = useRefreshRepositories();
  const locate = useLocateRepository();
  const link = useLinkRemote();
  const { data: auth } = useAuthStatus();
  const present = repo.availability === 'available';

  const actions: Action[] = [
    {
      key: 'pin',
      label: repo.pinned ? 'Unpin' : 'Pin to sidebar',
      icon: repo.pinned ? PinOff : Pin,
      onSelect: () => pin.mutate({ id: repo.id, pinned: !repo.pinned }),
    },
    {
      key: 'reveal',
      label: fileManagerLabel(),
      icon: FolderOpen,
      disabled: !present,
      onSelect: () => reveal.mutate(repo.id),
    },
    {
      key: 'copy',
      label: 'Copy path',
      icon: Copy,
      onSelect: () => copy.mutate(repo.id),
    },
    {
      key: 'refresh',
      label: 'Refresh status',
      icon: RefreshCw,
      disabled: repo.inspecting,
      onSelect: () => refresh.mutate(repo.id),
    },
  ];
  if (!present)
    actions.push({
      key: 'locate',
      label: 'Locate folder…',
      icon: FolderSearch,
      onSelect: () => locate.mutate(repo.id),
    });
  if (present && !repo.remoteId && auth?.status === 'authenticated')
    actions.push({
      key: 'remote',
      label: 'Create private remote',
      icon: CloudUpload,
      disabled: link.isPending,
      onSelect: () => link.mutate(repo.id),
    });
  actions.push({
    key: 'remove',
    label: 'Remove from gitdesk…',
    icon: Trash2,
    danger: true,
    separatorBefore: true,
    onSelect: onRemove,
  });

  const error = [reveal, locate, link, refresh].find((m) => m.isError)?.error;
  return { actions, error };
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
