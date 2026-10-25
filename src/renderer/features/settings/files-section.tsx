import type { Settings } from '../../../shared/settings';
import type { SourceEntry } from '../../../shared/source';
import { Segmented } from '../../components/ui/segmented';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { Switch } from '../../components/ui/switch';
import { useNavigation } from '../../app/navigation';
import { cn } from '../../lib/cn';
import { useSettings, useUpdateSettings } from '../../lib/queries';
import { useLineTokens } from '../repository/highlight';
import { iconFor } from '../source/file-icons';
import { PageTitle } from '../shell/page';

const SAMPLE_FILES: Pick<SourceEntry, 'name' | 'path' | 'type'>[] = [
  { name: 'src', path: 'src', type: 'dir' },
  { name: 'main.ts', path: 'src/main.ts', type: 'file' },
  { name: '.gitignore', path: '.gitignore', type: 'file' },
  { name: 'package.json', path: 'package.json', type: 'file' },
  { name: 'package-lock.json', path: 'package-lock.json', type: 'file' },
];
const SAMPLE = [
  "import { app } from 'electron';",
  '',
  '// Only one gitdesk window: a second launch hands its arguments to the first, which keeps running.',
  'const locked = app.requestSingleInstanceLock();',
  'if (!locked) app.quit();',
].join('\n');

// What the Files tab will look like with these settings: icons, line numbers, wrapping, colors.
function Preview({ settings }: { settings: Settings }) {
  const tokens = useLineTokens(
    SAMPLE,
    'src/main.ts',
    settings.codeTheme,
    settings.sourceSyntax,
  );
  const lines = SAMPLE.split('\n');
  const files = settings.sourceShowHidden
    ? SAMPLE_FILES
    : SAMPLE_FILES.filter((f) => !f.name.startsWith('.'));
  return (
    <div
      role="img"
      aria-label="Preview of the Files tab with these settings"
      className="grid overflow-hidden rounded-sm border border-line min-[700px]:grid-cols-[13rem_minmax(0,1fr)]"
    >
      <div className="border-b border-line p-2 text-[0.8125rem] min-[700px]:border-r min-[700px]:border-b-0">
        {files.map((file, i) => {
          const Icon = iconFor(file, i === 0, settings.sourceFileIcons);
          return (
            <div
              key={file.path}
              className={cn(
                'flex h-7 items-center gap-1.5 pr-2',
                file.path === 'src/main.ts' && 'font-semibold text-accent',
              )}
              style={{ paddingLeft: file.path.includes('/') ? 26 : 8 }}
            >
              <Icon
                aria-hidden
                className={cn(
                  'size-4 shrink-0',
                  file.path === 'src/main.ts' ? 'text-accent' : 'text-muted',
                )}
              />
              <span
                className={cn('truncate', file.type === 'dir' && 'font-medium')}
              >
                {file.name}
              </span>
            </div>
          );
        })}
      </div>
      <div className="code-text min-w-0 overflow-hidden py-2">
        {lines.map((line, i) => (
          <div key={i} className="flex">
            {settings.sourceLineNumbers && (
              <span className="w-10 shrink-0 border-r border-line pr-3 text-right text-muted select-none">
                {i + 1}
              </span>
            )}
            <span
              className={cn(
                'min-w-0 pr-4 pl-4',
                settings.sourceWrap
                  ? 'break-all whitespace-pre-wrap'
                  : 'truncate whitespace-pre',
              )}
            >
              {tokens?.[i]
                ? tokens[i]!.map((token, t) => (
                    <span key={t} className="code-token" style={token.style}>
                      {token.content}
                    </span>
                  ))
                : line || ' '}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

export function FilesSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const { navigate } = useNavigation();
  if (!settings) return null;
  const toggle = (
    key:
      | 'sourceShowIgnored'
      | 'sourceShowHidden'
      | 'sourceFoldersFirst'
      | 'sourceFileIcons'
      | 'sourceLineNumbers'
      | 'sourceWrap'
      | 'sourceSyntax'
      | 'sourceLastChange',
    label: string,
  ) => (
    <Switch
      aria-label={label}
      checked={settings[key]}
      onCheckedChange={(value) => update.mutate({ [key]: value })}
    />
  );

  return (
    <>
      <PageTitle title="Files">
        How the Files tab lists folders and shows a file. Colors, font and tab
        width come from{' '}
        <button
          type="button"
          className="text-accent underline-offset-4 hover:underline"
          onClick={() => navigate({ name: 'settings', section: 'code' })}
        >
          Code
        </button>
        .
      </PageTitle>
      <SettingGroup title="Tree">
        <SettingRow
          id="files-layout"
          label="Layout"
          description="Auto puts the tree beside the file from 960 pixels wide. A repository can pick its own in its settings."
        >
          <Segmented
            label="Files layout"
            value={settings.sourceLayout}
            onChange={(sourceLayout) => update.mutate({ sourceLayout })}
            options={[
              { value: 'auto', label: 'Auto' },
              { value: 'split', label: 'Split' },
              { value: 'centered', label: 'Centered' },
            ]}
          />
        </SettingRow>
        <SettingRow
          id="files-ignored"
          label="Show ignored files"
          description="Lists what .gitignore hides, such as node_modules and build output. Tracked files always show."
        >
          {toggle('sourceShowIgnored', 'Show ignored files')}
        </SettingRow>
        <SettingRow
          id="files-hidden"
          label="Show hidden files"
          description="Names that start with a dot. The .git folder never shows."
        >
          {toggle('sourceShowHidden', 'Show hidden files')}
        </SettingRow>
        <SettingRow
          id="files-folders-first"
          label="Folders first"
          description="Off sorts folders and files together by name."
        >
          {toggle('sourceFoldersFirst', 'Folders first')}
        </SettingRow>
        <SettingRow
          id="files-icons"
          label="File type icons"
          description="A different icon for code, config, lockfiles, images, archives and more. Off uses one file icon."
        >
          {toggle('sourceFileIcons', 'File type icons')}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Viewer">
        <SettingRow id="files-line-numbers" label="Line numbers">
          {toggle('sourceLineNumbers', 'Line numbers')}
        </SettingRow>
        <SettingRow
          id="files-wrap"
          label="Wrap long lines"
          description="Off keeps each line on one row and scrolls sideways, so line numbers match your editor."
        >
          {toggle('sourceWrap', 'Wrap long lines')}
        </SettingRow>
        <SettingRow
          id="files-syntax"
          label="Syntax colors"
          description="Colors follow the code theme. Files over 4,000 lines always show plain."
        >
          {toggle('sourceSyntax', 'Syntax colors')}
        </SettingRow>
        <SettingRow
          id="files-inline-limit"
          label="Open text files up to"
          description="Larger files ask first. Nothing over 5 MB opens inside gitdesk."
        >
          <Segmented
            label="Open text files up to"
            value={String(settings.sourceInlineLimit)}
            onChange={(next) =>
              update.mutate({
                sourceInlineLimit: Number(
                  next,
                ) as Settings['sourceInlineLimit'],
              })
            }
            options={[
              { value: '1', label: '1 MB' },
              { value: '2', label: '2 MB' },
              { value: '5', label: '5 MB' },
            ]}
          />
        </SettingRow>
        <SettingRow
          id="files-last-change"
          label="Show last change"
          description="Asks Git who last changed the open file and when."
        >
          {toggle('sourceLastChange', 'Show last change')}
        </SettingRow>
      </SettingGroup>

      <SettingGroup title="Preview">
        <div className="py-4">
          <Preview settings={settings} />
        </div>
      </SettingGroup>
    </>
  );
}
