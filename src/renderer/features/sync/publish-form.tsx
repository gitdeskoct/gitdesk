import { useState } from 'react';
import type { RepositorySummary } from '../../../shared/repos';
import type { SyncOverview } from '../../../shared/sync';
import { branchNameSchema } from '../../../shared/workspace';
import { Button } from '../../components/ui/button';
import { TextField } from '../../components/ui/text-field';
import { InlineStatus } from '../../components/ui/status';
import { useToast } from '../../components/ui/toast';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useBranches, useRemotes } from '../../lib/queries';
import { usePublish, useSetUpstream } from '../../lib/sync-queries';

// A native select, as Repository settings uses: Radix Select would need a style tag the CSP blocks.
function Picker({
  label,
  value,
  onChange,
  options,
  placeholder,
}: {
  label: string;
  value: string;
  onChange: (value: string) => void;
  options: string[];
  placeholder: string;
}) {
  return (
    <label className="grid gap-1.5 text-sm font-medium text-ink">
      {label}
      <select
        value={value}
        onChange={(event) => onChange(event.target.value)}
        className="field h-9 min-w-44 px-2.5 font-mono text-[0.78125rem] font-normal"
      >
        {!value && <option value="">{placeholder}</option>}
        {options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    </label>
  );
}

// A branch without an upstream either goes to a remote under a name you choose (publish) or
// follows a branch the remote already has (track). Publish never forces.
export function PublishForm({
  repo,
  sync,
}: {
  repo: RepositorySummary;
  sync: SyncOverview;
}) {
  const remotes = useRemotes(repo.id, repo.statusAt);
  const branches = useBranches(repo.id, repo.statusAt);
  const publish = usePublish(repo.id);
  const track = useSetUpstream(repo.id);
  const toast = useToast();
  const names = remotes.data?.map((r) => r.name) ?? [];
  const [remote, setRemote] = useState('');
  const [name, setName] = useState(sync.branch ?? '');
  const [existing, setExisting] = useState('');
  const [error, setError] = useState<string | null>(null);
  const chosenRemote =
    remote ||
    sync.remote ||
    (names.includes('origin') ? 'origin' : (names[0] ?? ''));
  const onRemote = (branches.data?.remote ?? [])
    .filter((b) => b.remote === chosenRemote)
    .map((b) => b.branch);
  const valid = branchNameSchema.safeParse(name.trim());

  return (
    <div className="grid gap-4 border-t border-line pt-4">
      <form
        className="flex flex-wrap items-end gap-3"
        onSubmit={(event) => {
          event.preventDefault();
          if (!valid.success || !chosenRemote || publish.isPending) return;
          setError(null);
          publish.mutate(
            {
              jobId: crypto.randomUUID(),
              remote: chosenRemote,
              branch: valid.data,
            },
            {
              onSuccess: (result) =>
                result.status === 'pushed'
                  ? toast({
                      tone: 'success',
                      title: `Published ${sync.branch} as ${chosenRemote}/${valid.data}`,
                    })
                  : setError(result.message),
              onError: (err) =>
                setError(ipcErrorMessage(err, "Git couldn't publish.")),
            },
          );
        }}
      >
        <Picker
          label="Remote"
          value={chosenRemote}
          onChange={setRemote}
          options={names}
          placeholder="Choose a remote"
        />
        <div className="min-w-56 flex-1">
          <TextField
            label={`Branch name on ${chosenRemote || 'the remote'}`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={
              name && !valid.success
                ? 'Use letters, numbers, dots, dashes, underscores and slashes.'
                : undefined
            }
            spellCheck={false}
          />
        </div>
        <Button
          type="submit"
          variant="primary"
          pending={publish.isPending}
          aria-disabled={!valid.success || !chosenRemote || undefined}
        >
          Publish {sync.branch}
        </Button>
      </form>
      <p className="text-xs text-muted">
        Publishing pushes this branch and tracks it. Nothing on the remote is
        overwritten: a branch that already has other commits refuses the push.
      </p>

      <div className="flex flex-wrap items-end gap-3 border-t border-line pt-4">
        <Picker
          label={`Track a branch on ${chosenRemote || 'the remote'}`}
          value={existing}
          onChange={setExisting}
          options={onRemote}
          placeholder={onRemote.length ? 'Choose a branch' : 'None fetched yet'}
        />
        <Button
          pending={track.isPending}
          aria-disabled={!existing || undefined}
          onClick={() => {
            if (!existing || track.isPending) return;
            setError(null);
            track.mutate(
              { remote: chosenRemote, branch: existing },
              {
                onSuccess: () =>
                  toast({
                    tone: 'success',
                    title: `${sync.branch} now tracks ${chosenRemote}/${existing}`,
                  }),
                onError: (err) =>
                  setError(
                    ipcErrorMessage(err, "Git couldn't set the upstream."),
                  ),
              },
            );
          }}
        >
          Track it
        </Button>
      </div>
      {error && <InlineStatus tone="danger">{error}</InlineStatus>}
    </div>
  );
}
