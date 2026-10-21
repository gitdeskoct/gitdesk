import { LogoMark } from '../../components/brand/logo';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { Loading } from '../../components/ui/status';
import { PLATFORM_NAMES } from '../../lib/format';
import { Copy, FolderOpen } from 'lucide-react';
import { GitMissingArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { InlineStatus } from '../../components/ui/status';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useAppInfo, useCopyDiagnostics, useOpenLogs } from '../../lib/queries';

export function AboutSection() {
  const info = useAppInfo();
  const openLogs = useOpenLogs();
  const copy = useCopyDiagnostics();
  if (info.isPending) return <Loading label="Reading version details…" />;
  if (info.isError)
    return (
      <EmptyState
        art={<GitMissingArt />}
        title="Couldn't read version details"
        action={
          <Button pending={info.isFetching} onClick={() => void info.refetch()}>
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(info.error, 'The app did not report its version.')}
      </EmptyState>
    );

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
        <SettingRow
          label="Logs"
          description="Diagnostic logs. They never contain tokens or sign-in codes."
        >
          <Button
            size="sm"
            pending={openLogs.isPending}
            onClick={() => openLogs.mutate()}
          >
            {!openLogs.isPending && <FolderOpen />}
            Open logs folder
          </Button>
        </SettingRow>
        <SettingRow
          label="Version details"
          description="Copy these when you report a problem."
        >
          <Button
            size="sm"
            pending={copy.isPending}
            onClick={() => copy.mutate()}
          >
            {!copy.isPending && <Copy />}
            {copy.isSuccess ? 'Copied' : 'Copy'}
          </Button>
        </SettingRow>
      </SettingGroup>
      {openLogs.isError && (
        <InlineStatus tone="danger" className="mt-4">
          {ipcErrorMessage(openLogs.error, "Couldn't open the logs folder.")}
        </InlineStatus>
      )}
    </>
  );
}
