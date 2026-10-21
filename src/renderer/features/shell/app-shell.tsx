import type { AuthStatus } from '../../../shared/ipc';
import { useSettings } from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { HomePage } from '../home/home-page';
import { NotBuiltPage } from '../not-built/not-built-page';
import { SettingsLayout } from '../settings/settings-layout';
import { Sidebar } from './sidebar';
import { TitleBar } from './title-bar';

// Full height, no gaps: title bar and navigation share the canvas; the page surface runs to the window edges.
export function AppShell({ status }: { status: AuthStatus }) {
  const { route } = useNavigation();
  const collapsed = useSettings().data?.sidebarCollapsed ?? false;
  const inSettings = route.name === 'settings';

  return (
    <div className="flex h-full flex-col bg-canvas">
      <TitleBar sidebarToggle={!inSettings} inShell />
      <div className="flex min-h-0 flex-1">
        {route.name === 'settings' ? (
          <SettingsLayout status={status} section={route.section} />
        ) : (
          <>
            <Sidebar status={status} collapsed={collapsed} />
            {route.name === 'home' ? (
              <HomePage status={status} />
            ) : (
              <NotBuiltPage name={route.name} />
            )}
          </>
        )}
      </div>
    </div>
  );
}
