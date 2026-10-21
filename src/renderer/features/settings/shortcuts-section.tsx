import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { SHORTCUTS, shortcutKeys } from '../../lib/shortcuts';
import { PageTitle } from '../shell/page';

export function ShortcutsSection() {
  return (
    <>
      <PageTitle title="Shortcuts">
        Keyboard shortcuts that work anywhere in gitdesk.
      </PageTitle>
      <div id="shortcuts" className="scroll-mt-6">
        <SettingGroup>
          {SHORTCUTS.map((shortcut) => (
            <SettingRow key={shortcut.id} label={shortcut.label}>
              <kbd className="flex gap-1 font-sans">
                {shortcutKeys(shortcut.id).map((key) => (
                  <span
                    key={key}
                    className="inline-grid h-6 min-w-6 place-items-center rounded-sm border border-b-2 border-line-strong bg-surface px-1.5 text-xs font-medium text-ink"
                  >
                    {key}
                  </span>
                ))}
              </kbd>
            </SettingRow>
          ))}
        </SettingGroup>
      </div>
    </>
  );
}
