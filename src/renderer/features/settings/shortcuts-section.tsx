import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { DIFF_SHORTCUTS, SHORTCUTS, shortcutKeys } from '../../lib/shortcuts';
import { PageTitle } from '../shell/page';

function Keys({ keys }: { keys: readonly string[] }) {
  return (
    <kbd className="flex gap-1 font-sans">
      {keys.map((key) => (
        <span
          key={key}
          className="inline-grid h-6 min-w-6 place-items-center rounded-sm border border-b-2 border-line-strong bg-surface px-1.5 text-xs font-medium text-ink"
        >
          {key}
        </span>
      ))}
    </kbd>
  );
}

export function ShortcutsSection() {
  return (
    <>
      <PageTitle title="Shortcuts">
        Keyboard shortcuts that work anywhere in gitdesk, and in a diff.
      </PageTitle>
      <div id="shortcuts" className="scroll-mt-6">
        <SettingGroup>
          {SHORTCUTS.map((shortcut) => (
            <SettingRow key={shortcut.id} label={shortcut.label}>
              <Keys keys={shortcutKeys(shortcut.id)} />
            </SettingRow>
          ))}
        </SettingGroup>
        <SettingGroup title="In a diff">
          {DIFF_SHORTCUTS.map((shortcut) => (
            <SettingRow key={shortcut.label} label={shortcut.label}>
              <Keys keys={shortcut.keys} />
            </SettingRow>
          ))}
        </SettingGroup>
      </div>
    </>
  );
}
