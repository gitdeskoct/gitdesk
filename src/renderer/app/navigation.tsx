import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';

export type SettingsSection =
  | 'general'
  | 'appearance'
  | 'code'
  | 'workspace'
  | 'editor'
  | 'git'
  | 'shortcuts'
  | 'pulls'
  | 'account'
  | 'hosting'
  | 'devices'
  | 'about';
export type RepoTab =
  | 'changes'
  | 'history'
  | 'branches'
  | 'pulls'
  | 'remotes'
  | 'overview'
  | 'settings';
export type PullTab = 'overview' | 'files' | 'commits' | 'activity' | 'merge';
export type RepoShow = 'all' | 'changed' | 'ahead' | 'behind' | 'problems';
// Where a repository lives. Counts overlap: a linked repository is local and remote at once.
export type RepoScope = 'all' | 'local' | 'remote' | 'linked';
export type Route =
  | { name: 'home' | 'pulls' | 'issues' }
  // `show` and `scope` let Home's statistics open the list already filtered.
  | { name: 'repositories'; show?: RepoShow; scope?: RepoScope }
  // A registered repository, by gitdesk's id; the path stays in main. Without a tab it opens on
  // the repository's own "opens on" choice.
  | { name: 'repository'; id: string; tab?: RepoTab }
  // A repository in the account with no registration on this computer, by its remote id.
  | { name: 'remote-repository'; id: string }
  // One pull request inside its repository; the repository and its tab stay one click away.
  | { name: 'pull-request'; repoId: string; id: string; tab?: PullTab }
  | { name: 'settings'; section: SettingsSection; row?: string };

type Navigation = { route: Route; navigate: (route: Route) => void };

const NavigationContext = createContext<Navigation | null>(null);

// In-memory routes: there are only a handful, and no URL is ever shared or deep-linked.
export function NavigationProvider({ children }: { children: ReactNode }) {
  const [route, setRoute] = useState<Route>({ name: 'home' });
  const navigate = useCallback((next: Route) => {
    setRoute(next);
    // A row id in the hash drives the :target highlight in SettingRow. In-page hash changes never fire will-navigate.
    // Only a real hash change updates :target, so clear first, then set it once the row has rendered.
    const hash = next.name === 'settings' && next.row ? `#${next.row}` : '';
    if (location.hash) history.replaceState(null, '', location.pathname);
    if (hash) requestAnimationFrame(() => (location.hash = hash));
  }, []);
  const value = useMemo(() => ({ route, navigate }), [route, navigate]);
  return (
    <NavigationContext.Provider value={value}>
      {children}
    </NavigationContext.Provider>
  );
}

export function useNavigation(): Navigation {
  const value = useContext(NavigationContext);
  if (!value) throw new Error('useNavigation outside NavigationProvider');
  return value;
}
