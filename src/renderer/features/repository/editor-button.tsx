import type { ComponentProps } from 'react';
import { Code2 } from 'lucide-react';
import type { EditorId } from '../../../shared/settings';
import clionLogo from '../../assets/editors/clion.svg';
import cursorLogo from '../../assets/editors/cursor.svg';
import golandLogo from '../../assets/editors/goland.svg';
import intellijCeLogo from '../../assets/editors/intellij-idea-ce.svg';
import intellijLogo from '../../assets/editors/intellij-idea.svg';
import phpstormLogo from '../../assets/editors/phpstorm.svg';
import pycharmCeLogo from '../../assets/editors/pycharm-ce.svg';
import pycharmLogo from '../../assets/editors/pycharm.svg';
import riderLogo from '../../assets/editors/rider.svg';
import rubymineLogo from '../../assets/editors/rubymine.svg';
import rustroverLogo from '../../assets/editors/rustrover.svg';
import vscodeLogo from '../../assets/editors/vscode.svg';
import vscodiumLogo from '../../assets/editors/vscodium.svg';
import webstormLogo from '../../assets/editors/webstorm.svg';
import zedLogo from '../../assets/editors/zed.svg';
import { useShortcut } from '../../app/use-app-actions';
import { Button } from '../../components/ui/button';
import { cn } from '../../lib/cn';
import { useToast } from '../../components/ui/toast';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useEditors,
  useOpenInEditor,
  useRepoPreferences,
  useSettings,
} from '../../lib/queries';

// The vendors' own logo files (assets/editors/SOURCES.md), shown unmodified beside the name.
const LOGOS: Partial<Record<EditorId, string>> = {
  vscode: vscodeLogo,
  'vscode-insiders': vscodeLogo,
  vscodium: vscodiumLogo,
  cursor: cursorLogo,
  zed: zedLogo,
  webstorm: webstormLogo,
  intellij: intellijLogo,
  'intellij-ce': intellijCeLogo,
  pycharm: pycharmLogo,
  'pycharm-ce': pycharmCeLogo,
  phpstorm: phpstormLogo,
  goland: golandLogo,
  rider: riderLogo,
  clion: clionLogo,
  rubymine: rubymineLogo,
  rustrover: rustroverLogo,
};

export const hasEditorLogo = (id: EditorId, icon: string | null = null) =>
  id !== 'system' && !!(LOGOS[id] ?? icon);

// An editor's real logo, or the installed program's own icon where the vendor publishes no logo
// file. Decorative: the editor's name always sits beside it. null when there is neither.
export function EditorLogo({
  id,
  icon = null,
  className,
}: {
  id: EditorId;
  icon?: string | null;
  className?: string;
}) {
  const src = LOGOS[id] ?? icon;
  if (!src) return null;
  return (
    <img
      src={src}
      alt=""
      aria-hidden
      draggable={false}
      className={cn('size-4 shrink-0 object-contain', className)}
    />
  );
}

// The editor this repository opens in: its own choice, else the app setting.
export function useEditorName(repoId: string): {
  id: EditorId;
  name: string;
  icon: string | null;
} {
  const { data: settings } = useSettings();
  const { data: prefs } = useRepoPreferences(repoId);
  const { data: editors } = useEditors();
  const id = prefs?.editor ?? settings?.editor ?? 'system';
  const found = editors?.find((editor) => editor.id === id);
  return {
    id,
    name: id === 'system' || !found ? 'default app' : found.name,
    icon: found?.icon ?? null,
  };
}

export function OpenInEditorButton({
  repoId,
  path,
  line = null,
  size = 'sm',
  variant = 'secondary',
  shortcut,
  ...rest
}: {
  repoId: string;
  path: string | null;
  line?: number | null;
  size?: 'sm' | 'md';
  variant?: 'secondary' | 'ghost';
  // Only the repository header's button answers the key, so one press opens one editor.
  shortcut?: 'openEditor';
  // Toolbar.Button asChild hands its focus and key handling through here.
} & Omit<ComponentProps<'button'>, 'onClick' | 'children'>) {
  const open = useOpenInEditor(repoId);
  const toast = useToast();
  const editor = useEditorName(repoId);
  const run = () =>
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
    );
  useShortcut('openEditor', run, shortcut === 'openEditor');
  return (
    <Button
      {...rest}
      size={size}
      variant={variant}
      pending={open.isPending}
      onClick={run}
    >
      {!open.isPending &&
        (hasEditorLogo(editor.id, editor.icon) ? (
          <EditorLogo id={editor.id} icon={editor.icon} />
        ) : (
          <Code2 />
        ))}
      {editor.id === 'system' ? 'Open' : `Open in ${editor.name}`}
    </Button>
  );
}
