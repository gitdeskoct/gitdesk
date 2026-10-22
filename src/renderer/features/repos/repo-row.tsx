import { FolderOpen, Pin } from 'lucide-react';
import { useState } from 'react';
import type { RepositorySummary } from '../../../shared/repos';
import { Button } from '../../components/ui/button';
import { Spinner } from '../../components/ui/spinner';
import { Tooltip } from '../../components/ui/tooltip';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { useOpenRepository } from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import {
  fileManagerLabel,
  RepoContextMenu,
  RepoMenuButton,
  useRepoActions,
} from './repo-actions';
import { ManageBand, type ManageMode } from './manage';
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

// A flat row: the whole row opens the repository, the overflow menu holds everything else.
// Each row is its own size container, so it narrows the same way in a wide list and a side column.
export function RepoRow({
  repo,
  density,
}: {
  repo: RepositorySummary;
  density: 'comfortable' | 'compact';
}) {
  const openRepo = useOpenRepo();
  const [mode, setMode] = useState<ManageMode | null>(null);
  const { actions, busy, reveal } = useRepoActions(repo, setMode);
  const present = repo.availability === 'available';

  return (
    <li className="@container border-b border-line">
      <RepoContextMenu actions={actions} onOpen={() => openRepo(repo.id)}>
        <div
          className={cn(
            'group relative grid grid-cols-[minmax(0,1fr)_auto_4.5rem] items-center gap-x-4 px-2 transition-colors hover:bg-row-hover',
            '@min-[640px]:grid-cols-[minmax(0,1.7fr)_minmax(0,1fr)_minmax(0,1.2fr)_minmax(7rem,auto)_4.5rem]',
            density === 'compact' ? 'py-1.5' : 'py-3',
          )}
        >
          {/* The row-wide button sits under the content; the row's own buttons sit above it. */}
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
                present ? 'text-ink' : 'text-muted',
              )}
            >
              <span className="truncate">{repo.name}</span>
              {repo.pinned && (
                <Pin
                  aria-label="Pinned"
                  className="size-3.5 shrink-0 text-muted"
                />
              )}
              {repo.inspecting && !busy && (
                <Spinner className="size-3.5 text-muted" />
              )}
            </div>
            <div
              className="mt-0.5 truncate text-xs text-muted"
              title={repo.displayPath}
            >
              {density === 'comfortable' &&
                repo.description &&
                `${repo.description} · `}
              <span className="font-mono">{repo.displayPath}</span>
            </div>
          </div>
          <BranchLabel
            repo={repo}
            className="pointer-events-none hidden @min-[640px]:flex"
          />
          <div className="pointer-events-none flex flex-wrap gap-x-3.5 gap-y-1">
            {busy ? (
              <span className="inline-flex items-center gap-1.5 text-[0.8125rem] text-muted">
                <Spinner className="size-3.5" />
                {busy}
              </span>
            ) : (
              <>
                <TreeChip repo={repo} />
                <SyncChip repo={repo} />
              </>
            )}
          </div>
          <span className="pointer-events-none hidden text-right text-xs whitespace-nowrap text-muted @min-[640px]:block">
            {openedLabel(repo)}
          </span>
          <div className="relative flex justify-end gap-0.5">
            {present && (
              <Tooltip label={fileManagerLabel()} side="left">
                <Button
                  variant="ghost"
                  size="icon"
                  aria-label={`${fileManagerLabel()}: ${repo.name}`}
                  pending={reveal.isPending}
                  onClick={() =>
                    actions
                      .find((action) => action.key === 'reveal')
                      ?.onSelect()
                  }
                  className="opacity-0 group-hover:opacity-100 focus-visible:opacity-100 aria-busy:opacity-100"
                >
                  {!reveal.isPending && <FolderOpen />}
                </Button>
              </Tooltip>
            )}
            <RepoMenuButton name={repo.name} actions={actions} />
          </div>
        </div>
      </RepoContextMenu>
      {mode && (
        <ManageBand mode={mode} repo={repo} onClose={() => setMode(null)} />
      )}
    </li>
  );
}
