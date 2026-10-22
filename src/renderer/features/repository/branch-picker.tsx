import * as Popover from '@radix-ui/react-popover';
import {
  Check,
  ChevronDown,
  CloudDownload,
  GitBranch,
  Plus,
} from 'lucide-react';
import { useState } from 'react';
import { branchNameSchema, type SwitchResult } from '../../../shared/workspace';
import type { RepositorySummary } from '../../../shared/repos';
import { Button } from '../../components/ui/button';
import { Loading } from '../../components/ui/status';
import { Spinner } from '../../components/ui/spinner';
import { cn } from '../../lib/cn';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { relativeTime } from '../../lib/format';
import {
  useBranches,
  useCreateBranch,
  useSwitchBranch,
} from '../../lib/queries';

export type SwitchOutcome =
  | { target: string; result: SwitchResult }
  | { target: string; error: string };

// The branch switcher in the repository header: find, switch, check out a remote branch, or
// create one. Git decides whether a switch is safe; a refusal is reported, never forced.
export function BranchPicker({
  repo,
  onOutcome,
}: {
  repo: RepositorySummary;
  onOutcome: (outcome: SwitchOutcome) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const branches = useBranches(repo.id, repo.statusAt, open);
  const switchBranch = useSwitchBranch(repo.id);
  const createBranch = useCreateBranch(repo.id);
  const [busy, setBusy] = useState<string | null>(null);
  const status = repo.status;
  const label = status?.detached
    ? `Detached at ${status.headOid?.slice(0, 7) ?? 'unknown'}`
    : (status?.branch ?? 'No branch');

  const q = query.trim().toLowerCase();
  const local = (branches.data?.local ?? []).filter((b) =>
    b.name.toLowerCase().includes(q),
  );
  const remote = (branches.data?.remote ?? []).filter(
    (b) => !b.hasLocal && b.name.toLowerCase().includes(q),
  );
  const exists = branches.data?.local.some((b) => b.name === query.trim());
  const valid = branchNameSchema.safeParse(query.trim()).success;

  const done = (target: string) => ({
    onSuccess: (result: SwitchResult) => {
      setBusy(null);
      onOutcome({ target, result });
      if (result.status === 'switched') setOpen(false);
    },
    onError: (err: unknown) => {
      setBusy(null);
      onOutcome({
        target,
        error: ipcErrorMessage(err, 'Git did not switch. Try again.'),
      });
    },
  });
  const run = (name: string, kind: 'local' | 'remote') => {
    if (busy) return;
    setBusy(name);
    switchBranch.mutate({ name, kind }, done(name));
  };

  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger asChild>
        <Button size="sm" aria-label={`Branch: ${label}. Switch branch`}>
          <GitBranch />
          <span className="max-w-48 truncate font-mono text-[0.78125rem]">
            {label}
          </span>
          <ChevronDown />
        </Button>
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Content
          align="start"
          sideOffset={6}
          aria-label="Switch branch"
          className="z-50 w-80 rounded-sm border border-line bg-raised p-1.5 shadow-[0_8px_24px_rgb(0_0_0/0.14)]"
        >
          <label className="field flex h-8 items-center px-2.5">
            <span className="sr-only">Find or name a branch</span>
            <input
              autoFocus
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              placeholder="Find or create a branch"
              spellCheck={false}
              className="min-w-0 flex-1 bg-transparent font-mono text-[0.78125rem] text-ink outline-none placeholder:font-sans placeholder:text-muted"
            />
          </label>
          <div className="mt-1 max-h-80 overflow-auto">
            {branches.isPending && <Loading label="Reading branches…" />}
            {branches.isError && (
              <p className="px-2 py-3 text-[0.8125rem] text-ink">
                {ipcErrorMessage(branches.error, "Couldn't read the branches.")}
              </p>
            )}
            {local.length > 0 && (
              <p className="px-2 pt-2 pb-1 text-xs text-muted">
                On this computer
              </p>
            )}
            {local.map((branch) => (
              <button
                key={branch.name}
                type="button"
                aria-disabled={branch.otherWorktree || undefined}
                onClick={() =>
                  !branch.otherWorktree && run(branch.name, 'local')
                }
                className={cn(
                  'flex h-8 w-full items-center gap-2 rounded-[4px] px-2 text-left hover:bg-control focus-visible:outline-offset-[-2px]',
                  branch.otherWorktree && 'opacity-60',
                )}
              >
                <span className="grid size-4 place-items-center">
                  {busy === branch.name ? (
                    <Spinner />
                  ) : branch.current ? (
                    <Check
                      aria-label="Current branch"
                      className="size-4 text-success"
                    />
                  ) : null}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[0.78125rem]">
                  {branch.name}
                </span>
                <span className="shrink-0 text-xs text-muted">
                  {branch.otherWorktree
                    ? 'In another worktree'
                    : branch.at
                      ? relativeTime(branch.at)
                      : ''}
                </span>
              </button>
            ))}
            {remote.length > 0 && (
              <p className="px-2 pt-2 pb-1 text-xs text-muted">
                Only on a remote
              </p>
            )}
            {remote.slice(0, 50).map((branch) => (
              <button
                key={branch.name}
                type="button"
                onClick={() => run(branch.name, 'remote')}
                className="flex h-8 w-full items-center gap-2 rounded-[4px] px-2 text-left hover:bg-control focus-visible:outline-offset-[-2px]"
              >
                <span className="grid size-4 place-items-center">
                  {busy === branch.name ? (
                    <Spinner />
                  ) : (
                    <CloudDownload aria-hidden className="size-4 text-muted" />
                  )}
                </span>
                <span className="min-w-0 flex-1 truncate font-mono text-[0.78125rem]">
                  {branch.name}
                </span>
                <span className="shrink-0 text-xs text-muted">Check out</span>
              </button>
            ))}
            {branches.isSuccess &&
              !local.length &&
              !remote.length &&
              !query.trim() && (
                <p className="px-2 py-3 text-[0.8125rem] text-muted">
                  No branches yet. A branch needs a first commit to point at.
                </p>
              )}
          </div>
          {query.trim() && !exists && (
            <div className="mt-1 border-t border-line pt-1">
              <button
                type="button"
                aria-disabled={!valid || !!busy || undefined}
                onClick={() => {
                  if (!valid || busy) return;
                  const name = query.trim();
                  setBusy(name);
                  createBranch.mutate(name, done(name));
                }}
                className="flex h-8 w-full items-center gap-2 rounded-[4px] px-2 text-left text-[0.8125rem] hover:bg-control aria-disabled:opacity-60"
              >
                {busy === query.trim() ? (
                  <Spinner />
                ) : (
                  <Plus aria-hidden className="size-4 text-muted" />
                )}
                {valid ? (
                  <span>
                    Create branch{' '}
                    <b className="font-mono font-semibold">{query.trim()}</b>{' '}
                    from {status?.branch ?? 'here'}
                  </span>
                ) : (
                  <span className="text-muted">
                    Use letters, numbers, dots, dashes, slashes or underscores.
                  </span>
                )}
              </button>
            </div>
          )}
        </Popover.Content>
      </Popover.Portal>
    </Popover.Root>
  );
}
