import type { Settings } from '../../../shared/settings';
import { Segmented } from '../../components/ui/segmented';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { Switch } from '../../components/ui/switch';
import { PLATFORM_NAMES } from '../../lib/format';
import {
  useAppInfo,
  useSetOpenAtLogin,
  useSettings,
  useUpdateSettings,
} from '../../lib/queries';
import { shortcutText } from '../../lib/shortcuts';
import { SORTS } from '../repos/repositories-page';
import { PageTitle } from '../shell/page';

const START_PAGES: { value: Settings['startPage']; label: string }[] = [
  { value: 'home', label: 'Home' },
  { value: 'repositories', label: 'Repositories' },
  { value: 'last', label: 'Last repository' },
];

// Segmented values are strings; the setting stores a count.
const RECENT = [
  { value: '0', label: 'Off' },
  { value: '5', label: '5' },
  { value: '8', label: '8' },
] as const;

export function GeneralSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const info = useAppInfo();
  const openAtLogin = useSetOpenAtLogin();
  if (!settings) return null;

  return (
    <>
      <PageTitle title="General">
        How gitdesk starts, what the sidebar holds and how it connects.
      </PageTitle>
      <SettingGroup title="Startup">
        <SettingRow
          id="start-page"
          label="Open on start"
          description="Last repository opens the one you used most recently, if its folder is still there. Otherwise Home opens."
        >
          <Segmented
            label="Open on start"
            value={settings.startPage}
            options={START_PAGES}
            onChange={(startPage) => update.mutate({ startPage })}
          />
        </SettingRow>
        {/* Linux has no login-item API, so main reports null and the row is left out. */}
        {info.data && info.data.openAtLogin !== null && (
          <SettingRow
            id="open-at-login"
            label="Open at login"
            description={`Start gitdesk when you sign in to ${PLATFORM_NAMES[info.data.platform]}.`}
          >
            <Switch
              aria-label="Open at login"
              checked={info.data.openAtLogin}
              disabled={openAtLogin.isPending}
              onCheckedChange={(enabled) => openAtLogin.mutate(enabled)}
            />
          </SettingRow>
        )}
      </SettingGroup>
      <SettingGroup title="Sidebar">
        <SettingRow
          id="collapse-sidebar"
          label="Collapse sidebar"
          description={`Show icons only. Names appear on hover. ${shortcutText('toggleSidebar')} switches it.`}
        >
          <Switch
            aria-label="Collapse sidebar"
            checked={settings.sidebarCollapsed}
            onCheckedChange={(sidebarCollapsed) =>
              update.mutate({ sidebarCollapsed })
            }
          />
        </SettingRow>
        <SettingRow
          id="sidebar-recent"
          label="Repositories in the sidebar"
          description="Pinned ones first, then the ones you opened most recently, with Git's count of changed files. Hidden while the sidebar is collapsed."
        >
          <Segmented
            label="Repositories in the sidebar"
            value={
              String(settings.sidebarRecent) as (typeof RECENT)[number]['value']
            }
            options={RECENT}
            onChange={(count) =>
              update.mutate({
                sidebarRecent: Number(count) as Settings['sidebarRecent'],
              })
            }
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Repositories page">
        <SettingRow
          id="repositories-expand"
          label="Open every row's details"
          description="Branch, working tree, sync, last opened and folder. Off lists names only, and each row opens on its own."
        >
          <Switch
            aria-label="Open every row's details"
            checked={settings.repositoriesExpandRows}
            onCheckedChange={(repositoriesExpandRows) =>
              update.mutate({ repositoriesExpandRows })
            }
          />
        </SettingRow>
        <SettingRow
          id="repositories-stats"
          label="Show statistics"
          description="The All, Local, Remote and Linked counts with where each comes from, above the list."
        >
          <Switch
            aria-label="Show statistics"
            checked={settings.repositoriesShowStats}
            onCheckedChange={(repositoriesShowStats) =>
              update.mutate({ repositoriesShowStats })
            }
          />
        </SettingRow>
        <SettingRow
          id="repositories-sort"
          label="Sort by"
          description="Changes and Sync put the repositories with the most to do first. The layout is in Workspace."
        >
          <Segmented
            label="Sort by"
            value={settings.repositoriesSort}
            options={SORTS}
            onChange={(repositoriesSort) => update.mutate({ repositoriesSort })}
          />
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Account">
        <SettingRow
          id="local-only"
          label="Use gitdesk without an account"
          description="Local Git only. Remote features ask you to sign in first."
        >
          <Switch
            aria-label="Use gitdesk without an account"
            checked={settings.localOnly}
            onCheckedChange={(localOnly) => update.mutate({ localOnly })}
          />
        </SettingRow>
      </SettingGroup>
    </>
  );
}
