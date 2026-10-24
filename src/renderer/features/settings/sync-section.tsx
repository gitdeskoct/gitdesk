import type { Settings } from '../../../shared/settings';
import { Segmented } from '../../components/ui/segmented';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { useSettings, useUpdateSettings } from '../../lib/queries';
import { PageTitle } from '../shell/page';

const METHODS: { value: Settings['pullStrategy']; label: string }[] = [
  { value: 'ff-only', label: 'Fast-forward only' },
  { value: 'merge', label: 'Merge' },
  { value: 'rebase', label: 'Rebase' },
];

export function SyncSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  if (!settings) return null;
  return (
    <>
      <PageTitle title="Sync">
        How Pull and Push behave. Fetch only downloads: it never changes your
        files or branches.
      </PageTitle>
      <SettingGroup title="Pull">
        <SettingRow
          id="pull-strategy"
          label="How Pull brings in changes"
          description="Used unless you pick another method for one pull on the Sync tab. Fast-forward only stops when the histories differ, so nothing is rewritten and no merge commit is made without you choosing it."
          stacked
        >
          <Segmented
            label="Pull method"
            value={settings.pullStrategy}
            options={METHODS}
            onChange={(pullStrategy) => update.mutate({ pullStrategy })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Push">
        <SettingRow
          id="push-never-forces"
          label="Never force-push"
          description="Always on. A push the remote refuses explains why and offers a pull first; nothing on the remote is overwritten."
        >
          <span className="text-[0.8125rem] text-muted">Always on</span>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
