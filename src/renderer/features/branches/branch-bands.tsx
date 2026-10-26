import { useState, type FormEvent, type ReactNode } from 'react';
import type {
  BranchActionResult,
  BranchOverview,
  BranchRef,
} from '../../../shared/branches';
import type { RepositorySummary } from '../../../shared/repos';
import type { Settings } from '../../../shared/settings';
import {
  branchNameSchema,
  type LocalBranch,
  type RepoPreferences,
} from '../../../shared/workspace';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { Segmented } from '../../components/ui/segmented';
import { InlineStatus } from '../../components/ui/status';
import { TextField } from '../../components/ui/text-field';
import { useToast } from '../../components/ui/toast';
import {
  useCreateBranch,
  useDeleteBranch,
  useDeleteRemoteBranch,
  usePushBranch,
  useRenameBranch,
  useSetBranchUpstream,
} from '../../lib/branch-queries';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { plural, shortOid } from '../pulls/pull-bits';
import { RefSelect } from './ref-select';

// Every branch action confirms inline, in a band under the row or toolbar it came from. Nothing is
// a centered dialog, and nothing changes until Git's refreshed list says so.

const neutral = 'grid gap-3 border-b border-line bg-sunken px-3 py-3';
const danger = 'grid gap-3 bg-danger-soft px-3 py-3 text-[0.8125rem] text-ink';
const warning =
  'grid gap-2 bg-warning-soft px-3 py-3 text-[0.8125rem] text-ink';

function Blocked({ result }: { result: BranchActionResult | null }) {
  if (!result || result.status !== 'blocked') return null;
  if (result.reason === 'local-changes')
    return (
      <div role="status" className={warning}>
        <InlineStatus tone="warning">{result.message}</InlineStatus>
        {result.files.length > 0 && (
          <ul className="ml-6 font-mono text-[0.78125rem]">
            {result.files.map((file) => (
              <li key={file}>{file}</li>
            ))}
          </ul>
        )}
      </div>
    );
  return <InlineStatus tone="danger">{result.message}</InlineStatus>;
}

const Failure = ({ error, fallback }: { error: unknown; fallback: string }) =>
  error ? (
    <InlineStatus tone="danger">
      {ipcErrorMessage(error, fallback)}
    </InlineStatus>
  ) : null;

type StartKind = 'head' | 'branch' | 'commit';

export function NewBranchBand({
  repo,
  list,
  settings,
  prefs,
  onDone,
  onCancel,
}: {
  repo: RepositorySummary;
  list: BranchOverview;
  settings: Settings | undefined;
  prefs: RepoPreferences | undefined;
  onDone: (name: string, switched: boolean) => void;
  onCancel: () => void;
}) {
  const create = useCreateBranch(repo.id);
  const fromTarget =
    prefs?.branchStart === 'compare-against' && list.target
      ? ({
          kind: list.local.some((b) => b.name === list.target!.name)
            ? 'local'
            : 'remote',
          name: list.target.name,
        } satisfies BranchRef)
      : null;
  const [name, setName] = useState('');
  const [error, setError] = useState<string>();
  const [kind, setKind] = useState<StartKind>(fromTarget ? 'branch' : 'head');
  const [ref, setRef] = useState<BranchRef | null>(fromTarget);
  const [commit, setCommit] = useState('');
  const [switchTo, setSwitchTo] = useState(settings?.branchSwitchNew ?? true);
  // null follows Settings › Git; ticking or clearing the box is a choice for this branch only.
  const [track, setTrack] = useState<boolean | null>(null);
  const tracking = kind === 'branch' && ref?.kind === 'remote';
  const trackDefault = (settings?.branchTrack ?? 'git') !== 'never';
  const from =
    list.current ?? (list.headOid ? shortOid(list.headOid) : 'nothing yet');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (create.isPending) return;
    const parsed = branchNameSchema.safeParse(name);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    if (kind === 'branch' && !ref)
      return setError('Choose the branch to start from.');
    if (kind === 'commit' && !/^[0-9a-f]{4,64}$/i.test(commit.trim()))
      return setError('Paste a commit hash of at least 4 characters.');
    create.mutate(
      {
        name: parsed.data,
        start:
          kind === 'head'
            ? { kind: 'head' }
            : kind === 'commit'
              ? { kind: 'commit', oid: commit.trim() }
              : ref!,
        switchTo,
        track:
          track === null
            ? (settings?.branchTrack ?? 'git')
            : track
              ? 'always'
              : 'never',
      },
      {
        onSuccess: (result) => {
          if (result.status === 'done') onDone(result.branch, result.switched);
        },
      },
    );
  };

  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label="New branch"
      className={neutral}
    >
      <div className="flex flex-wrap items-start gap-3">
        <TextField
          label="Name"
          autoFocus
          className="w-72 font-mono"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(undefined);
            create.reset();
          }}
          error={error}
          placeholder="feature/name"
          spellCheck={false}
        />
        <div className="grid gap-1.5">
          <span className="text-sm font-medium text-ink">Starts from</span>
          <Segmented
            label="Starts from"
            value={kind}
            onChange={(next) => {
              setKind(next);
              setError(undefined);
            }}
            options={[
              { value: 'head', label: `Current · ${from}` },
              { value: 'branch', label: 'A branch' },
              { value: 'commit', label: 'A commit' },
            ]}
          />
        </div>
        {kind === 'branch' && (
          <RefSelect
            id="new-branch-start"
            label="Branch"
            value={ref}
            list={list}
            onChange={(next) => {
              setRef(next);
              setError(undefined);
            }}
          />
        )}
        {kind === 'commit' && (
          <TextField
            label="Commit hash"
            className="w-56 font-mono"
            value={commit}
            onChange={(event) => {
              setCommit(event.target.value);
              setError(undefined);
            }}
            placeholder="4a91d12"
            spellCheck={false}
          />
        )}
      </div>
      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-[0.8125rem] text-ink">
        <label className="inline-flex items-center gap-2">
          <Checkbox
            checked={switchTo}
            onCheckedChange={(next) => setSwitchTo(next === true)}
          />
          Switch to it now
        </label>
        {tracking && (
          <label className="inline-flex items-center gap-2">
            <Checkbox
              checked={track ?? trackDefault}
              onCheckedChange={(next) => setTrack(next === true)}
            />
            Track {ref!.name}
          </label>
        )}
        <span className="text-xs text-muted">
          {switchTo
            ? 'Uncommitted changes come along when you switch.'
            : 'Nothing changes in your files.'}{' '}
          Git checks the name too.
        </span>
      </div>
      <Blocked result={create.data ?? null} />
      <Failure error={create.error} fallback="Git didn't create the branch." />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" pending={create.isPending}>
          Create branch
        </Button>
        <Button type="button" className="bg-surface" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function RenameBand({
  repo,
  branch,
  onDone,
  onCancel,
}: {
  repo: RepositorySummary;
  branch: LocalBranch;
  onDone: (to: string, upstream: string | null) => void;
  onCancel: () => void;
}) {
  const rename = useRenameBranch(repo.id);
  const [name, setName] = useState(branch.name);
  const [error, setError] = useState<string>();
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (rename.isPending) return;
    const parsed = branchNameSchema.safeParse(name);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    // The renamed row replaces this one, so the promise, not a per-call callback, reports back.
    rename.mutateAsync({ from: branch.name, to: parsed.data }).then(
      (result) => {
        if (result.status === 'done') onDone(result.branch, result.upstream);
      },
      () => undefined,
    );
  };
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={`Rename ${branch.name}`}
      className={neutral}
    >
      <div className="flex flex-wrap items-start gap-3">
        <TextField
          label="New name"
          autoFocus
          className="w-72 font-mono"
          value={name}
          onChange={(event) => {
            setName(event.target.value);
            setError(undefined);
            rename.reset();
          }}
          onFocus={(event) => event.currentTarget.select()}
          error={error}
          spellCheck={false}
        />
      </div>
      <p className="text-xs text-muted">
        Only the branch on this computer is renamed. Its upstream, history and
        settings stay with it.
      </p>
      <Blocked result={rename.data ?? null} />
      <Failure error={rename.error} fallback="Git didn't rename the branch." />
      <div className="flex gap-2">
        <Button type="submit" variant="primary" pending={rename.isPending}>
          Rename
        </Button>
        <Button type="button" className="bg-surface" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// After a rename the remote still has the old name. Publishing the new one is its own choice, and
// deleting the old one confirms in its own band.
export function RenamedBand({
  repo,
  to,
  upstream,
  onDeleteOld,
  onClose,
}: {
  repo: RepositorySummary;
  to: string;
  upstream: string;
  onDeleteOld: () => void;
  onClose: () => void;
}) {
  const unset = useSetBranchUpstream(repo.id);
  const push = usePushBranch(repo.id);
  const toast = useToast();
  const [published, setPublished] = useState(false);
  const running = unset.isPending || push.isPending;
  const publish = async () => {
    try {
      // Without an upstream, a push publishes the new name and tracks it.
      const cleared = await unset.mutateAsync({ name: to, upstream: null });
      if (cleared.status !== 'done') return;
      const result = await push.mutateAsync({
        name: to,
        jobId: crypto.randomUUID(),
      });
      if (result.status === 'pushed') {
        setPublished(true);
        toast({
          tone: 'success',
          title: `Published ${to} to ${result.remote}`,
        });
      } else
        toast({
          tone: 'danger',
          title: "Didn't publish",
          description: result.message,
        });
    } catch (err) {
      toast({
        tone: 'danger',
        title: "Didn't publish",
        description: ipcErrorMessage(err, 'Git could not push. Try again.'),
      });
    }
  };
  return (
    <div role="status" className={neutral}>
      <p className="text-[0.8125rem] text-ink">
        <b className="font-semibold">Renamed to {to}.</b>{' '}
        {published
          ? `${to} is published. ${upstream} is still on the remote until you delete it.`
          : `${upstream} keeps the old name on the remote, and the branch still tracks it.`}
      </p>
      <div className="flex flex-wrap gap-2">
        {!published && (
          <Button
            className="bg-surface"
            pending={running}
            onClick={() => void publish()}
          >
            Publish {to}
          </Button>
        )}
        <Button className="bg-surface" onClick={onDeleteOld}>
          Delete {upstream}…
        </Button>
        <Button className="bg-surface" onClick={onClose}>
          Keep the remote as it is
        </Button>
      </div>
    </div>
  );
}

export function DeleteBand({
  repo,
  branch,
  merged,
  onCompare,
  onPublish,
  onDone,
  onCancel,
}: {
  repo: RepositorySummary;
  branch: LocalBranch;
  merged: boolean;
  onCompare: () => void;
  onPublish: () => void;
  onDone: () => void;
  onCancel: () => void;
}) {
  const remove = useDeleteBranch(repo.id);
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const result = remove.data;
  const run = (force: boolean) => {
    if (remove.isPending) return;
    // The deleted row unmounts this band before the refetch ends; the promise still reports back.
    remove
      .mutateAsync({
        name: branch.name,
        force,
        typedName: force ? typed : undefined,
      })
      .then(
        (next) => {
          if (next.status !== 'done') return;
          toast({ tone: 'success', title: `Deleted ${branch.name}` });
          onDone();
        },
        () => undefined,
      );
  };
  if (result?.status === 'not-merged') {
    const matches = typed === branch.name;
    return (
      <div role="alert" className={danger}>
        <p>
          <b className="font-semibold">Git kept {branch.name}.</b>{' '}
          {plural(result.total, 'commit')}{' '}
          {result.upstream
            ? `aren't on ${result.upstream}.`
            : "aren't in the branch you're on, and it was never published, so they exist only on this computer."}
        </p>
        <ul className="ml-1 grid gap-0.5 text-[0.78125rem]">
          {result.commits.map((commit) => (
            <li key={commit.oid}>
              <span className="font-mono">{shortOid(commit.oid)}</span>{' '}
              {commit.subject || '(no message)'} · {relativeTime(commit.at)}
            </li>
          ))}
          {result.total > result.commits.length && (
            <li className="text-muted">
              and {plural(result.total - result.commits.length, 'more commit')}
            </li>
          )}
        </ul>
        <div className="flex flex-wrap gap-2">
          <Button size="sm" className="bg-surface" onClick={onCompare}>
            Compare
          </Button>
          {!branch.upstream && (
            <Button size="sm" className="bg-surface" onClick={onPublish}>
              Publish first
            </Button>
          )}
          <Button size="sm" autoFocus className="bg-surface" onClick={onCancel}>
            Keep it
          </Button>
        </div>
        <div className="flex flex-wrap items-end gap-3 border-t border-line pt-3">
          <TextField
            label={`Type ${branch.name} to delete it anyway`}
            className="w-72 font-mono"
            value={typed}
            onChange={(event) => setTyped(event.target.value)}
            placeholder={branch.name}
            spellCheck={false}
            autoComplete="off"
          />
          <Button
            size="sm"
            variant="danger"
            className="bg-surface"
            pending={remove.isPending}
            aria-disabled={!matches || undefined}
            onClick={() => matches && run(true)}
          >
            Delete anyway
          </Button>
        </div>
        <Failure
          error={remove.error}
          fallback="Git didn't delete the branch."
        />
      </div>
    );
  }
  return (
    <div role="alert" className={danger}>
      <p>
        <b className="font-semibold">Delete {branch.name} on this computer?</b>{' '}
        {merged
          ? 'Its commits are already in the compare-against branch.'
          : branch.upstream && !branch.gone
            ? `Git checks that its commits are on ${branch.upstream} first.`
            : 'Git checks that its commits are in the branch you are on first.'}{' '}
        {branch.upstream && !branch.gone ? 'The copy on the remote stays.' : ''}
      </p>
      <Blocked result={result ?? null} />
      <Failure error={remove.error} fallback="Git didn't delete the branch." />
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="danger"
          className="bg-surface"
          pending={remove.isPending}
          onClick={() => run(false)}
        >
          Delete
        </Button>
        <Button size="sm" autoFocus className="bg-surface" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

export function UpstreamBand({
  repo,
  branch,
  list,
  onDone,
  onCancel,
}: {
  repo: RepositorySummary;
  branch: LocalBranch;
  list: BranchOverview;
  onDone: () => void;
  onCancel: () => void;
}) {
  const set = useSetBranchUpstream(repo.id);
  const toast = useToast();
  const remoteOnly = { ...list, local: [] };
  const [ref, setRef] = useState<BranchRef | null>(
    branch.upstream ? { kind: 'remote', name: branch.upstream } : null,
  );
  const [pending, setPending] = useState<'set' | 'clear' | null>(null);
  const run = (upstream: string | null) => {
    if (set.isPending) return;
    setPending(upstream ? 'set' : 'clear');
    set.mutate(
      { name: branch.name, upstream },
      {
        onSuccess: (result) => {
          if (result.status !== 'done') return;
          toast({
            tone: 'success',
            title: upstream
              ? `${branch.name} now tracks ${upstream}`
              : `${branch.name} no longer tracks a branch`,
          });
          onDone();
        },
        onSettled: () => setPending(null),
      },
    );
  };
  return (
    <div
      role="group"
      aria-label={`Change the upstream of ${branch.name}`}
      className={neutral}
    >
      <div className="flex flex-wrap items-end gap-3">
        {list.remote.length ? (
          <RefSelect
            id={`upstream-${branch.name}`}
            label="Remote-tracking branch"
            value={ref}
            list={remoteOnly}
            onChange={setRef}
          />
        ) : (
          <p className="text-[0.8125rem] text-muted">
            There are no remote-tracking branches yet. Fetch, or publish this
            branch instead.
          </p>
        )}
        <Button
          size="sm"
          variant="primary"
          pending={pending === 'set'}
          aria-disabled={!ref || ref.name === branch.upstream || undefined}
          onClick={() => ref && ref.name !== branch.upstream && run(ref.name)}
        >
          Set upstream
        </Button>
        {branch.upstream && (
          <Button
            size="sm"
            className="bg-surface"
            pending={pending === 'clear'}
            onClick={() => run(null)}
          >
            Stop tracking
          </Button>
        )}
        <Button size="sm" className="bg-surface" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      <p className="text-xs text-muted">
        Changes which branch status, pull and push compare {branch.name}{' '}
        against. Nothing is fetched or pushed.
      </p>
      <Blocked result={set.data ?? null} />
      <Failure error={set.error} fallback="Git didn't change the upstream." />
    </div>
  );
}

export function DeleteRemoteBand({
  repo,
  remote,
  branch,
  oid,
  onDone,
  onCancel,
}: {
  repo: RepositorySummary;
  remote: string;
  branch: string;
  oid: string;
  onDone: () => void;
  onCancel: () => void;
}) {
  const del = useDeleteRemoteBranch(repo.id);
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const matches = typed === branch;
  const result = del.data;
  const run = () => {
    if (!matches || del.isPending) return;
    // The remote-tracking row goes with the branch, so the promise reports back, not a callback.
    del
      .mutateAsync({
        remote,
        branch,
        expectedOid: oid,
        typedName: typed,
        jobId: crypto.randomUUID(),
      })
      .then(
        (next) => {
          if (next.status !== 'deleted') return;
          toast({ tone: 'success', title: `Deleted ${branch} on ${remote}` });
          onDone();
        },
        () => undefined,
      );
  };
  return (
    <div role="alert" className={danger}>
      <p>
        <b className="font-semibold">
          Delete {branch} on {remote}?
        </b>{' '}
        Anyone who fetches loses it there. Your branch on this computer stays.
        gitdesk deletes it only if {remote} still has{' '}
        <span className="font-mono">{shortOid(oid)}</span>; if someone pushed
        since, nothing is deleted.
      </p>
      <div className="flex flex-wrap items-end gap-3">
        <TextField
          label={`Type ${branch} to confirm`}
          className="w-72 font-mono"
          value={typed}
          onChange={(event) => {
            setTyped(event.target.value);
            del.reset();
          }}
          placeholder={branch}
          spellCheck={false}
          autoComplete="off"
          autoFocus
        />
        <Button
          size="sm"
          variant="danger"
          className="bg-surface"
          pending={del.isPending}
          aria-disabled={!matches || undefined}
          onClick={run}
        >
          Delete on {remote}
        </Button>
        <Button size="sm" className="bg-surface" onClick={onCancel}>
          Cancel
        </Button>
      </div>
      {result?.status === 'failed' && (
        <InlineStatus tone={result.reason === 'moved' ? 'warning' : 'danger'}>
          {result.message}
        </InlineStatus>
      )}
      <Failure
        error={del.error}
        fallback="Git didn't delete the remote branch."
      />
    </div>
  );
}

export function BandSlot({ children }: { children: ReactNode }) {
  return <div className="border-b border-line py-2">{children}</div>;
}
