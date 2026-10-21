import { AnimatePresence, motion } from 'framer-motion';
import { Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RemoteOverview } from '../../../shared/repos';
import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import type { WorkspaceStats } from '../../lib/repo-status';

export type StatFilter = 'all' | 'changed' | 'ahead' | 'remote';

// The value keeps proportional figures at display size; only a changed value animates, once.
function Value({ value, muted }: { value: string; muted?: boolean }) {
  return (
    <span className="relative block h-9 overflow-hidden">
      <AnimatePresence initial={false} mode="popLayout">
        <motion.span
          key={value}
          initial={{ y: 12, opacity: 0 }}
          animate={{ y: 0, opacity: 1 }}
          exit={{ y: -12, opacity: 0 }}
          transition={{ duration: 0.18, ease: 'easeOut' }}
          className={cn(
            'block text-[1.875rem] leading-9 font-semibold tracking-[-0.02em]',
            muted ? 'text-muted' : 'text-ink',
          )}
        >
          {value}
        </motion.span>
      </AnimatePresence>
    </span>
  );
}

function Stat({
  value,
  label,
  context,
  selected,
  muted,
  onSelect,
}: {
  value: string;
  label: string;
  context: ReactNode;
  selected: boolean;
  muted?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onSelect}
      className={cn(
        'relative grid content-start gap-1 border-l border-line px-5 pt-4.5 pb-4 text-left transition-colors first:border-l-0 first:pl-0 hover:bg-row-hover focus-visible:outline-offset-[-2px]',
        'after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:bg-accent after:opacity-0 after:transition-opacity aria-pressed:after:opacity-100 first:after:left-0',
      )}
    >
      <Value value={value} muted={muted} />
      <span className="text-[0.8125rem] font-medium text-ink">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
        {context}
      </span>
    </button>
  );
}

function remoteContext(remote: RemoteOverview | undefined): {
  value: string;
  context: ReactNode;
  muted: boolean;
} {
  if (!remote) return { value: '—', context: 'Loading…', muted: true };
  if (remote.state === 'signed-out')
    return { value: '—', context: 'Sign in to see your remote', muted: true };
  if (remote.state === 'never' || remote.total === null)
    return {
      value: '—',
      context:
        remote.error === 'offline'
          ? 'Not loaded · offline'
          : remote.error
            ? 'Not loaded · server unavailable'
            : 'Not loaded yet',
      muted: true,
    };
  const age = remote.fetchedAt ? relativeTime(remote.fetchedAt) : '';
  if (remote.state === 'cached')
    return {
      value: String(remote.total),
      muted: true,
      context: (
        <>
          <Clock aria-hidden className="size-3.5 shrink-0 text-warning" />
          <span className="truncate">Cached · {age}</span>
        </>
      ),
    };
  return {
    value: String(remote.total),
    muted: false,
    context: <span className="truncate">Your account · updated {age}</span>,
  };
}

// One strip, hairline dividers, no tiles. Every number names where it came from and how old it is;
// a number that can't be verified is a dash, never a stale value dressed up as current.
export function StatsStrip({
  stats,
  remote,
  filter,
  onFilter,
}: {
  stats: WorkspaceStats;
  remote: RemoteOverview | undefined;
  filter: StatFilter;
  onFilter: (filter: StatFilter) => void;
}) {
  const remoteStat = remoteContext(remote);
  const toggle = (next: StatFilter) => onFilter(filter === next ? 'all' : next);
  return (
    <div
      role="group"
      aria-label="Workspace summary"
      className="grid grid-cols-2 border-y border-line @min-[640px]:grid-cols-4 [&>button:nth-child(3)]:border-l-0 @min-[640px]:[&>button:nth-child(3)]:border-l [&>button:nth-child(-n+2)]:border-b @min-[640px]:[&>button:nth-child(-n+2)]:border-b-0"
    >
      <Stat
        value={String(stats.local)}
        label="Local repositories"
        selected={filter === 'all'}
        onSelect={() => onFilter('all')}
        context={
          stats.checking > 0 ? (
            <>
              <Spinner className="size-3.5" />
              <span className="truncate">Checking {stats.checking}</span>
            </>
          ) : (
            <span className="truncate">
              {stats.oldestCheck
                ? `On disk · checked ${relativeTime(stats.oldestCheck)}`
                : 'Registered on this computer'}
            </span>
          )
        }
      />
      <Stat
        value={String(stats.changed)}
        label="With changes"
        selected={filter === 'changed'}
        onSelect={() => toggle('changed')}
        context={<span className="truncate">Uncommitted or untracked files</span>}
      />
      <Stat
        value={String(stats.ahead)}
        label="Branches ahead"
        selected={filter === 'ahead'}
        onSelect={() => toggle('ahead')}
        context={<span className="truncate">Current branch, known upstream</span>}
      />
      <Stat
        value={remoteStat.value}
        label="Remote repositories"
        muted={remoteStat.muted}
        selected={filter === 'remote'}
        onSelect={() => toggle('remote')}
        context={remoteStat.context}
      />
    </div>
  );
}
