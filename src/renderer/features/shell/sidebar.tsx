import { motion } from 'framer-motion';
import {
  CircleDot,
  Folder,
  GitPullRequest,
  House,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import type { AuthStatus } from '../../../shared/ipc';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/cn';
import { useMotionAllowed } from '../../lib/queries';
import { useNavigation, type Route } from '../../app/navigation';
import { AccountMenu } from './account-menu';

type Item = {
  route: Route['name'];
  label: string;
  icon: LucideIcon;
  soon?: boolean;
};

const code: Item[] = [
  { route: 'repositories', label: 'Repositories', icon: Folder, soon: true },
  { route: 'pulls', label: 'Pull requests', icon: GitPullRequest, soon: true },
  { route: 'issues', label: 'Issues', icon: CircleDot, soon: true },
];

export function NavItem({
  label,
  icon: Icon,
  active,
  collapsed,
  trailing,
  onSelect,
}: {
  label: string;
  icon: LucideIcon;
  active: boolean;
  collapsed: boolean;
  trailing?: string;
  onSelect: () => void;
}) {
  return (
    <Tooltip label={label} disabled={!collapsed}>
      <button
        type="button"
        onClick={onSelect}
        aria-current={active ? 'page' : undefined}
        aria-label={collapsed ? label : undefined}
        className={cn(
          'flex h-8 shrink-0 items-center gap-2.5 rounded-sm text-[0.84375rem] text-muted transition-colors hover:bg-sunken hover:text-ink',
          collapsed ? 'w-8.5 justify-center' : 'w-full px-2.5',
          active &&
            'bg-surface font-medium text-ink shadow-[0_0_0_1px_var(--line)] hover:bg-surface [&>svg]:text-accent',
        )}
      >
        <Icon className="size-4 shrink-0" aria-hidden />
        {!collapsed && <span className="truncate">{label}</span>}
        {!collapsed && trailing && (
          <span className="ml-auto text-xs text-muted">{trailing}</span>
        )}
      </button>
    </Tooltip>
  );
}

export function Sidebar({
  status,
  collapsed,
}: {
  status: AuthStatus;
  collapsed: boolean;
}) {
  const { route, navigate } = useNavigation();
  const motionAllowed = useMotionAllowed();

  return (
    <motion.nav
      aria-label="Main"
      initial={false}
      animate={{ width: collapsed ? 52 : 232 }}
      transition={{ duration: motionAllowed ? 0.18 : 0, ease: 'easeOut' }}
      className={cn(
        'flex flex-none flex-col gap-0.5 overflow-hidden pt-1 pb-2.5',
        collapsed ? 'items-center px-2' : 'px-2.5',
      )}
    >
      <NavItem
        label="Home"
        icon={House}
        active={route.name === 'home'}
        collapsed={collapsed}
        onSelect={() => navigate({ name: 'home' })}
      />
      {collapsed ? (
        <div aria-hidden className="my-2.5 h-px w-5.5 bg-line" />
      ) : (
        <div className="px-2.5 pt-3.5 pb-1 text-xs font-medium text-muted">
          Code
        </div>
      )}
      {code.map((item) => (
        <NavItem
          key={item.route}
          label={item.label}
          icon={item.icon}
          active={route.name === item.route}
          collapsed={collapsed}
          trailing={item.soon ? 'Soon' : undefined}
          onSelect={() => navigate({ name: item.route } as Route)}
        />
      ))}
      <div className="flex-1" />
      <NavItem
        label="Settings"
        icon={Settings}
        active={route.name === 'settings'}
        collapsed={collapsed}
        onSelect={() => navigate({ name: 'settings', section: 'general' })}
      />
      <AccountMenu status={status} collapsed={collapsed} />
    </motion.nav>
  );
}
