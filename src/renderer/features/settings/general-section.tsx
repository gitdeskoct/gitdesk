import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { Switch } from '../../components/ui/switch';
import { PLATFORM_NAMES } from '../../lib/format';
import {
  useAppInfo,
  useSetOpenAtLogin,
  useSettings,
  useUpdateSettings,
} from '../../lib/queries';
import { PageTitle } from '../shell/page';

export function GeneralSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const info = useAppInfo();
  const openAtLogin = useSetOpenAtLogin();
  if (!settings) return null;

  return (
    <>
      <PageTitle title="General">How gitdesk starts and connects.</PageTitle>
      <SettingGroup>
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
        <SettingRow
          id="collapse-sidebar"
          label="Collapse sidebar"
          description="Show icons only. Names appear on hover."
        >
          <Switch
            aria-label="Collapse sidebar"
            checked={settings.sidebarCollapsed}
            onCheckedChange={(sidebarCollapsed) =>
              update.mutate({ sidebarCollapsed })
            }
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
    </>
  );
}
