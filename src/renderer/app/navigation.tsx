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
  | 'git'
  | 'shortcuts'
  | 'account'
  | 'devices'
  | 'about';
export type Route =
  | { name: 'home' | 'repositories' | 'pulls' | 'issues' }
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
