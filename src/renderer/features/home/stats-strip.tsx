import { AnimatePresence, motion } from 'framer-motion';
import { Clock } from 'lucide-react';
import type { ReactNode } from 'react';
import type { RemoteOverview } from '../../../shared/repos';
import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import type { WorkspaceStats } from '../../lib/repo-status';
import { useNavigation } from '../../app/navigation';

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

// Each statistic is a way in: it opens the view that lists exactly what it counts. Where the
// strip is itself the filter, `pressed` marks the one in use.
export function Stat({
  value,
  label,
  context,
  muted,
  pressed,
  onSelect,
}: {
  value: string;
  label: string;
  context: ReactNode;
  muted?: boolean;
  pressed?: boolean;
  onSelect: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-pressed={pressed}
      className="relative grid min-w-0 content-start gap-1 border-l border-line px-5 pt-4.5 pb-4 text-left transition-colors first:border-l-0 first:pl-0 hover:bg-row-hover focus-visible:outline-offset-[-2px] aria-pressed:after:absolute aria-pressed:after:inset-x-0 aria-pressed:after:-bottom-px aria-pressed:after:h-0.5 aria-pressed:after:bg-accent"
    >
      <Value value={value} muted={muted} />
      <span className="text-[0.8125rem] font-medium text-ink">{label}</span>
      <span className="flex min-w-0 items-center gap-1.5 text-xs text-muted">
        {context}
      </span>
    </button>
  );
}

export function remoteContext(
  remote: RemoteOverview | undefined,
  failed: boolean,
): {
  value: string;
  context: ReactNode;
  muted: boolean;
} {
  if (!remote)
    return {
      value: '—',
      context: failed ? 'Not loaded · try again' : 'Loading…',
      muted: true,
    };
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
// a number that can't be verified is a dash or says what is unknown, never a guess shown as fact.
export function StatsStrip({
  stats,
  remote,
  remoteFailed,
  onRemote,
}: {
  stats: WorkspaceStats;
  remote: RemoteOverview | undefined;
  remoteFailed: boolean;
  onRemote: () => void;
}) {
  const { navigate } = useNavigation();
  const remoteStat = remoteContext(remote, remoteFailed);
  const unknown = stats.unchecked > 0 && (
    <span className="truncate">{stats.unchecked} not checked yet</span>
  );
  return (
    <div
      role="group"
      aria-label="Workspace summary"
      className="grid grid-cols-2 border-y border-line @min-[640px]:grid-cols-4 [&>button:nth-child(3)]:border-l-0 @min-[640px]:[&>button:nth-child(3)]:border-l [&>button:nth-child(-n+2)]:border-b @min-[640px]:[&>button:nth-child(-n+2)]:border-b-0"
    >
      <Stat
        value={String(stats.local)}
        label="Local repositories"
        onSelect={() => navigate({ name: 'repositories' })}
        context={
          stats.checking > 0 ? (
            <>
              <Spinner className="size-3.5" />
              <span className="truncate">Checking {stats.checking}</span>
            </>
          ) : stats.missing > 0 ? (
            <span className="truncate">
              {stats.missing} {stats.missing === 1 ? 'folder' : 'folders'}{' '}
              missing
            </span>
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
        onSelect={() => navigate({ name: 'repositories', show: 'changed' })}
        context={
          unknown || (
            <span className="truncate">Uncommitted or untracked files</span>
          )
        }
      />
      <Stat
        value={String(stats.ahead)}
        label="Branches ahead"
        onSelect={() => navigate({ name: 'repositories', show: 'ahead' })}
        context={
          unknown || (
            <span className="truncate">Against the last fetched upstream</span>
          )
        }
      />
      <Stat
        value={remoteStat.value}
        label="Remote repositories"
        muted={remoteStat.muted}
        onSelect={onRemote}
        context={remoteStat.context}
      />
    </div>
  );
}
