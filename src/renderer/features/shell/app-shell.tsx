import type { AuthStatus } from '../../../shared/ipc';
import { useSettings } from '../../lib/queries';
import { useNavigation, type Route } from '../../app/navigation';
import { HomePage } from '../home/home-page';
import { NotBuiltPage } from '../not-built/not-built-page';
import { PullRequestPage } from '../pulls/pull-request-page';
import { SyncActivityPage } from '../sync/sync-activity-page';
import { PullsPage } from '../pulls/pulls-page';
import { RepositoriesPage } from '../repos/repositories-page';
import { RemoteRepositoryPage } from '../repository/remote-repository-page';
import { RepositoryPage } from '../repository/repository-page';
import { SettingsLayout } from '../settings/settings-layout';
import { PageErrorBoundary } from './page';
import { Sidebar } from './sidebar';
import { TitleBar } from './title-bar';

function routeKey(route: Route): string {
  if (route.name === 'repository' || route.name === 'remote-repository')
    return `${route.name}:${route.id}`;
  // The tab is left out so switching tabs never remounts the review.
  if (route.name === 'pull-request') return `pull-request:${route.id}`;
  if (route.name === 'repositories')
    return `repositories:${route.show ?? 'all'}:${route.scope ?? 'all'}`;
  return route.name;
}

function RoutePage({ route, status }: { route: Route; status: AuthStatus }) {
  switch (route.name) {
    case 'home':
      return <HomePage status={status} />;
    case 'repositories':
      return (
        <RepositoriesPage
          initialShow={route.show ?? 'all'}
          initialScope={route.scope ?? 'all'}
        />
      );
    case 'repository':
      return (
        <RepositoryPage
          id={route.id}
          tab={route.tab}
          newPull={route.newPull}
          source={route.source}
        />
      );
    case 'remote-repository':
      return (
        <RemoteRepositoryPage
          id={route.id}
          view={route.view}
          source={route.source}
        />
      );
    case 'pull-request':
      return (
        <PullRequestPage repoId={route.repoId} id={route.id} tab={route.tab} />
      );
    case 'pulls':
      return <PullsPage />;
    case 'sync-activity':
      return <SyncActivityPage />;
    case 'settings':
      return <SettingsLayout status={status} section={route.section} />;
    default:
      return <NotBuiltPage name={route.name} />;
  }
}

// Full height, no gaps: title bar and navigation share the canvas; the page surface runs to the window edges.
export function AppShell({ status }: { status: AuthStatus }) {
  const { route } = useNavigation();
  const collapsed = useSettings().data?.sidebarCollapsed ?? false;
  const inSettings = route.name === 'settings';

  return (
    <div className="flex h-full flex-col bg-canvas">
      <TitleBar sidebarToggle={!inSettings} inShell />
      <div className="flex min-h-0 flex-1">
        {!inSettings && <Sidebar status={status} collapsed={collapsed} />}
        {/* Keyed by route so a page that crashed recovers once you navigate away. */}
        <PageErrorBoundary key={inSettings ? 'settings' : routeKey(route)}>
          <RoutePage route={route} status={status} />
        </PageErrorBoundary>
      </div>
    </div>
  );
}
