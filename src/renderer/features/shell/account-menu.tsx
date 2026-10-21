import { ChevronsUpDown, Laptop, Lock, LogOut, User } from 'lucide-react';
import type { AccountSummary, AuthStatus } from '../../../shared/ipc';
import { Avatar } from '../../components/ui/avatar';
import { Button } from '../../components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { useToast } from '../../components/ui/toast';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/cn';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useSignIn, useSignOut } from '../../lib/queries';
import { useNavigation } from '../../app/navigation';

export const accountOf = (
  status: AuthStatus | undefined,
): AccountSummary | null =>
  status?.status === 'authenticated' || status?.status === 'offline'
    ? status.account
    : null;

function storageNote(status: AuthStatus): string {
  if (status.status === 'offline')
    return 'Offline. Showing your last known account';
  if (status.status === 'authenticated' && status.persistence === 'memory')
    return 'Session kept in memory until you quit';
  return 'Session kept in the system keychain';
}

export function AccountMenu({
  status,
  collapsed,
}: {
  status: AuthStatus;
  collapsed: boolean;
}) {
  const { navigate } = useNavigation();
  const signIn = useSignIn();
  const signOut = useSignOut();
  const toast = useToast();
  const account = accountOf(status);

  if (!account) {
    return (
      <div className="mt-1.5 border-t border-line pt-2.5">
        <Tooltip label="Sign in" disabled={!collapsed}>
          <Button
            size={collapsed ? 'icon' : 'sm'}
            className={cn(!collapsed && 'w-full')}
            pending={signIn.isPending}
            aria-label={collapsed ? 'Sign in' : undefined}
            onClick={() => signIn.mutate()}
          >
            {collapsed ? !signIn.isPending && <User /> : 'Sign in'}
          </Button>
        </Tooltip>
      </div>
    );
  }

  return (
    <div
      className={cn(
        'mt-1.5 border-t border-line pt-1.5',
        collapsed ? 'w-8.5' : 'w-full',
      )}
    >
      <DropdownMenu>
        <DropdownMenuTrigger
          className={cn(
            'flex w-full items-center gap-2.5 rounded-sm text-left hover:bg-hover',
            collapsed ? 'justify-center py-1.5' : 'p-2',
          )}
          aria-label={`Account: ${account.displayName}`}
        >
          <Avatar name={account.displayName} src={account.avatarUrl} />
          {!collapsed && (
            <>
              <span className="min-w-0 flex-1 text-[0.8125rem] leading-snug">
                <span className="block truncate font-medium text-ink">
                  {account.displayName}
                </span>
                <span className="block truncate text-muted">
                  {account.email}
                </span>
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted" />
            </>
          )}
        </DropdownMenuTrigger>
        <DropdownMenuContent side="top" align="start" className="w-64">
          <DropdownMenuLabel>
            <div className="truncate font-medium text-ink">
              {account.displayName}
            </div>
            <div className="truncate text-[0.8125rem] text-muted">
              {account.email}
            </div>
            <div className="mt-2 flex items-center gap-1.5 text-xs text-muted">
              <Lock className="size-3.5" aria-hidden />
              {storageNote(status)}
            </div>
          </DropdownMenuLabel>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            onSelect={() => navigate({ name: 'settings', section: 'account' })}
          >
            <User />
            Account settings
          </DropdownMenuItem>
          <DropdownMenuItem
            onSelect={() => navigate({ name: 'settings', section: 'devices' })}
          >
            <Laptop />
            Devices
          </DropdownMenuItem>
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={signOut.isPending}
            onSelect={() =>
              signOut.mutate(undefined, {
                onError: (err) =>
                  toast({
                    tone: 'danger',
                    title: "Couldn't sign out",
                    description: ipcErrorMessage(err, 'Try again in a moment.'),
                  }),
              })
            }
          >
            <LogOut />
            Sign out
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  );
}
