import {
  CircleAlert,
  CircleCheck,
  Download,
  ExternalLink,
  Info,
  RefreshCw,
  RotateCcw,
  ShieldCheck,
  TriangleAlert,
  WifiOff,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type {
  InstallKind,
  UpdateRelease,
  UpdateStatus,
} from '../../../shared/updates';
import { SyncArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { JobProgress } from '../../components/ui/job-progress';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { InlineStatus, Loading } from '../../components/ui/status';
import { Switch } from '../../components/ui/switch';
import { cn } from '../../lib/cn';
import {
  formatBytes,
  formatDate,
  formatRate,
  relativeTime,
  useNow,
} from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useSettings, useUpdateSettings } from '../../lib/queries';
import { Segmented } from '../../components/ui/segmented';
import {
  useCheckForUpdates,
  useDownloadUpdate,
  useInstallUpdate,
  useOpenReleasePage,
  useUpdateStatus,
} from '../../lib/update-queries';
import { useWidth } from '../../lib/use-width';
import { PageTitle } from '../shell/page';
import { noteBlocks } from './release-notes';

const INSTALL_KINDS: Record<InstallKind, string> = {
  nsis: 'Windows · setup program (NSIS)',
  appimage: 'Linux · AppImage',
  deb: 'Linux · Debian package (.deb)',
  pacman: 'Linux · Arch package (pacman)',
  archive: 'Linux · archive (.tar.gz) or Nix',
  dev: 'Development run from source',
};

const canUpdate = (kind: InstallKind) => kind !== 'dev' && kind !== 'archive';
const needsPassword = (kind: InstallKind) =>
  kind === 'deb' || kind === 'pacman';

// The release and its install steps get the split view; checking and settings stay one column.
function releaseOf(status: UpdateStatus): UpdateRelease | null {
  if ('release' in status && status.release) return status.release;
  return null;
}

function Band({
  tone,
  icon,
  children,
  action,
}: {
  tone: 'warning' | 'danger';
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex flex-wrap items-center gap-3 px-3 py-2.5 text-[0.8125rem] leading-relaxed text-ink',
        tone === 'danger'
          ? 'bg-danger-soft [&>svg]:text-danger'
          : 'bg-warning-soft [&>svg]:text-warning',
      )}
    >
      {icon}
      <span className="min-w-[12rem] flex-1">{children}</span>
      {action}
    </div>
  );
}

function ReleaseNotes({ release }: { release: UpdateRelease }) {
  const blocks = release.notes ? noteBlocks(release.notes) : [];
  const openPage = useOpenReleasePage();
  return (
    <article aria-label="Release" className="min-w-0">
      <div className="text-[0.8125rem] font-medium text-muted">Release</div>
      <h2 className="mt-1 text-xl font-semibold tracking-[-0.02em] text-ink">
        gitdesk {release.version}
      </h2>
      <p className="mt-1 text-sm text-muted">
        {[
          release.date && `Published ${formatDate(Date.parse(release.date))}`,
          'Stable',
          release.sizeBytes && formatBytes(release.sizeBytes),
        ]
          .filter(Boolean)
          .join(' · ')}
      </p>
      <div className="mt-4 border-t border-line pt-4 text-sm leading-relaxed text-ink">
        {blocks.length ? (
          blocks.map((block, index) =>
            block.kind === 'heading' ? (
              <h3 key={index} className="mt-4 mb-1.5 font-semibold first:mt-0">
                {block.text}
              </h3>
            ) : block.kind === 'list' ? (
              <ul key={index} className="mb-3 list-disc pl-5">
                {block.items.map((item, i) => (
                  <li key={i}>{item}</li>
                ))}
              </ul>
            ) : (
              <p key={index} className="mb-3">
                {block.text}
              </p>
            ),
          )
        ) : (
          <p className="text-muted">
            This release has no notes here. The release page may say more.
          </p>
        )}
      </div>
      <Button
        variant="link"
        className="mt-3"
        pending={openPage.isPending}
        onClick={() => openPage.mutate()}
      >
        {!openPage.isPending && <ExternalLink />}
        Open release page
      </Button>
    </article>
  );
}

function UpdateSteps({
  status,
  release,
  onLater,
}: {
  status: UpdateStatus;
  release: UpdateRelease;
  onLater: () => void;
}) {
  const download = useDownloadUpdate();
  const install = useInstallUpdate();
  const kind = status.installKind;
  const restartLabel = needsPassword(kind)
    ? 'Restart and install'
    : 'Restart to update';
  const restarting = status.phase === 'restarting' || install.isPending;

  if (status.phase === 'available')
    return (
      <>
        <InlineStatus tone="info" className="mt-3">
          <span className="font-semibold">
            Version {release.version} is available
          </span>
          <span className="block text-muted">
            You have {status.currentVersion}.
            {release.sizeBytes
              ? ` The download is ${formatBytes(release.sizeBytes)}.`
              : ''}
          </span>
        </InlineStatus>
        <div className="mt-4 flex flex-wrap gap-2">
          <Button
            variant="primary"
            pending={download.isPending}
            onClick={() => download.mutate(undefined)}
          >
            {!download.isPending && <Download />}
            Download update
          </Button>
          <Button variant="ghost" onClick={onLater}>
            Later
          </Button>
        </div>
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-muted">
          Before anything can install, gitdesk checks the download against the
          SHA-512 published with the release.
        </p>
      </>
    );

  if (status.phase === 'downloading') {
    const left =
      status.bytesPerSecond > 0 && status.total > status.transferred
        ? Math.ceil((status.total - status.transferred) / status.bytesPerSecond)
        : null;
    return (
      <>
        <div className="mt-3">
          <JobProgress
            label="Update download"
            stage={`Downloading ${release.version}`}
            right={`${Math.round(status.percent)}%`}
            percent={status.percent}
            network={false}
          />
          <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-1 text-[0.8125rem] text-muted">
            {status.bytesPerSecond > 0 && (
              <b className="font-semibold text-ink tabular-nums">
                {formatRate(status.bytesPerSecond)}
              </b>
            )}
            {status.total > 0 && (
              <span>
                {formatBytes(status.transferred)} of {formatBytes(status.total)}
              </span>
            )}
            {left !== null && <span>about {left} s left</span>}
          </div>
        </div>
        <div className="mt-4">
          <Button variant="primary" pending>
            Download update
          </Button>
        </div>
        <p className="mt-3 text-[0.8125rem] leading-relaxed text-muted">
          Keep working. gitdesk tells you when {release.version} is ready, and
          nothing installs until you restart.
        </p>
      </>
    );
  }

  if (status.phase === 'error' && status.stage !== 'install')
    return (
      <>
        <div className="mt-3">
          <Band tone="danger" icon={<CircleAlert className="size-4" />}>
            {status.message}
          </Band>
        </div>
        <div className="mt-4">
          <Button
            variant="primary"
            pending={download.isPending}
            onClick={() => download.mutate(undefined)}
          >
            {!download.isPending && <Download />}
            Download again
          </Button>
        </div>
        {status.stage === 'verify' && (
          <p className="mt-3 text-[0.8125rem] leading-relaxed text-muted">
            If it fails again, the file on GitHub may have been replaced. Copy
            the version details from About and report it.
          </p>
        )}
      </>
    );

  // Downloaded, busy, restarting, or an installer that didn't take over.
  return (
    <>
      <InlineStatus tone="success" className="mt-3">
        <span className="font-semibold">
          Ready to install {release.version}
        </span>
        <span className="block text-muted">
          The download matches the release's SHA-512.
        </span>
      </InlineStatus>
      {status.phase === 'busy' && (
        <div className="mt-3">
          <Band
            tone="warning"
            icon={<TriangleAlert className="size-4" />}
            action={
              status.waiting ? null : (
                <span className="flex flex-wrap gap-2">
                  <Button
                    size="sm"
                    className="bg-surface"
                    pending={
                      install.isPending && install.variables === 'anyway'
                    }
                    onClick={() => install.mutate('anyway')}
                  >
                    Restart anyway
                  </Button>
                  <Button
                    size="sm"
                    variant="ghost"
                    pending={
                      install.isPending && install.variables === 'when-idle'
                    }
                    onClick={() => install.mutate('when-idle')}
                  >
                    Restart when it's done
                  </Button>
                </span>
              )
            }
          >
            {status.waiting
              ? 'gitdesk restarts by itself as soon as the clone or push in progress finishes.'
              : 'A clone, push or move is still running. Restarting now stops it, and it has to start again.'}
          </Band>
        </div>
      )}
      {status.phase === 'error' && (
        <div className="mt-3">
          <Band tone="danger" icon={<CircleAlert className="size-4" />}>
            {status.message}
          </Band>
        </div>
      )}
      <div className="mt-4 flex flex-wrap gap-2">
        <Button
          variant="primary"
          pending={restarting || (status.phase === 'busy' && status.waiting)}
          onClick={() => install.mutate('now')}
        >
          {!restarting && !(status.phase === 'busy' && status.waiting) && (
            <RotateCcw />
          )}
          {restartLabel}
        </Button>
        {!restarting && (
          <Button variant="ghost" onClick={onLater}>
            Later
          </Button>
        )}
      </div>
      <p className="mt-3 text-[0.8125rem] leading-relaxed text-muted">
        {restarting
          ? `Closing gitdesk. The installer runs without asking and opens gitdesk ${release.version} when it finishes.`
          : needsPassword(kind)
            ? `gitdesk closes and installs the new package, so Linux asks for your administrator password, then gitdesk opens again. Your repositories and uncommitted changes stay as they are.`
            : `gitdesk closes, installs ${release.version} and opens again by itself. Your repositories and uncommitted changes stay as they are.`}
      </p>
      {kind === 'nsis' && !restarting && (
        <InlineStatus tone="warning" className="mt-3 text-[0.8125rem]">
          This build isn't code-signed yet, so Windows may ask before the
          installer runs.
        </InlineStatus>
      )}
    </>
  );
}

function StatusRow({
  status,
  onReview,
}: {
  status: UpdateStatus;
  onReview: () => void;
}) {
  const check = useCheckForUpdates();
  const openPage = useOpenReleasePage();
  const now = useNow();
  const checking = status.phase === 'checking' || check.isPending;
  const release = releaseOf(status);

  let icon = <CircleCheck className="mt-0.5 size-4 shrink-0 text-success" />;
  let title = `gitdesk ${status.currentVersion} is up to date`;
  let detail = status.lastCheck?.ok
    ? `Checked ${relativeTime(status.lastCheck.at, now)}.`
    : 'Not checked yet.';
  if (!canUpdate(status.installKind)) {
    icon = <Info className="mt-0.5 size-4 shrink-0 text-muted" />;
    title =
      status.installKind === 'dev'
        ? 'Updates are checked in installed builds only'
        : "This copy can't update itself";
    detail =
      status.installKind === 'dev'
        ? 'This copy runs from source with npm start. Install a release to get updates here.'
        : 'It was installed from the .tar.gz archive or with Nix. Install the new version the same way, or use the AppImage, which updates in place.';
  } else if (checking) {
    icon = <RefreshCw className="mt-0.5 size-4 shrink-0 text-muted" />;
    title = 'Checking for a newer version';
    detail = 'Asking GitHub for the latest stable release.';
  } else if (release) {
    icon = <Download className="mt-0.5 size-4 shrink-0 text-accent" />;
    title =
      status.phase === 'available'
        ? `Version ${release.version} is available`
        : `Version ${release.version} is downloaded`;
    detail = `You have ${status.currentVersion}.`;
  } else if (status.phase === 'idle' || status.phase === 'error') {
    icon = <Info className="mt-0.5 size-4 shrink-0 text-muted" />;
    title = `gitdesk ${status.currentVersion}`;
  }

  return (
    <section>
      <div className="border-y border-line">
        <div
          id="update-status"
          className="flex scroll-mt-6 flex-wrap items-center justify-between gap-x-8 gap-y-3 py-4"
        >
          <div className="flex min-w-0 flex-1 items-start gap-2.5">
            {icon}
            <div className="min-w-0">
              <div className="text-sm font-medium text-ink">{title}</div>
              <div className="mt-0.5 text-sm leading-relaxed text-muted">
                {detail}
              </div>
            </div>
          </div>
          {release && !checking ? (
            <Button variant="primary" onClick={onReview}>
              <Download />
              Review update
            </Button>
          ) : canUpdate(status.installKind) ? (
            <Button
              variant="primary"
              pending={checking}
              onClick={() => check.mutate(undefined)}
            >
              {!checking && <RefreshCw />}
              Check for updates
            </Button>
          ) : (
            <Button
              pending={openPage.isPending}
              onClick={() => openPage.mutate()}
            >
              {!openPage.isPending && <ExternalLink />}
              Open release page
            </Button>
          )}
        </div>
      </div>
      {status.phase === 'error' && status.stage === 'check' && (
        <div className="mt-3">
          <Band
            tone={status.offline ? 'warning' : 'danger'}
            icon={
              status.offline ? (
                <WifiOff className="size-4" />
              ) : (
                <CircleAlert className="size-4" />
              )
            }
            action={
              <Button
                size="sm"
                className="bg-surface"
                pending={checking}
                onClick={() => check.mutate(undefined)}
              >
                {status.offline ? 'Check again' : 'Try again'}
              </Button>
            }
          >
            {status.message}
          </Band>
        </div>
      )}
      {check.isError && (
        <InlineStatus tone="danger" className="mt-3">
          {ipcErrorMessage(check.error, "Couldn't check for updates.")}
        </InlineStatus>
      )}
    </section>
  );
}

export function UpdatesSection() {
  const status = useUpdateStatus();
  const { data: settings } = useSettings();
  const updateSettings = useUpdateSettings();
  const [ref, width] = useWidth();
  // Later folds the release away for this visit; the title bar keeps the reminder.
  const [laterFor, setLaterFor] = useState<string | null>(null);

  if (status.isPending) return <Loading label="Reading the update status…" />;
  if (status.isError)
    return (
      <EmptyState
        art={<SyncArt />}
        title="Couldn't read the update status"
        action={
          <Button
            pending={status.isFetching}
            onClick={() => void status.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(status.error, 'The app did not answer.')}
      </EmptyState>
    );

  const s = status.data;
  const release = releaseOf(s);
  const split =
    release !== null &&
    laterFor !== release.version &&
    s.phase !== 'checking' &&
    !(s.phase === 'error' && s.stage === 'check');
  const stacked = width > 0 && width < 700;

  const intro = (
    <PageTitle title="Updates">
      New versions come from gitdesk's public releases on GitHub. Nothing
      downloads or installs until you choose to.
    </PageTitle>
  );

  const details = (
    <>
      <SettingGroup title="This copy">
        <SettingRow
          id="installed-version"
          label="Installed version"
          description={INSTALL_KINDS[s.installKind]}
        >
          <span className="text-[0.8125rem] text-muted tabular-nums">
            {s.currentVersion}
          </span>
        </SettingRow>
        <SettingRow
          id="update-channel"
          label="Channel"
          description="Stable is recommended. Beta receives prerelease builds from a separate repository and may be less tested."
        >
          {settings && (
            <Segmented
              label="Update channel"
              value={settings.updateChannel}
              onChange={(updateChannel) =>
                updateSettings.mutate({ updateChannel })
              }
              options={[
                { value: 'stable', label: 'Stable' },
                { value: 'beta', label: 'Beta' },
              ]}
            />
          )}
        </SettingRow>
        <SettingRow
          label="How downloads are checked"
          description={
            !canUpdate(s.installKind)
              ? 'Not applicable: this copy never downloads updates itself.'
              : s.installKind === 'nsis'
                ? 'Against the SHA-512 in the release metadata, over HTTPS from GitHub. This build is not code-signed yet, so there is no publisher check.'
                : 'Against the SHA-512 in the release metadata, over HTTPS from GitHub. Linux packages are not signature-checked by gitdesk.'
          }
        >
          <ShieldCheck className="size-4 text-muted" aria-hidden />
        </SettingRow>
      </SettingGroup>
      {canUpdate(s.installKind) && settings && (
        <SettingGroup title="Checking">
          <SettingRow
            id="auto-check-updates"
            label="Check automatically"
            description="When gitdesk starts and every 6 hours while it runs. Downloads still wait for you."
          >
            <Switch
              aria-label="Check for updates automatically"
              checked={settings.autoCheckUpdates}
              onCheckedChange={(autoCheckUpdates) =>
                updateSettings.mutate({ autoCheckUpdates })
              }
            />
          </SettingRow>
          <SettingRow
            label="Last check"
            description={
              s.lastCheck
                ? `${new Date(s.lastCheck.at).toLocaleString()}, ${s.lastCheck.ok ? 'worked' : "didn't reach GitHub"}.`
                : 'Not checked yet.'
            }
          />
        </SettingGroup>
      )}
    </>
  );

  return (
    <div ref={ref}>
      {split && release ? (
        <>
          {intro}
          <div
            className={cn(
              'grid gap-9',
              stacked
                ? 'grid-cols-1'
                : 'grid-cols-[minmax(0,1fr)_minmax(17rem,20rem)]',
            )}
          >
            <ReleaseNotes release={release} />
            <section
              aria-label="Update status"
              className={cn(
                stacked
                  ? '-order-1 border-b border-line pb-6'
                  : 'border-l border-line pl-7',
              )}
            >
              <div className="text-[0.8125rem] font-medium text-muted">
                Update status
              </div>
              <UpdateSteps
                status={s}
                release={release}
                onLater={() => setLaterFor(release.version)}
              />
            </section>
          </div>
        </>
      ) : (
        <div className="mx-auto max-w-[760px]">
          {intro}
          <StatusRow status={s} onReview={() => setLaterFor(null)} />
          <div className="mt-9">{details}</div>
        </div>
      )}
    </div>
  );
}
