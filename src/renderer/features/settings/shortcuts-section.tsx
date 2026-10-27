import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import {
  CONTROL_SHORTCUTS,
  DIFF_SHORTCUTS,
  modLabel,
  SHORTCUTS,
  shortcutKeys,
} from '../../lib/shortcuts';
import { PageTitle } from '../shell/page';

function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <kbd className="flex gap-1 font-sans">
      {keys.map((key) => (
        <span
          key={key}
          className="inline-grid h-6 min-w-6 place-items-center rounded-sm border border-b-2 border-line-strong bg-surface px-1.5 text-xs font-medium text-ink"
        >
          {key === 'mod' ? modLabel() : key}
        </span>
      ))}
    </kbd>
  );
}

const GROUPS = [
  { group: 'App', title: undefined },
  { group: 'Repositories', title: 'Repositories' },
  { group: 'Repository', title: 'In an open repository' },
] as const;

export function ShortcutsSection() {
  return (
    <>
      <PageTitle title="Shortcuts">
        Keyboard shortcuts that work anywhere in gitdesk, in an open repository
        and in a diff. The File and View menus show the same keys.
      </PageTitle>
      <div id="shortcuts" className="scroll-mt-6">
        {GROUPS.map(({ group, title }) => (
          <SettingGroup key={group} title={title}>
            {SHORTCUTS.filter((shortcut) => shortcut.group === group).map(
              (shortcut) => (
                <SettingRow key={shortcut.id} label={shortcut.label}>
                  <Keys keys={shortcutKeys(shortcut.id)} />
                </SettingRow>
              ),
            )}
          </SettingGroup>
        ))}
        <SettingGroup title="In a diff">
          {DIFF_SHORTCUTS.map((shortcut) => (
            <SettingRow key={shortcut.label} label={shortcut.label}>
              <Keys keys={shortcut.keys} />
            </SettingRow>
          ))}
        </SettingGroup>
        <SettingGroup title="In lists and fields">
          {CONTROL_SHORTCUTS.map((shortcut) => (
            <SettingRow key={shortcut.label} label={shortcut.label}>
              <Keys keys={shortcut.keys} />
            </SettingRow>
          ))}
        </SettingGroup>
      </div>
    </>
  );
}
