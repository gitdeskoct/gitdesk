import type { Settings } from '../../../shared/settings';
import { Segmented } from '../../components/ui/segmented';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { Switch } from '../../components/ui/switch';
import { useSettings, useUpdateSettings } from '../../lib/queries';
import { PageTitle } from '../shell/page';

const LAYOUTS: { value: Settings['dashboardLayout']; label: string }[] = [
  { value: 'auto', label: 'Auto' },
  { value: 'centered', label: 'Centered' },
  { value: 'split', label: 'Split' },
];

const DENSITIES: { value: Settings['dashboardDensity']; label: string }[] = [
  { value: 'comfortable', label: 'Comfortable' },
  { value: 'compact', label: 'Compact' },
];

// Segmented values are strings; the setting stores minutes.
const INTERVALS = [
  { value: '0', label: 'Off' },
  { value: '5', label: '5 min' },
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
] as const;

const REMOTE: { value: Settings['remoteRefresh']; label: string }[] = [
  { value: 'auto', label: 'Automatic' },
  { value: 'manual', label: 'Manual' },
];

export function WorkspaceSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  if (!settings) return null;

  return (
    <>
      <PageTitle title="Workspace">
        How Home is laid out and how often gitdesk checks your repositories.
      </PageTitle>
      <SettingGroup title="Home">
        <SettingRow
          id="dashboard-layout"
          label="Layout"
          description="Split adds a column for attention and activity. Auto splits when the window is wide enough."
        >
          <Segmented
            label="Layout"
            value={settings.dashboardLayout}
            options={LAYOUTS}
            onChange={(dashboardLayout) => update.mutate({ dashboardLayout })}
          />
        </SettingRow>
        <SettingRow
          id="dashboard-density"
          label="Density"
          description="Compact rows hide descriptions and fit more repositories."
        >
          <Segmented
            label="Density"
            value={settings.dashboardDensity}
            options={DENSITIES}
            onChange={(dashboardDensity) => update.mutate({ dashboardDensity })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Status checks">
        <SettingRow
          id="watch-repositories"
          label="Watch repositories for changes"
          description="Checks a repository again soon after its branch, index or refs change."
        >
          <Switch
            aria-label="Watch repositories for changes"
            checked={settings.watchRepositories}
            onCheckedChange={(watchRepositories) =>
              update.mutate({ watchRepositories })
            }
          />
        </SettingRow>
        <SettingRow
          id="refresh-on-focus"
          label="Check when gitdesk comes to the front"
          description="Catches edits made in your editor while gitdesk was in the background."
        >
          <Switch
            aria-label="Check when gitdesk comes to the front"
            checked={settings.refreshOnFocus}
            onCheckedChange={(refreshOnFocus) =>
              update.mutate({ refreshOnFocus })
            }
          />
        </SettingRow>
        <SettingRow
          id="background-refresh"
          label="Background check"
          description="Checks every repository on a timer, three at a time. No network access."
        >
          <Segmented
            label="Background check"
            value={
              String(
                settings.backgroundRefresh,
              ) as (typeof INTERVALS)[number]['value']
            }
            options={INTERVALS}
            onChange={(minutes) =>
              update.mutate({
                backgroundRefresh: Number(
                  minutes,
                ) as Settings['backgroundRefresh'],
              })
            }
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Remote">
        <SettingRow
          id="remote-refresh"
          label="Refresh remote details"
          description="Automatic refreshes at most every 10 minutes. Manual loads only when you ask."
        >
          <Segmented
            label="Refresh remote details"
            value={settings.remoteRefresh}
            options={REMOTE}
            onChange={(remoteRefresh) => update.mutate({ remoteRefresh })}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}
