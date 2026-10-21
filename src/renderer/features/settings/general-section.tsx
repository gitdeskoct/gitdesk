import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { Switch } from '../../components/ui/switch';
import { useSettings, useUpdateSettings } from '../../lib/queries';
import { PageTitle } from '../shell/page';

export function GeneralSection() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
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
      </SettingGroup>
    </>
  );
}
