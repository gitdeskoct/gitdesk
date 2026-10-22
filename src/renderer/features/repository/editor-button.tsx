import { Code2 } from 'lucide-react';
import type { EditorId } from '../../../shared/settings';
import { Button } from '../../components/ui/button';
import { useToast } from '../../components/ui/toast';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useEditors,
  useOpenInEditor,
  useRepoPreferences,
  useSettings,
} from '../../lib/queries';

// The editor this repository opens in: its own choice, else the app setting.
export function useEditorName(repoId: string): { id: EditorId; name: string } {
  const { data: settings } = useSettings();
  const { data: prefs } = useRepoPreferences(repoId);
  const { data: editors } = useEditors();
  const id = prefs?.editor ?? settings?.editor ?? 'system';
  const found = editors?.find((editor) => editor.id === id);
  return {
    id,
    name: id === 'system' || !found ? 'default app' : found.name,
  };
}

export function OpenInEditorButton({
  repoId,
  path,
  line = null,
  size = 'sm',
  variant = 'secondary',
}: {
  repoId: string;
  path: string | null;
  line?: number | null;
  size?: 'sm' | 'md';
  variant?: 'secondary' | 'ghost';
}) {
  const open = useOpenInEditor(repoId);
  const toast = useToast();
  const editor = useEditorName(repoId);
  return (
    <Button
      size={size}
      variant={variant}
      pending={open.isPending}
      onClick={() =>
        open.mutate(
          { path, line },
          {
            onError: (err) =>
              toast({
                tone: 'danger',
                title: "Couldn't open it",
                description: ipcErrorMessage(
                  err,
                  'Try another editor in Settings, Code editor.',
                ),
              }),
          },
        )
      }
    >
      {!open.isPending && <Code2 />}
      {editor.id === 'system' ? 'Open' : `Open in ${editor.name}`}
    </Button>
  );
}
