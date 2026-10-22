import { cn } from '../../lib/cn';
import { useConnection } from '../../lib/network';

const FILL = ['', 'bg-danger', 'bg-warning', 'bg-success', 'bg-success'];
const HEIGHTS = ['h-1', 'h-[7px]', 'h-2.5', 'h-3.5'];

// Four bars and words: the words carry the meaning, the bars are a glance. Values are the
// system's estimate, so they read "about", never as a measured speed.
export function ConnectionStrength({ className }: { className?: string }) {
  const quality = useConnection();
  const detail = [
    quality.rtt !== null && quality.level > 0 && `${quality.rtt} ms`,
    quality.downlink !== null &&
      quality.level > 0 &&
      `about ${quality.downlink >= 10 ? Math.round(quality.downlink) : quality.downlink} Mbps`,
  ].filter(Boolean);
  return (
    <span
      className={cn(
        'flex items-center gap-2 text-[0.8125rem] text-muted',
        className,
      )}
    >
      <span aria-hidden className="inline-flex h-3.5 items-end gap-0.5">
        {HEIGHTS.map((height, index) => (
          <span
            key={height}
            className={cn(
              'block w-[3px]',
              height,
              index < quality.level ? FILL[quality.level] : 'bg-line-strong',
            )}
          />
        ))}
      </span>
      <span>
        {quality.level === 0 ? 'Offline' : `${quality.label} connection`}
        {detail.length > 0 && ` · ${detail.join(' · ')}`}
      </span>
    </span>
  );
}
