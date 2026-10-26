import * as RadioGroup from '@radix-ui/react-radio-group';
import { Check, FolderOpen, RefreshCw } from 'lucide-react';
import type { ReactNode } from 'react';
import type { EditorId } from '../../../shared/settings';
import { EditorArt, OfflineArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { InlineStatus, Loading } from '../../components/ui/status';
import { Switch } from '../../components/ui/switch';
import { cn } from '../../lib/cn';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useDetectEditors,
  useEditors,
  useSettings,
  useUpdateSettings,
} from '../../lib/queries';
import { EditorLogo, hasEditorLogo } from '../repository/editor-button';
import { PageTitle } from '../shell/page';

const CHECKED_FOR =
  'Visual Studio Code, VS Code Insiders, VSCodium, Cursor, Windsurf, Zed, Sublime Text, Notepad++ and JetBrains IDEs';

const initials = (name: string) =>
  name
    .split(/\s+/)
    .map((word) => word[0])
    .join('')
    .slice(0, 2)
    .toUpperCase();

function Option({
  value,
  name,
  detail,
  icon,
  path = false,
}: {
  value: EditorId;
  name: string;
  detail: string;
  icon: ReactNode;
  path?: boolean;
}) {
  return (
    <RadioGroup.Item
      value={value}
      className={cn(
        'group grid min-h-14 w-full grid-cols-[1.75rem_minmax(0,1fr)_auto] items-center gap-3 border-b border-line py-2 pr-3 pl-3 text-left outline-offset-[-2px] hover:bg-row-hover',
        'data-[state=checked]:bg-accent-soft',
      )}
    >
      <span
        aria-hidden
        className="grid size-7 place-items-center rounded-sm bg-control text-xs font-semibold text-ink [&_svg]:size-4"
      >
        {icon}
      </span>
      <span className="min-w-0">
        <span className="block text-sm font-medium text-ink group-data-[state=checked]:font-semibold">
          {name}
        </span>
        <span
          className={cn(
            'block truncate text-xs text-muted',
            path && 'font-mono',
          )}
          title={detail}
        >
          {detail}
        </span>
      </span>
      <span className="inline-flex items-center gap-1 text-xs font-medium text-ink opacity-0 group-data-[state=checked]:opacity-100">
        <Check aria-hidden className="size-3.5 text-success" /> In use
      </span>
    </RadioGroup.Item>
  );
}

// Editors are found by main on this computer; the choice is an id, never a program path.
export function EditorSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const editors = useEditors();
  const detect = useDetectEditors();
  const platform = window.desktop.platform;
  const systemDetail =
    platform === 'win32'
      ? 'Opens files in the app Windows uses for their type, and folders in Explorer'
      : platform === 'darwin'
        ? 'Opens files in their default app, and folders in Finder'
        : 'Opens files in their default app, and folders in the file manager';
  if (!settings) return null;

  const lookAgain = (
    <Button
      size="sm"
      pending={detect.isPending}
      onClick={() => detect.mutate()}
    >
      {!detect.isPending && <RefreshCw />}
      Look again
    </Button>
  );

  let list;
  if (editors.isPending)
    list = <Loading label="Looking for code editors on this computer…" />;
  else if (editors.isError)
    list = (
      <EmptyState
        compact
        art={<OfflineArt />}
        title="Couldn't look for editors"
        action={
          <Button
            size="sm"
            pending={editors.isFetching}
            onClick={() => void editors.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(editors.error, 'Something stopped the search.')}
      </EmptyState>
    );
  else
    list = (
      <>
        <RadioGroup.Root
          aria-label="Code editor"
          value={
            editors.data.some((e) => e.id === settings.editor)
              ? settings.editor
              : 'system'
          }
          onValueChange={(editor) =>
            update.mutate({ editor: editor as EditorId })
          }
          className="border-t border-line"
        >
          {editors.data.map((editor) => (
            <Option
              key={editor.id}
              value={editor.id}
              name={editor.name}
              detail={editor.location}
              path
              icon={
                hasEditorLogo(editor.id, editor.icon) ? (
                  <EditorLogo
                    id={editor.id}
                    icon={editor.icon}
                    className="size-5"
                  />
                ) : (
                  initials(editor.name)
                )
              }
            />
          ))}
          <Option
            value="system"
            name="System default app"
            detail={systemDetail}
            icon={<FolderOpen />}
          />
        </RadioGroup.Root>
        {!editors.data.length && (
          <EmptyState
            compact
            art={<EditorArt />}
            title="No code editor found"
            action={lookAgain}
          >
            Install one, then look again. Until then, Open in editor uses the
            system default app.
          </EmptyState>
        )}
        {settings.editor !== 'system' &&
          !editors.data.some((e) => e.id === settings.editor) && (
            <InlineStatus tone="warning" className="mt-3">
              The editor you picked before wasn't found this time, so the system
              default app is used.
            </InlineStatus>
          )}
        <p className="mt-3 text-[0.8125rem] text-muted">
          Checked for {CHECKED_FOR}. gitdesk only starts an editor it found
          itself, with the repository or file as its argument.
        </p>
      </>
    );

  return (
    <>
      <PageTitle title="Code editor" actions={lookAgain}>
        Where Open in editor sends a repository or a changed file.
      </PageTitle>
      {list}
      <SettingGroup title="Opening">
        <SettingRow
          id="editor-goto-line"
          label="Open files at the changed line"
          description="VS Code, Cursor, Zed, Sublime Text, Notepad++ and JetBrains IDEs jump to the first changed line, or to the first conflict marker in a conflicted file."
        >
          <Switch
            aria-label="Open files at the changed line"
            checked={settings.editorGotoLine}
            onCheckedChange={(editorGotoLine) =>
              update.mutate({ editorGotoLine })
            }
          />
        </SettingRow>
        <SettingRow
          id="editor-open-folder"
          label="Open the repository folder with a file"
          description="Opens the whole repository in the editor, then the file inside it, so search and Git work there too."
        >
          <Switch
            aria-label="Open the repository folder with a file"
            checked={settings.editorOpenFolder}
            onCheckedChange={(editorOpenFolder) =>
              update.mutate({ editorOpenFolder })
            }
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}
