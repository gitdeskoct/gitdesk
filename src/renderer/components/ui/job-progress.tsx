import * as Progress from '@radix-ui/react-progress';
import type { ProgressEvent } from '../../../shared/repos';
import { cn } from '../../lib/cn';
import { formatBytes, formatRate } from '../../lib/format';
import { ConnectionStrength } from './network';

// Time left from Git's own numbers: total ≈ received ÷ fraction done. Only while receiving,
// the one stage where the percent tracks bytes.
function secondsLeft(progress: ProgressEvent): number | null {
  const { percent, receivedBytes, bytesPerSecond } = progress;
  if (!receivedBytes || !bytesPerSecond || percent <= 0 || percent >= 100)
    return null;
  const total = (receivedBytes * 100) / percent;
  return Math.max(1, Math.round((total - receivedBytes) / bytesPerSecond));
}

// One long job: what it is doing, a 6px bar, and under it what the network is doing.
export function JobProgress({
  label,
  stage,
  right,
  percent,
  progress,
  network,
  tone = 'accent',
}: {
  label: string;
  stage: string;
  right: string;
  percent: number;
  progress?: ProgressEvent | null;
  // Show the connection line: the step moves data over the network.
  network: boolean;
  tone?: 'accent' | 'success' | 'warning';
}) {
  const left = progress ? secondsLeft(progress) : null;
  const transfer = [
    progress?.bytesPerSecond != null && (
      <b key="rate" className="font-semibold text-ink tabular-nums">
        {formatRate(progress.bytesPerSecond)}
      </b>
    ),
    progress?.receivedBytes != null &&
      `${formatBytes(progress.receivedBytes)} received`,
    left !== null && `about ${left} s left`,
  ].filter(Boolean);
  return (
    <div className="grid gap-2">
      <div className="flex justify-between gap-3 text-sm">
        <span className="font-medium text-ink">{stage}</span>
        <span className="text-muted tabular-nums">{right}</span>
      </div>
      <Progress.Root
        value={percent}
        aria-label={label}
        aria-valuetext={`${stage}, ${right}`}
        className="h-1.5 overflow-hidden rounded-[4px] bg-control"
      >
        <Progress.Indicator
          className={cn(
            'h-full transition-[width] duration-300',
            tone === 'success'
              ? 'bg-success'
              : tone === 'warning'
                ? 'bg-warning'
                : 'bg-accent',
          )}
          style={{ width: `${Math.max(2, Math.min(100, percent))}%` }}
        />
      </Progress.Root>
      {transfer.length > 0 && (
        <div className="flex flex-wrap items-center gap-x-3.5 gap-y-1 text-[0.8125rem] text-muted">
          {transfer.map((part, index) => (
            <span key={index}>{part}</span>
          ))}
        </div>
      )}
      {network && <ConnectionStrength />}
    </div>
  );
}
