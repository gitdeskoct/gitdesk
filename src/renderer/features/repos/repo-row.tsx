import { Pin } from 'lucide-react';
import { useState } from 'react';
import type { RepositorySummary } from '../../../shared/repos';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { InlineStatus } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useOpenRepository, useRemoveRepository } from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { RepoContextMenu, RepoMenuButton, useRepoActions } from './repo-actions';
import { BranchLabel, SyncChip, TreeChip } from './status';

export function openedLabel(repo: RepositorySummary): string {
  return repo.lastOpenedAt
    ? `Opened ${relativeTime(repo.lastOpenedAt)}`
    : `Added ${relativeTime(repo.addedAt)}`;
}

// Opens the repository workspace in the same window; the shell stays mounted.
export function useOpenRepo() {
  const { navigate } = useNavigation();
  const open = useOpenRepository();
  return (id: string) => {
    navigate({ name: 'repository', id });
    open.mutate(id);
  };
}

export function RemoveConfirm({
  repo,
  onCancel,
}: {
  repo: RepositorySummary;
  onCancel: () => void;
}) {
  const remove = useRemoveRepository();
  return (
    <div
      role="group"
      aria-label={`Remove ${repo.name}`}
      className="flex flex-wrap items-center gap-3 bg-danger-soft px-3 py-2.5 text-[0.8125rem] text-ink"
    >
      <span className="min-w-0 flex-1">
        Remove <b className="font-semibold">{repo.name}</b> from gitdesk? The
        folder and its history stay on disk.
      </span>
      <Button
        size="sm"
        variant="danger"
        pending={remove.isPending}
        onClick={() => remove.mutate(repo.id, { onSuccess: onCancel })}
      >
        Remove
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel} autoFocus>
        Cancel
      </Button>
    </div>
  );
}

// A flat row: the whole row opens the repository, the overflow menu holds everything else.
export function RepoRow({
  repo,
  density,
}: {
  repo: RepositorySummary;
  density: 'comfortable' | 'compact';
}) {
  const openRepo = useOpenRepo();
  const [confirming, setConfirming] = useState(false);
  const { actions, error } = useRepoActions(repo, () => setConfirming(true));
  const missing = repo.availability !== 'available';

  return (
    <li className="border-b border-line">
      <RepoContextMenu actions={actions} onOpen={() => openRepo(repo.id)}>
        <div
          className={cn(
            'group relative grid grid-cols-[minmax(0,1.6fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(7rem,auto)_2rem] items-center gap-x-4 px-2 transition-colors hover:bg-row-hover',
            density === 'compact' ? 'py-1.5' : 'py-3',
          )}
        >
          {/* The row-wide button sits under the content; the menu button sits above it. */}
          <button
            type="button"
            onClick={() => openRepo(repo.id)}
            aria-label={`Open ${repo.name}`}
            className="absolute inset-0 rounded-sm focus-visible:outline-offset-[-2px]"
          />
          <div className="pointer-events-none min-w-0">
            <div
              className={cn(
                'flex items-center gap-2 text-sm font-semibold',
                missing ? 'text-muted' : 'text-ink',
              )}
            >
              <span className="truncate">{repo.name}</span>
              {repo.pinned && (
                <Pin aria-label="Pinned" className="size-3.5 shrink-0 text-muted" />
              )}
              {repo.inspecting && (
                <Spinner className="size-3.5 text-muted" />
              )}
            </div>
            {density === 'comfortable' && (
              <div
                className="mt-0.5 truncate font-mono text-xs text-muted"
                title={repo.displayPath}
              >
                {repo.description || repo.displayPath}
              </div>
            )}
          </div>
          <BranchLabel repo={repo} className="pointer-events-none" />
          <div className="pointer-events-none flex flex-wrap gap-x-3.5 gap-y-1">
            <TreeChip repo={repo} />
            <SyncChip repo={repo} />
          </div>
          <span className="pointer-events-none text-right text-xs whitespace-nowrap text-muted">
            {openedLabel(repo)}
          </span>
          <RepoMenuButton repo={repo} actions={actions} className="relative" />
        </div>
      </RepoContextMenu>
      {confirming && (
        <RemoveConfirm repo={repo} onCancel={() => setConfirming(false)} />
      )}
      {error && (
        <InlineStatus tone="danger" className="px-2 pb-2.5">
          {ipcErrorMessage(error, "That didn't work. Try again.")}
        </InlineStatus>
      )}
    </li>
  );
}
