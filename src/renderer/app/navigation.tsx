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
  | 'workspace'
  | 'git'
  | 'shortcuts'
  | 'account'
  | 'devices'
  | 'about';
export type RepoShow = 'all' | 'changed' | 'ahead' | 'behind' | 'problems';
// Where a repository lives. Counts overlap: a linked repository is local and remote at once.
export type RepoScope = 'all' | 'local' | 'remote' | 'linked';
export type Route =
  | { name: 'home' | 'pulls' | 'issues' }
  // `show` and `scope` let Home's statistics open the list already filtered.
  | { name: 'repositories'; show?: RepoShow; scope?: RepoScope }
  // A registered repository, by gitdesk's id; the path stays in main.
  | { name: 'repository'; id: string }
  // A repository in the account with no registration on this computer, by its remote id.
  | { name: 'remote-repository'; id: string }
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
