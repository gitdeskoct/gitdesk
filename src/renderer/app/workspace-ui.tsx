import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useState,
  type ReactNode,
} from 'react';
import type { AddRepositoryResult } from '../../shared/repos';
import { useToast } from '../components/ui/toast';
import { ipcErrorMessage } from '../lib/ipc-error';
import { useAddRepository } from '../lib/queries';
import { useNavigation } from './navigation';

export type Panel = 'create' | 'clone' | null;

// A notice from the last "Open repository": shown inline on the page, never in a modal.
// "Already in gitdesk" is a toast instead, because that case navigates straight to the repository.
export type AddNotice =
  | { kind: 'not-a-repository'; displayPath: string; token: string }
  | { kind: 'error'; message: string };

type WorkspaceUi = {
  panel: Panel;
  setPanel: (panel: Panel) => void;
  notice: AddNotice | null;
  dismissNotice: () => void;
  // Starts the native folder picker; the result lands in `notice` or opens the repository.
  addRepository: () => void;
  adding: boolean;
};

const Context = createContext<WorkspaceUi | null>(null);

// Shared by the header buttons, the menu bar and the keyboard shortcuts, so each entry point
// behaves the same way.
export function WorkspaceUiProvider({ children }: { children: ReactNode }) {
  const { navigate } = useNavigation();
  const toast = useToast();
  // mutate is stable across renders; the mutation object itself is not.
  const { mutate, isPending } = useAddRepository();
  const [panel, setPanel] = useState<Panel>(null);
  const [notice, setNotice] = useState<AddNotice | null>(null);

  const addRepository = useCallback(() => {
    if (isPending) return;
    setNotice(null);
    mutate(undefined, {
      onSuccess: (result: AddRepositoryResult) => {
        if (result.status === 'not-a-repository')
          setNotice({ kind: 'not-a-repository', ...result });
        if (result.status === 'exists')
          toast({ title: `${result.repository.name} was already in gitdesk` });
        if (result.status === 'added' || result.status === 'exists')
          navigate({ name: 'repository', id: result.repository.id });
      },
      onError: (err) =>
        setNotice({
          kind: 'error',
          message: ipcErrorMessage(err, "Couldn't open that folder."),
        }),
    });
  }, [mutate, isPending, navigate, toast]);

  const value = useMemo(
    () => ({
      panel,
      setPanel,
      notice,
      dismissNotice: () => setNotice(null),
      addRepository,
      adding: isPending,
    }),
    [panel, notice, addRepository, isPending],
  );
  return <Context.Provider value={value}>{children}</Context.Provider>;
}

export function useWorkspaceUi(): WorkspaceUi {
  const value = useContext(Context);
  if (!value) throw new Error('useWorkspaceUi outside WorkspaceUiProvider');
  return value;
}
