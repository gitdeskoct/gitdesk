import { LogoMark } from '../../components/brand/logo';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { Loading } from '../../components/ui/status';
import { PLATFORM_NAMES } from '../../lib/format';
import { useAppInfo } from '../../lib/queries';

export function AboutSection() {
  const info = useAppInfo();
  if (info.isPending) return <Loading label="Reading version details…" />;
  if (info.isError) return null;

  return (
    <>
      <div
        id="version"
        className="mb-7 flex scroll-mt-6 items-center gap-3.5 text-ink"
      >
        <LogoMark size={48} />
        <div>
          <h1 className="text-xl font-semibold tracking-[-0.03em]">gitdesk</h1>
          <p className="mt-0.5 text-sm text-muted">
            Version {info.data.version}
          </p>
        </div>
      </div>
      <SettingGroup>
        <SettingRow
          label="Electron"
          description="The desktop runtime gitdesk is built on."
        >
          <span className="text-[0.8125rem] text-muted tabular-nums">
            {info.data.electron}
          </span>
        </SettingRow>
        <SettingRow
          label="Platform"
          description="The operating system this copy runs on."
        >
          <span className="text-[0.8125rem] text-muted">
            {PLATFORM_NAMES[info.data.platform]}
          </span>
        </SettingRow>
      </SettingGroup>
    </>
  );
}
