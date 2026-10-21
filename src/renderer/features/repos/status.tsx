import {
  ArrowDown,
  ArrowUp,
  CircleAlert,
  CircleCheck,
  CloudOff,
  FolderX,
  GitBranch,
  GitMerge,
  Pencil,
  type LucideIcon,
} from 'lucide-react';
import type { RepositorySummary } from '../../../shared/repos';
import { cn } from '../../lib/cn';
import { changeCount, syncState, treeState } from '../../lib/repo-status';

const TONES = {
  ok: 'text-success',
  warn: 'text-warning',
  bad: 'text-danger',
  accent: 'text-accent',
  muted: 'text-muted',
};

// Icon plus word in ink; the color sits on the icon only, so meaning never rests on color.
function Chip({
  icon: Icon,
  tone,
  quiet,
  children,
}: {
  icon?: LucideIcon;
  tone: keyof typeof TONES;
  quiet?: boolean;
  children: string;
}) {
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 text-[0.8125rem] whitespace-nowrap',
        quiet ? 'text-muted' : 'font-medium text-ink',
      )}
    >
      {Icon && <Icon aria-hidden className={cn('size-3.5', TONES[tone])} />}
      {children}
    </span>
  );
}

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

export function TreeChip({ repo }: { repo: RepositorySummary }) {
  if (repo.availability === 'missing')
    return <Chip icon={FolderX} tone="bad">Folder missing</Chip>;
  if (repo.availability === 'not-a-repo')
    return <Chip icon={CircleAlert} tone="bad">Not a repository</Chip>;
  if (repo.error && !repo.status)
    return <Chip icon={CircleAlert} tone="bad">Can't read</Chip>;
  const state = treeState(repo);
  if (state === 'unknown') return <Chip tone="muted" quiet>Not checked yet</Chip>;
  if (state === 'conflict')
    return (
      <Chip icon={GitMerge} tone="bad">
        {plural(repo.status!.conflicts, 'conflict')}
      </Chip>
    );
  if (state === 'changed')
    return (
      <Chip icon={Pencil} tone="warn">{`${changeCount(repo.status)} changed`}</Chip>
    );
  return <Chip icon={CircleCheck} tone="ok">Clean</Chip>;
}

export function SyncChip({ repo }: { repo: RepositorySummary }) {
  const state = syncState(repo);
  const status = repo.status;
  switch (state) {
    case 'unknown':
      return null;
    case 'no-remote':
      return <Chip icon={CloudOff} tone="muted" quiet>No remote</Chip>;
    case 'no-upstream':
      return <Chip tone="muted" quiet>No upstream</Chip>;
    case 'up-to-date':
      return <Chip tone="muted" quiet>Up to date</Chip>;
    case 'ahead':
      return <Chip icon={ArrowUp} tone="accent">{`${status!.ahead} to push`}</Chip>;
    case 'behind':
      return <Chip icon={ArrowDown} tone="warn">{`${status!.behind} behind`}</Chip>;
    case 'diverged':
      return (
        <Chip icon={GitBranch} tone="warn">
          {`Diverged ${status!.ahead}↑ ${status!.behind}↓`}
        </Chip>
      );
  }
}

export function BranchLabel({
  repo,
  className,
}: {
  repo: RepositorySummary;
  className?: string;
}) {
  const status = repo.status;
  const label =
    repo.availability !== 'available' || !status
      ? null
      : status.detached
        ? `Detached at ${status.headOid?.slice(0, 7) ?? 'HEAD'}`
        : status.branch;
  return (
    <span
      className={cn(
        'flex min-w-0 items-center gap-1.5 font-mono text-[0.78125rem]',
        label ? 'text-ink' : 'text-muted',
        className,
      )}
    >
      <GitBranch aria-hidden className="size-3.5 shrink-0 text-muted" />
      <span className="truncate" title={label ?? undefined}>
        {label ?? 'Unknown'}
      </span>
    </span>
  );
}
