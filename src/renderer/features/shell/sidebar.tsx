import { motion } from 'framer-motion';
import {
  CircleDot,
  Folder,
  FolderGit2,
  FolderX,
  GitPullRequest,
  House,
  Pin,
  RefreshCw,
  Settings,
  type LucideIcon,
} from 'lucide-react';
import { useMemo } from 'react';
import type { AuthStatus } from '../../../shared/ipc';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/cn';
import {
  useMotionAllowed,
  useRepositories,
  useSettings,
} from '../../lib/queries';
import { byRecent, changeCount } from '../../lib/repo-status';
import { useNavigation, type Route } from '../../app/navigation';
import { useOpenRepo } from '../repos/repo-row';
import { AccountMenu } from './account-menu';

type Item = {
  route: Route['name'];
  label: string;
  icon: LucideIcon;
  soon?: boolean;
};

const code: Item[] = [
  { route: 'repositories', label: 'Repositories', icon: Folder },
  { route: 'pulls', label: 'Pull requests', icon: GitPullRequest },
  { route: 'sync-activity', label: 'Sync activity', icon: RefreshCw },
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
        // Active is a solid raised fill and an accent icon, no outline; hover is a step darker than the canvas.
        className={cn(
          'flex h-8 shrink-0 items-center gap-2.5 rounded-sm text-[0.84375rem] text-muted transition-colors hover:bg-hover hover:text-ink',
          collapsed ? 'w-8.5 justify-center' : 'w-full px-2.5',
          active &&
            'bg-raised font-medium text-ink hover:bg-raised [&>svg]:text-accent',
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

// Pinned first, then the most recently opened: the repositories you'd otherwise reach through
// Repositories. The count is Git's own, from the last status check; nothing is shown before one.
function RecentRepositories() {
  const { route } = useNavigation();
  const openRepo = useOpenRepo();
  const { data: settings } = useSettings();
  const repos = useRepositories();
  const limit = settings?.sidebarRecent ?? 5;
  const list = useMemo(
    () =>
      [...(repos.data ?? [])]
        .sort(byRecent)
        .sort((a, b) => Number(b.pinned) - Number(a.pinned))
        .slice(0, limit),
    [repos.data, limit],
  );
  if (!list.length) return <div className="flex-1" />;
  const pinned = list.some((repo) => repo.pinned);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div
        id="sidebar-recent"
        className="px-2.5 pt-3.5 pb-1 text-xs font-medium text-muted"
      >
        {pinned ? 'Pinned and recent' : 'Recent'}
      </div>
      <ul
        aria-labelledby="sidebar-recent"
        className="-mx-1 grid min-h-0 content-start gap-0.5 overflow-y-auto px-1 pb-2"
      >
        {list.map((repo) => {
          const changes = changeCount(repo.status);
          const missing = repo.availability !== 'available';
          const Icon = missing ? FolderX : repo.pinned ? Pin : FolderGit2;
          const active = route.name === 'repository' && route.id === repo.id;
          return (
            <li key={repo.id}>
              <button
                type="button"
                onClick={() => openRepo(repo.id)}
                aria-current={active ? 'page' : undefined}
                title={repo.name}
                className={cn(
                  'flex h-8 w-full items-center gap-2.5 rounded-sm px-2.5 text-[0.84375rem] text-muted transition-colors hover:bg-hover hover:text-ink',
                  active && 'bg-raised font-medium text-ink hover:bg-raised',
                )}
              >
                <Icon
                  aria-hidden
                  className={cn(
                    'size-4 shrink-0',
                    missing && 'text-danger',
                    active && !missing && 'text-accent',
                  )}
                />
                <span className="truncate">{repo.name}</span>
                {missing ? (
                  <span className="sr-only">, folder missing</span>
                ) : (
                  changes > 0 && (
                    <span className="ml-auto text-xs text-muted tabular-nums">
                      {changes}
                      <span className="sr-only"> changed</span>
                    </span>
                  )
                )}
              </button>
            </li>
          );
        })}
      </ul>
    </div>
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
        'flex flex-none flex-col gap-0.5 overflow-hidden pt-3 pb-2.5',
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
          active={
            route.name === item.route ||
            (item.route === 'repositories' &&
              (route.name === 'repository' ||
                route.name === 'remote-repository' ||
                route.name === 'pull-request'))
          }
          collapsed={collapsed}
          trailing={item.soon ? 'Soon' : undefined}
          onSelect={() => navigate({ name: item.route } as Route)}
        />
      ))}
      {collapsed ? <div className="flex-1" /> : <RecentRepositories />}
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
