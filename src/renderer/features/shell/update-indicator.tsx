import { CircleAlert, Download, RotateCcw } from 'lucide-react';
import { updateNeedsAttention } from '../../../shared/updates';
import { Button } from '../../components/ui/button';
import { Tooltip } from '../../components/ui/tooltip';
import { formatRate } from '../../lib/format';
import { useInstallUpdate, useUpdateStatus } from '../../lib/update-queries';
import { useNavigation } from '../../app/navigation';

// A 16px ring that fills with the download.
function Ring({ percent }: { percent: number }) {
  const circumference = 2 * Math.PI * 6;
  return (
    <svg viewBox="0 0 16 16" aria-hidden className="size-4 -rotate-90">
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="var(--line-strong)"
        strokeWidth="2"
      />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="var(--accent)"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={`${(percent / 100) * circumference} ${circumference}`}
      />
    </svg>
  );
}

// Just left of the window controls, only while there is something to act on. Restart restarts;
// everything else opens Settings › Updates.
export function UpdateIndicator() {
  const { data: status } = useUpdateStatus();
  const install = useInstallUpdate();
  const { navigate } = useNavigation();
  if (!status || !updateNeedsAttention(status)) return null;
  const open = () => navigate({ name: 'settings', section: 'updates' });
  const version = 'release' in status ? status.release?.version : undefined;

  if (
    status.phase === 'downloaded' ||
    status.phase === 'busy' ||
    status.phase === 'restarting'
  ) {
    const pending = status.phase === 'restarting' || install.isPending;
    return (
      <Tooltip
        label={`Restart gitdesk to install ${version ?? 'the update'}`}
        side="bottom"
      >
        <Button
          variant="primary"
          size="sm"
          className="no-drag h-7 px-2.5 text-[0.8125rem]"
          pending={pending}
          onClick={() => {
            // A running clone or push gets its question on the Updates page.
            if (status.phase === 'busy') open();
            else install.mutate('now');
          }}
        >
          {!pending && <RotateCcw />}
          Restart to update
        </Button>
      </Tooltip>
    );
  }

  if (status.phase === 'downloading') {
    const percent = Math.round(status.percent);
    return (
      <Tooltip
        label={`Downloading ${status.release.version}${status.bytesPerSecond > 0 ? ` · ${formatRate(status.bytesPerSecond)}` : ''}`}
        side="bottom"
      >
        <Button
          size="sm"
          className="no-drag h-7 px-2.5 text-[0.8125rem] tabular-nums"
          aria-label={`Downloading gitdesk ${status.release.version}, ${percent} percent. Open Updates.`}
          onClick={open}
        >
          <Ring percent={status.percent} />
          {percent}%
        </Button>
      </Tooltip>
    );
  }

  if (status.phase === 'error')
    return (
      <Tooltip label={status.message} side="bottom">
        <Button
          size="sm"
          className="no-drag h-7 px-2.5 text-[0.8125rem]"
          onClick={open}
        >
          <CircleAlert className="text-danger" />
          Update failed
        </Button>
      </Tooltip>
    );

  return (
    <Tooltip
      label={`gitdesk ${version} is available. Open Updates.`}
      side="bottom"
    >
      <Button
        size="sm"
        className="no-drag h-7 px-2.5 text-[0.8125rem]"
        onClick={open}
      >
        <Download className="text-accent" />
        Update {version}
      </Button>
    </Tooltip>
  );
}
