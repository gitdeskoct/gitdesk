import {
  CircleAlert,
  CircleCheck,
  Clock,
  CloudUpload,
  TriangleAlert,
  Undo2,
  X,
} from 'lucide-react';
import { useState, type ReactNode } from 'react';
import type { MoveResult, RepositorySummary } from '../../../shared/repos';
import { repositoryNameSchema } from '../../../shared/repos';
import { Button } from '../../components/ui/button';
import { JobProgress } from '../../components/ui/job-progress';
import { Spinner } from '../../components/ui/spinner';
import { TextField } from '../../components/ui/text-field';
import { useToast } from '../../components/ui/toast';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAuthStatus,
  useJobProgress,
  useLinkRemote,
  useSignIn,
} from '../../lib/queries';
import {
  useCancelMove,
  useLinkNamed,
  useMove,
  useMovePreview,
  useMoveUndo,
  useUndoMove,
} from '../../lib/sync-queries';
import { plural } from '../pulls/pull-bits';

function Band({
  tone,
  icon,
  children,
  action,
  className,
}: {
  tone: 'warning' | 'danger' | 'accent' | 'success';
  icon: ReactNode;
  children: ReactNode;
  action?: ReactNode;
  className?: string;
}) {
  return (
    <div
      role={tone === 'danger' ? 'alert' : 'status'}
      className={cn(
        'flex flex-wrap items-center gap-3 px-3 py-2.5 text-[0.8125rem] text-ink',
        {
          warning: 'bg-warning-soft [&>svg]:text-warning',
          danger: 'bg-danger-soft [&>svg]:text-danger',
          accent: 'bg-accent-soft [&>svg]:text-accent',
          success: 'bg-success-soft [&>svg]:text-success',
        }[tone],
        className,
      )}
    >
      {icon}
      <span className="min-w-[16rem] flex-1">{children}</span>
      {action}
    </div>
  );
}

// The automatic private remote while it isn't made yet: creating, waiting for sign-in, a name the
// account already uses, or a failure with its reason. Nothing shows once the link exists.
export function AutoLinkBand({ repo }: { repo: RepositorySummary }) {
  const link = useLinkRemote();
  const named = useLinkNamed(repo.id);
  const signIn = useSignIn();
  const [name, setName] = useState('');
  const state = repo.autoLink;
  if (!state) return null;
  if (state.state === 'creating')
    return (
      <Band
        tone="accent"
        icon={<Spinner className="text-accent" />}
        className="mt-6"
      >
        Creating a private remote for {repo.name}…
      </Band>
    );
  if (state.state === 'waiting')
    return (
      <Band
        tone="accent"
        className="mt-6"
        icon={<Clock aria-hidden className="size-4 shrink-0" />}
        action={
          <Button
            size="sm"
            variant="primary"
            pending={signIn.isPending}
            onClick={() => signIn.mutate()}
          >
            Sign in
          </Button>
        }
      >
        <b className="font-semibold">
          {repo.name} gets its private remote after you sign in.
        </b>{' '}
        Nothing leaves this computer until then.
      </Band>
    );
  if (state.state === 'failed')
    return (
      <Band
        tone="danger"
        className="mt-6"
        icon={<X aria-hidden className="size-4 shrink-0" />}
        action={
          <Button
            size="sm"
            pending={link.isPending}
            onClick={() => link.mutate(repo.id)}
          >
            Try again
          </Button>
        }
      >
        <b className="font-semibold">Couldn't create the private remote.</b>{' '}
        {state.message} {repo.name} works as before on this computer.
        {link.error && (
          <span className="mt-1 block">
            {ipcErrorMessage(link.error, "It still wasn't created.")}
          </span>
        )}
      </Band>
    );
  const valid = repositoryNameSchema.safeParse(name);
  return (
    <Band
      tone="warning"
      className="mt-6"
      icon={<TriangleAlert aria-hidden className="size-4 shrink-0" />}
    >
      <b className="font-semibold">
        {state.name
          ? `Your account already uses ${state.name} and ${state.name}-2 to ${state.name}-9.`
          : "This folder's name can't be used for a remote."}
      </b>{' '}
      Choose a name for this one.
      <form
        className="mt-2 flex flex-wrap items-end gap-2"
        onSubmit={(event) => {
          event.preventDefault();
          if (valid.success && !named.isPending) named.mutate(valid.data);
        }}
      >
        <div className="min-w-56">
          <TextField
            label="Remote name"
            hideLabel
            placeholder={`${repo.name}-desktop`}
            value={name}
            onChange={(event) => setName(event.target.value)}
            error={
              name && !valid.success
                ? (valid.error.issues[0]?.message ?? "That name can't be used.")
                : named.error
                  ? ipcErrorMessage(named.error, "The remote wasn't created.")
                  : undefined
            }
          />
        </div>
        <Button
          type="submit"
          size="sm"
          variant="primary"
          pending={named.isPending}
          aria-disabled={!valid.success || undefined}
        >
          Create remote
        </Button>
      </form>
    </Band>
  );
}

// Moves a linked repository off another provider: every branch and tag is copied and checked on
// gitdesk before origin changes, and Undo puts the old remotes back.
export function MoveSection({ repo }: { repo: RepositorySummary }) {
  const { data: auth } = useAuthStatus();
  const usable = !!repo.remoteId && auth?.status === 'authenticated';
  const preview = useMovePreview(repo.id, repo.statusAt, usable);
  const undoState = useMoveUndo(repo.id, !!repo.remoteId);
  const move = useMove(repo.id);
  const cancel = useCancelMove();
  const undo = useUndoMove(repo.id);
  const toast = useToast();
  const [jobId, setJobId] = useState<string | null>(null);
  const [result, setResult] = useState<MoveResult | null>(null);
  const [dismissed, setDismissed] = useState(false);
  const progress = useJobProgress(jobId);

  const lastMove = undoState.data;
  const undoButton = lastMove && (
    <Button
      size="sm"
      pending={undo.isPending}
      onClick={() =>
        undo.mutate(undefined, {
          onSuccess: () => {
            setResult(null);
            toast({
              tone: 'success',
              title: `Put back ${lastMove.remotes.join(', ')}`,
            });
          },
          onError: (err) =>
            toast({
              tone: 'danger',
              title: "Didn't undo the move",
              description: ipcErrorMessage(
                err,
                'The remotes were not changed.',
              ),
            }),
        })
      }
    >
      {!undo.isPending && <Undo2 />}
      Undo move
    </Button>
  );

  if (jobId)
    return (
      <div className="mt-6 grid gap-3">
        <div className="flex flex-wrap items-center gap-3">
          <h3 className="flex-1 text-[0.9375rem] font-semibold text-ink">
            Moving {repo.name} to gitdesk
          </h3>
          <Button
            size="sm"
            variant="ghost"
            pending={cancel.isPending}
            onClick={() => cancel.mutate(jobId)}
          >
            Cancel
          </Button>
        </div>
        <JobProgress
          label="Move"
          stage={progress?.stage ?? 'Starting'}
          right={progress ? `${progress.percent}%` : ''}
          percent={progress?.percent ?? 0}
          progress={progress}
          network
        />
        <p className="text-xs text-muted">
          Your remotes don't change until every branch and tag is checked on
          gitdesk. Cancelling before then leaves them exactly as they are.
        </p>
      </div>
    );

  if (
    result?.status === 'moved' ||
    (lastMove && !result && preview.data?.status !== 'ready')
  )
    return (
      <Band
        tone="success"
        className="mt-6"
        icon={<CircleCheck aria-hidden className="size-4 shrink-0" />}
        action={undoButton}
      >
        {result?.status === 'moved' ? (
          <>
            <b className="font-semibold">Moved to gitdesk.</b> origin now points
            at your private remote.{' '}
            {plural(result.branches, 'branch', 'branches')} and{' '}
            {plural(result.tags, 'tag')} were checked on gitdesk.{' '}
            {result.removed.join(', ')} is saved on this computer only.
          </>
        ) : (
          <>
            <b className="font-semibold">
              Moved to gitdesk {relativeTime(lastMove!.at)}.
            </b>{' '}
            Undo puts {lastMove!.remotes.join(', ')} back as it was.
          </>
        )}
      </Band>
    );

  if (
    result &&
    (result.status === 'refused' || result.status === 'failed') &&
    !dismissed
  )
    return (
      <Band
        tone={result.status === 'failed' ? 'danger' : 'warning'}
        className="mt-6"
        icon={
          result.status === 'failed' ? (
            <X aria-hidden className="size-4 shrink-0" />
          ) : (
            <TriangleAlert aria-hidden className="size-4 shrink-0" />
          )
        }
        action={
          <Button size="sm" variant="ghost" onClick={() => setDismissed(true)}>
            Dismiss
          </Button>
        }
      >
        {result.message}
      </Band>
    );

  if (!usable || preview.isPending || !preview.data) return null;
  const ready = preview.data;
  if (ready.status === 'refused')
    return ready.reason === 'lfs' ||
      ready.reason === 'too-large' ||
      ready.reason === 'operation' ? (
      <Band
        tone="warning"
        className="mt-6"
        icon={<CircleAlert aria-hidden className="size-4 shrink-0" />}
      >
        <b className="font-semibold">Move to gitdesk isn't available.</b>{' '}
        {ready.message}
      </Band>
    ) : null;

  return (
    <Band
      tone="accent"
      className="mt-6"
      icon={<CloudUpload aria-hidden className="size-4 shrink-0" />}
      action={
        <Button
          size="sm"
          variant="primary"
          pending={move.isPending}
          onClick={() => {
            if (move.isPending) return;
            const id = crypto.randomUUID();
            setJobId(id);
            setResult(null);
            setDismissed(false);
            move.mutate(id, {
              onSuccess: (outcome) => {
                setResult(outcome);
                if (outcome.status === 'moved')
                  toast({
                    tone: 'success',
                    title: `Moved ${repo.name} to gitdesk`,
                  });
              },
              onError: (err) =>
                setResult({
                  status: 'failed',
                  reason: 'failed',
                  message: ipcErrorMessage(
                    err,
                    "The move didn't finish. Your remotes are unchanged.",
                  ),
                }),
              onSettled: () => setJobId(null),
            });
          }}
        >
          Move to gitdesk
        </Button>
      }
    >
      <b className="font-semibold">Move {repo.name} to gitdesk?</b> gitdesk
      copies {plural(ready.branches, 'branch', 'branches')} and{' '}
      {plural(ready.tags, 'tag')} to your private remote, checks that each one
      arrived, then points origin at gitdesk and removes{' '}
      {ready.remotes.map((r) => `${r.name} (${r.url})`).join(', ')} from this
      repository. Pull requests, issues and CI stay at the old provider. Undo
      puts the old remote back.
    </Band>
  );
}
