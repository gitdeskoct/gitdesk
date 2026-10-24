import { Check } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import type { RepositorySummary } from '../../../shared/repos';
import {
  branchNameSchema,
  type LocalBranch,
  type SwitchResult,
} from '../../../shared/workspace';
import {
  BranchesArt,
  OfflineArt,
  RemoteArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { CopyButton } from '../../components/ui/copy-button';
import { EmptyState } from '../../components/ui/empty-state';
import { Loading } from '../../components/ui/status';
import { TextField } from '../../components/ui/text-field';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useBranches,
  useCreateBranch,
  useSwitchBranch,
} from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import type { SwitchOutcome } from './branch-picker';
import { Section } from './history';

// Upstream state in words: no zeros where there is nothing to compare against.
function upstreamWords(branch: LocalBranch): string {
  if (!branch.upstream) return 'No upstream';
  if (branch.gone) return `${branch.upstream} · upstream is gone`;
  return `${branch.upstream} · ahead ${branch.ahead ?? 0}, behind ${branch.behind ?? 0} at the last fetch`;
}

export function BranchesTab({
  repo,
  onOutcome,
}: {
  repo: RepositorySummary;
  onOutcome: (outcome: SwitchOutcome) => void;
}) {
  const { navigate } = useNavigation();
  const branches = useBranches(repo.id, repo.statusAt);
  const switchBranch = useSwitchBranch(repo.id);
  const createBranch = useCreateBranch(repo.id);
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState<string | null>(null);

  const handlers = (target: string) => ({
    onSuccess: (result: SwitchResult) => {
      setBusy(null);
      onOutcome({ target, result });
    },
    onError: (err: unknown) => {
      setBusy(null);
      onOutcome({
        target,
        error: ipcErrorMessage(err, 'Git did not switch. Try again.'),
      });
    },
  });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = branchNameSchema.safeParse(name);
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message);
      return;
    }
    setBusy(parsed.data);
    createBranch.mutate(parsed.data, {
      ...handlers(parsed.data),
      onSuccess: (result) => {
        setBusy(null);
        onOutcome({ target: parsed.data, result });
        if (result.status === 'switched') setName('');
      },
    });
  };

  if (branches.isPending) return <Loading label="Reading branches…" />;
  if (branches.isError)
    return (
      <EmptyState
        art={<OfflineArt />}
        title="Couldn't read the branches"
        action={
          <Button
            pending={branches.isFetching}
            onClick={() => void branches.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(branches.error, 'Git did not answer.')}
      </EmptyState>
    );

  const data = branches.data;
  const from = data.current ?? (data.headOid ? data.headOid.slice(0, 7) : null);
  return (
    <>
      <Section id="new-branch-heading" title="New branch" className="mt-6">
        <form
          onSubmit={submit}
          noValidate
          className="flex flex-wrap items-start gap-3 border-t border-line pt-3"
        >
          <TextField
            label="Branch name"
            hideLabel
            className="w-72 font-mono"
            value={name}
            onChange={(event) => {
              setName(event.target.value);
              setError(undefined);
            }}
            error={error}
            placeholder="feature/name"
            spellCheck={false}
          />
          <Button
            type="submit"
            variant="primary"
            pending={createBranch.isPending}
          >
            Create and switch
          </Button>
          <p className="basis-full text-[0.8125rem] text-muted">
            {from
              ? `Starts from ${from}. Uncommitted changes come along to the new branch.`
              : 'This repository has no commits yet, so the new branch starts empty.'}
          </p>
        </form>
      </Section>

      <Section
        id="local-branches-heading"
        title="On this computer"
        meta="Ahead and behind as of the last fetch"
      >
        {!data.local.length ? (
          <EmptyState
            compact
            className="border-t border-line"
            art={<BranchesArt />}
            title={
              data.current
                ? `${data.current} has no commits yet`
                : 'No branches yet'
            }
            action={
              <Button
                size="sm"
                onClick={() =>
                  navigate({ name: 'repository', id: repo.id, tab: 'changes' })
                }
              >
                Go to Changes
              </Button>
            }
          >
            A branch needs a commit to point at, so this list fills after the
            first one.
          </EmptyState>
        ) : (
          <ul className="border-t border-line">
            {data.local.map((branch) => (
              <li
                key={branch.name}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line py-2.5"
              >
                <div className="min-w-64 flex-1">
                  <div className="flex items-center gap-2 font-mono text-[0.8125rem] text-ink">
                    <span
                      className={branch.current ? 'font-semibold' : undefined}
                    >
                      {branch.name}
                    </span>
                    {branch.current && (
                      <span className="inline-flex items-center gap-1 font-sans text-xs font-medium">
                        <Check aria-hidden className="size-3.5 text-success" />
                        Current
                      </span>
                    )}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {branch.otherWorktree
                      ? 'Checked out in another worktree · '
                      : ''}
                    {upstreamWords(branch)}
                    {branch.subject ? ` · ${branch.subject}` : ''}
                    {branch.at ? ` · ${relativeTime(branch.at)}` : ''}
                  </div>
                </div>
                {!branch.current && (
                  <Button
                    size="sm"
                    pending={busy === branch.name}
                    aria-disabled={
                      branch.otherWorktree ||
                      (!!busy && busy !== branch.name) ||
                      undefined
                    }
                    onClick={() => {
                      if (branch.otherWorktree || busy) return;
                      setBusy(branch.name);
                      switchBranch.mutate(
                        { name: branch.name, kind: 'local' },
                        handlers(branch.name),
                      );
                    }}
                  >
                    Switch
                  </Button>
                )}
                <CopyButton
                  value={branch.name}
                  label="branch name"
                  text="Copy name"
                />
              </li>
            ))}
          </ul>
        )}
        {data.truncated && (
          <p className="mt-2 text-xs text-muted">
            Showing the 1,000 most recently committed branches.
          </p>
        )}
      </Section>

      <Section
        id="remote-branches-heading"
        title="Remote-tracking"
        meta="Local copies of remote branches, updated by Fetch"
      >
        {!data.remote.length ? (
          <EmptyState
            compact
            className="border-t border-line"
            art={<RemoteArt />}
            title="No remote-tracking branches"
            action={
              <Button
                size="sm"
                onClick={() =>
                  navigate({ name: 'repository', id: repo.id, tab: 'remotes' })
                }
              >
                Open Remotes
              </Button>
            }
          >
            Fetch from a remote on the Remotes tab to see its branches here.
          </EmptyState>
        ) : (
          <ul className="border-t border-line">
            {data.remote.map((branch) => (
              <li
                key={branch.name}
                className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line py-2.5"
              >
                <div className="min-w-64 flex-1">
                  <div className="font-mono text-[0.8125rem] text-ink">
                    {branch.name}
                  </div>
                  <div className="mt-0.5 text-xs text-muted">
                    {branch.subject || 'No message'}
                    {branch.at ? ` · ${relativeTime(branch.at)}` : ''}
                  </div>
                </div>
                {branch.hasLocal ? (
                  <span className="text-xs text-muted">Has a local branch</span>
                ) : (
                  <Button
                    size="sm"
                    pending={busy === branch.name}
                    aria-disabled={
                      (!!busy && busy !== branch.name) || undefined
                    }
                    onClick={() => {
                      if (busy) return;
                      setBusy(branch.name);
                      switchBranch.mutate(
                        { name: branch.name, kind: 'remote' },
                        handlers(branch.name),
                      );
                    }}
                  >
                    Check out as {branch.branch}
                  </Button>
                )}
              </li>
            ))}
          </ul>
        )}
      </Section>
    </>
  );
}
