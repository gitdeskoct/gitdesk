import * as Menubar from '@radix-ui/react-menubar';
import {
  ClipboardPaste,
  CloudDownload,
  Copy,
  Folder,
  FolderOpen,
  House,
  Info,
  Keyboard,
  LogIn,
  LogOut,
  Maximize,
  Minus,
  PanelLeft,
  Palette,
  Plus,
  Power,
  Redo2,
  RefreshCw,
  Scissors,
  Search,
  Settings,
  TextSelect,
  Undo2,
  type LucideIcon,
} from 'lucide-react';
import { useRef, type ReactNode } from 'react';
import type { WindowCommand } from '../../../shared/ipc';
import { useAppActions, windowCommand } from '../../app/use-app-actions';
import { useNavigation } from '../../app/navigation';
import { useCheckForUpdates } from '../../lib/update-queries';
import {
  useAuthStatus,
  useOpenLogs,
  useSignIn,
  useSignOut,
} from '../../lib/queries';
import { modLabel, shortcutText, type ShortcutId } from '../../lib/shortcuts';
import { useToast } from '../../components/ui/toast';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { accountOf } from './account-menu';

const contentClass =
  'z-50 min-w-60 rounded-sm border border-line bg-surface p-1.5 text-[0.84375rem] shadow-[0_8px_24px_-12px_rgb(0_0_0/0.35)]';

function Item({
  icon: Icon,
  label,
  hint,
  onSelect,
}: {
  icon: LucideIcon;
  label: string;
  hint?: string;
  onSelect: () => void;
}) {
  return (
    <Menubar.Item
      onSelect={onSelect}
      className="flex h-8 cursor-default items-center gap-2.5 rounded-sm px-2 text-ink outline-none select-none data-[disabled]:opacity-50 data-[highlighted]:bg-control"
    >
      <Icon className="size-4 text-muted" aria-hidden />
      <span className="flex-1">{label}</span>
      {hint && <span className="text-xs text-muted tabular-nums">{hint}</span>}
    </Menubar.Item>
  );
}

const Separator = () => <Menubar.Separator className="my-1.5 h-px bg-line" />;

function Menu({
  label,
  children,
  keepFocus,
}: {
  label: string;
  children: ReactNode;
  keepFocus?: boolean;
}) {
  return (
    <Menubar.Menu>
      <Menubar.Trigger className="h-7 rounded-sm px-2.5 text-[0.8125rem] text-muted outline-none select-none hover:bg-hover hover:text-ink focus-visible:outline-2 focus-visible:outline-accent data-[state=open]:bg-hover data-[state=open]:text-ink">
        {label}
      </Menubar.Trigger>
      <Menubar.Portal>
        <Menubar.Content
          align="start"
          sideOffset={6}
          className={contentClass}
          // Edit commands act on whatever had focus before the menu opened, so don't move focus back to the trigger.
          onCloseAutoFocus={
            keepFocus ? (event) => event.preventDefault() : undefined
          }
        >
          {children}
        </Menubar.Content>
      </Menubar.Portal>
    </Menubar.Menu>
  );
}

const EDIT: {
  command: WindowCommand;
  label: string;
  icon: LucideIcon;
  key: string;
}[] = [
  { command: 'undo', label: 'Undo', icon: Undo2, key: 'Z' },
  { command: 'redo', label: 'Redo', icon: Redo2, key: 'Y' },
  { command: 'cut', label: 'Cut', icon: Scissors, key: 'X' },
  { command: 'copy', label: 'Copy', icon: Copy, key: 'C' },
  { command: 'paste', label: 'Paste', icon: ClipboardPaste, key: 'V' },
  { command: 'selectAll', label: 'Select all', icon: TextSelect, key: 'A' },
];

// In-window menu bar for Windows and Linux; main removes the native menu there. macOS keeps its own.
export function AppMenu({ inShell }: { inShell: boolean }) {
  const run = useAppActions();
  const { navigate } = useNavigation();
  const { data: status } = useAuthStatus();
  const signIn = useSignIn();
  const signOut = useSignOut();
  const openLogs = useOpenLogs();
  const checkUpdates = useCheckForUpdates();
  const toast = useToast();
  // Menu items close on select, so a failure has to be reported somewhere that stays.
  const failed = (title: string) => (err: unknown) =>
    toast({
      tone: 'danger',
      title,
      description: ipcErrorMessage(err, 'Try again in a moment.'),
    });
  const lastFocus = useRef<HTMLElement | null>(null);
  const signedIn = !!accountOf(status);
  const hint = (id: ShortcutId) => shortcutText(id);

  const edit = (command: WindowCommand) => {
    lastFocus.current?.focus();
    windowCommand(command);
  };

  return (
    <Menubar.Root
      className="no-drag flex items-center gap-0.5"
      onPointerDownCapture={() => {
        if (document.activeElement instanceof HTMLElement)
          lastFocus.current = document.activeElement;
      }}
    >
      <Menu label="File">
        {inShell && (
          <>
            <Item
              icon={Plus}
              label="New repository…"
              hint={hint('newRepository')}
              onSelect={() => run('newRepository')}
            />
            <Item
              icon={FolderOpen}
              label="Open repository…"
              hint={hint('openRepository')}
              onSelect={() => run('openRepository')}
            />
            <Item
              icon={CloudDownload}
              label="Clone repository…"
              hint={hint('cloneRepository')}
              onSelect={() => run('cloneRepository')}
            />
            <Separator />
            <Item
              icon={Settings}
              label="Settings"
              hint={hint('settings')}
              onSelect={() => run('settings')}
            />
            <Separator />
          </>
        )}
        {signedIn ? (
          <Item
            icon={LogOut}
            label="Sign out"
            onSelect={() =>
              signOut.mutate(undefined, {
                onError: failed("Couldn't sign out"),
              })
            }
          />
        ) : (
          <Item
            icon={LogIn}
            label="Sign in with Google"
            onSelect={() =>
              signIn.mutate(undefined, {
                onError: failed("Couldn't start sign-in"),
              })
            }
          />
        )}
        <Separator />
        <Item
          icon={Power}
          label="Quit gitdesk"
          hint={hint('quit')}
          onSelect={() => run('quit')}
        />
      </Menu>
      <Menu label="Edit" keepFocus>
        {EDIT.map((item, index) => (
          <div key={item.command} className="contents">
            {index === 2 && <Separator />}
            <Item
              icon={item.icon}
              label={item.label}
              hint={`${modLabel()}+${item.key}`}
              onSelect={() => edit(item.command)}
            />
          </div>
        ))}
      </Menu>
      <Menu label="View">
        {inShell && (
          <>
            <Item
              icon={House}
              label="Home"
              hint={hint('goHome')}
              onSelect={() => run('goHome')}
            />
            <Item
              icon={Folder}
              label="Repositories"
              hint={hint('goRepositories')}
              onSelect={() => run('goRepositories')}
            />
            <Item
              icon={RefreshCw}
              label="Check status again"
              hint={hint('refresh')}
              onSelect={() => run('refresh')}
            />
            <Separator />
            <Item
              icon={PanelLeft}
              label="Toggle sidebar"
              hint={hint('toggleSidebar')}
              onSelect={() => run('toggleSidebar')}
            />
            <Separator />
          </>
        )}
        <Item
          icon={Plus}
          label="Zoom in"
          hint={hint('zoomIn')}
          onSelect={() => run('zoomIn')}
        />
        <Item
          icon={Minus}
          label="Zoom out"
          hint={hint('zoomOut')}
          onSelect={() => run('zoomOut')}
        />
        <Item
          icon={Search}
          label="Actual size"
          hint={hint('zoomReset')}
          onSelect={() => run('zoomReset')}
        />
        <Separator />
        <Item
          icon={Maximize}
          label="Toggle full screen"
          hint={hint('fullScreen')}
          onSelect={() => run('fullScreen')}
        />
        {inShell && (
          <Item
            icon={Palette}
            label="Appearance"
            onSelect={() =>
              navigate({ name: 'settings', section: 'appearance' })
            }
          />
        )}
      </Menu>
      <Menu label="Help">
        {inShell && (
          <Item
            icon={Keyboard}
            label="Keyboard shortcuts"
            onSelect={() =>
              navigate({ name: 'settings', section: 'shortcuts' })
            }
          />
        )}
        <Item
          icon={FolderOpen}
          label="Open logs folder"
          onSelect={() =>
            openLogs.mutate(undefined, {
              onError: failed("Couldn't open the logs folder"),
            })
          }
        />
        {inShell && (
          <>
            <Separator />
            <Item
              icon={RefreshCw}
              label="Check for updates"
              onSelect={() => {
                // The page shows the result; a failure lands there as a band.
                navigate({ name: 'settings', section: 'updates' });
                checkUpdates.mutate(undefined);
              }}
            />
            <Item
              icon={Info}
              label="About gitdesk"
              onSelect={() => navigate({ name: 'settings', section: 'about' })}
            />
          </>
        )}
      </Menu>
    </Menubar.Root>
  );
}
