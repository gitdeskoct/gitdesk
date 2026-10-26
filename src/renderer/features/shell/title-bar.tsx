import { PanelLeft } from 'lucide-react';
import { Logo, LogoMark } from '../../components/brand/logo';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/cn';
import { AppMenu } from './app-menu';
import { UpdateIndicator } from './update-indicator';
import {
  useMotionAllowed,
  useSettings,
  useUpdateSettings,
} from '../../lib/queries';

// 44px, the canvas color main gives the native overlay, so the window controls blend in.
// macOS keeps its traffic lights on the left; Windows and Linux draw their controls on the right.
export function TitleBar({
  brand = true,
  sidebarToggle = true,
  inShell = false,
}: {
  brand?: boolean;
  sidebarToggle?: boolean;
  inShell?: boolean;
}) {
  const mac = window.desktop.platform === 'darwin';
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const motion = useMotionAllowed();
  const collapsed = settings?.sidebarCollapsed ?? false;

  return (
    <header
      className={cn(
        'drag flex h-11 flex-none items-center gap-2 bg-canvas',
        mac ? 'pl-20' : 'pl-3',
        mac ? 'pr-3' : 'pr-36',
      )}
    >
      {brand &&
        (collapsed && sidebarToggle ? (
          <span className="px-1.5 text-ink">
            <LogoMark size={24} animate={motion} />
          </span>
        ) : (
          <Logo
            size={24}
            animate={motion}
            className="px-1.5"
            wordmarkClassName="text-[0.9375rem]"
          />
        ))}
      {sidebarToggle && (
        <Tooltip
          label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
          side="bottom"
        >
          <Button
            variant="ghost"
            size="icon"
            className="no-drag"
            aria-label={collapsed ? 'Show sidebar' : 'Hide sidebar'}
            aria-pressed={!collapsed}
            onClick={() => update.mutate({ sidebarCollapsed: !collapsed })}
          >
            <PanelLeft />
          </Button>
        </Tooltip>
      )}
      {!mac && <AppMenu inShell={inShell} />}
      {inShell && (
        <span className="ml-auto flex items-center">
          <UpdateIndicator />
        </span>
      )}
    </header>
  );
}
