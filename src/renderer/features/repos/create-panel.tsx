import * as RadioGroup from '@radix-ui/react-radio-group';
import { Check, Circle, CircleAlert, CircleCheck, Lock } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  CREATE_STEPS,
  descriptionSchema,
  repositoryNameSchema,
  type CreateRepositoryResult,
  type CreateStep,
  type RemoteRepository,
} from '../../../shared/repos';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { JobProgress } from '../../components/ui/job-progress';
import { Spinner } from '../../components/ui/spinner';
import { InlineStatus } from '../../components/ui/status';
import { TextField } from '../../components/ui/text-field';
import { cn } from '../../lib/cn';
import { formatDuration } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAuthStatus,
  useChooseLocation,
  useCreateRemote,
  useCreateRepository,
  useJobProgress,
  useLinkRemote,
  useProvisionRemote,
} from '../../lib/queries';
import { useNavigation } from '../../app/navigation';
import { useWorkspaceUi } from '../../app/workspace-ui';
import { useOpenRepo } from './repo-row';
import { SidePanel } from './side-panel';

const formSchema = z.object({
  name: repositoryNameSchema,
  description: descriptionSchema,
});

type Mode = 'local' | 'remote' | 'both';

// Local Git and account storage fail in different ways, so where it lives is chosen first.
const MODES: { value: Mode; title: string; text: string }[] = [
  {
    value: 'local',
    title: 'Local only',
    text: 'Starts Git in a new folder on this computer. Nothing goes to your account.',
  },
  {
    value: 'remote',
    title: 'Remote only',
    text: 'Creates it in your gitdesk account. Nothing is written on this computer.',
  },
  {
    value: 'both',
    title: 'Local and remote',
    text: 'Creates both and links them. If one side fails, the other is kept and you can retry.',
  },
];

function RemoteResult({
  remote,
  onClose,
}: {
  remote: RemoteRepository;
  onClose: () => void;
}) {
  const { navigate } = useNavigation();
  const provision = useProvisionRemote();
  const current = provision.data ?? remote;
  const ready = current.status === 'ready';
  return (
    <div role="status" className="grid gap-3 border-t border-line pt-4 text-sm">
      <p className="flex gap-2.5">
        {ready ? (
          <CircleCheck
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-success"
          />
        ) : (
          <CircleAlert
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-danger"
          />
        )}
        <span>
          <b className="font-semibold">{current.name}</b>{' '}
          {ready
            ? 'is in your account and its storage is ready.'
            : "is in your account, but its storage isn't ready yet. Nothing was lost."}
          {provision.isError && (
            <span className="mt-1 block text-danger">
              {ipcErrorMessage(provision.error, "Setup didn't run.")}
            </span>
          )}
        </span>
      </p>
      {!ready && (
        <div className="pl-6.5">
          <Button
            size="sm"
            pending={provision.isPending}
            onClick={() => provision.mutate(current.id)}
          >
            Retry setup
          </Button>
        </div>
      )}
      <div className="flex gap-2 pt-1">
        <Button
          variant="primary"
          onClick={() => {
            onClose();
            navigate({ name: 'remote-repository', id: current.id });
          }}
        >
          Open repository
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

function CheckRow({
  id,
  checked,
  onChange,
  disabled,
  label,
  hint,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
  disabled?: boolean;
  label: string;
  hint: string;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox
        id={id}
        checked={checked}
        disabled={disabled}
        onCheckedChange={(next) => onChange(next === true)}
        aria-describedby={`${id}-hint`}
        className="mt-0.5"
      />
      <div>
        <label
          htmlFor={id}
          className={
            disabled
              ? 'text-sm font-medium text-muted'
              : 'text-sm font-medium text-ink'
          }
        >
          {label}
        </label>
        <p id={`${id}-hint`} className="mt-0.5 text-[0.8125rem] text-muted">
          {hint}
        </p>
      </div>
    </div>
  );
}

function Result({
  result,
  onClose,
}: {
  result: CreateRepositoryResult;
  onClose: () => void;
}) {
  const openRepo = useOpenRepo();
  const link = useLinkRemote();
  const remoteFailed = result.remote.status === 'failed' && !link.isSuccess;
  return (
    <div role="status" className="grid gap-3 border-t border-line pt-4 text-sm">
      <p className="flex gap-2.5">
        <CircleCheck
          aria-hidden
          className="mt-0.5 size-4 shrink-0 text-success"
        />
        <span>
          <b className="font-semibold">Local repository created</b> at{' '}
          <span className="font-mono text-[0.8125rem]">
            {result.repository.displayPath}
          </span>
          .
          {result.readmeCommitted === false &&
            ' The README is there but not committed: set your Git identity, then commit it.'}
        </span>
      </p>
      {(result.remote.status === 'created' || link.isSuccess) && (
        <p className="flex gap-2.5">
          <CircleCheck
            aria-hidden
            className="mt-0.5 size-4 shrink-0 text-success"
          />
          <span>
            <b className="font-semibold">Private remote created</b> on your
            gitdesk account.
          </span>
        </p>
      )}
      {remoteFailed && (
        <>
          <p className="flex gap-2.5">
            <CircleAlert
              aria-hidden
              className="mt-0.5 size-4 shrink-0 text-danger"
            />
            <span>
              <b className="font-semibold">The remote wasn't created.</b>{' '}
              {link.isError
                ? ipcErrorMessage(link.error, 'Try again in a minute.')
                : result.remote.status === 'failed' &&
                  result.remote.message}{' '}
              Your local repository is safe.
            </span>
          </p>
          <div className="pl-6.5">
            <Button
              size="sm"
              pending={link.isPending}
              onClick={() => link.mutate(result.repository.id)}
            >
              Try the remote again
            </Button>
          </div>
        </>
      )}
      <p className="text-[0.8125rem] text-muted">
        Finished in {formatDuration(result.timing.totalMs)}
        {result.timing.remoteMs !== null &&
          ` · the server answered in ${Math.round(result.timing.remoteMs)} ms`}
      </p>
      <div className="flex gap-2 pt-1">
        <Button
          variant="primary"
          onClick={() => {
            onClose();
            openRepo(result.repository.id);
          }}
        >
          Open repository
        </Button>
        <Button variant="ghost" onClick={onClose}>
          Done
        </Button>
      </div>
    </div>
  );
}

const STEP_TEXT: Record<CreateStep, { doing: string; done: string }> = {
  folder: { doing: 'Creating the folder', done: 'Folder created' },
  init: { doing: 'Initializing Git', done: 'Git initialized' },
  readme: { doing: 'Committing the README', done: 'README committed' },
  register: { doing: 'Adding it to gitdesk', done: 'Added to gitdesk' },
  remote: {
    doing: 'Creating the private remote',
    done: 'Private remote created',
  },
};

// Each step as main reports it: done, running, or still to come. Only the remote step uses the
// network, so only it shows the connection line.
function CreateSteps({
  jobId,
  name,
  readme,
  remote,
}: {
  jobId: string;
  name: string;
  readme: boolean;
  remote: boolean;
}) {
  const progress = useJobProgress(jobId);
  const steps = CREATE_STEPS.filter(
    (s) => (s !== 'readme' || readme) && (s !== 'remote' || remote),
  );
  const current = Math.max(0, steps.indexOf(progress?.stage as CreateStep));
  const step = steps[current]!;
  return (
    <div className="grid gap-5" role="status">
      <JobProgress
        label={`Creating ${name}`}
        stage={STEP_TEXT[step].doing}
        right={`Step ${current + 1} of ${steps.length}`}
        percent={progress?.percent ?? 0}
        network={step === 'remote'}
      />
      <ol className="grid gap-2 text-sm">
        {steps.map((s, index) => (
          <li
            key={s}
            className={cn(
              'flex items-center gap-2.5',
              index > current ? 'text-muted' : 'text-ink',
              index === current && 'font-medium',
            )}
          >
            <span className="grid size-4 shrink-0 place-items-center">
              {index < current ? (
                <Check aria-hidden className="size-4 text-success" />
              ) : index === current ? (
                <Spinner className="size-3.5 text-muted" />
              ) : (
                <Circle aria-hidden className="size-2.5 text-faint" />
              )}
            </span>
            {index < current ? STEP_TEXT[s].done : STEP_TEXT[s].doing}
          </li>
        ))}
      </ol>
      <div className="flex gap-2">
        <Button variant="primary" pending>
          Creating…
        </Button>
        <Button variant="ghost" aria-disabled>
          Cancel
        </Button>
      </div>
    </div>
  );
}

// Local creates run on this computer first; the remote step needs a connection and is reported on
// its own, so a network failure never hides or undoes the local repository. Remote-only creates
// write nothing locally.
export function CreatePanel({ onClose }: { onClose: () => void }) {
  const { data: auth } = useAuthStatus();
  const ui = useWorkspaceUi();
  const online = auth?.status === 'authenticated';
  const choose = useChooseLocation();
  const create = useCreateRepository();
  const createRemote = useCreateRemote();
  // One key per panel: a retry after a timeout returns the repository the first attempt made.
  const [remoteKey] = useState(() => crypto.randomUUID());
  const [mode, setMode] = useState<Mode>(online ? 'both' : 'local');
  const local = mode !== 'remote';
  const pending = create.isPending || createRemote.isPending;
  const [values, setValues] = useState({ name: '', description: '' });
  const [errors, setErrors] = useState<{
    name?: string;
    description?: string;
    location?: string;
  }>({});
  const [location, setLocation] = useState<{
    token: string;
    displayPath: string;
  } | null>(null);
  const [readme, setReadme] = useState(true);
  const [jobId, setJobId] = useState<string | null>(null);
  const remote = mode === 'both' && online;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = formSchema.safeParse(values);
    const fields = parsed.success
      ? {}
      : z.flattenError(parsed.error).fieldErrors;
    const next = {
      name: fields.name?.[0],
      description: fields.description?.[0],
      location: !local || location ? undefined : 'Choose where to create it.',
    };
    setErrors(next);
    if (!parsed.success) return;
    if (!local)
      return createRemote.mutate({
        name: parsed.data.name,
        description: parsed.data.description || null,
        key: remoteKey,
      });
    if (!location) return;
    const id = crypto.randomUUID();
    setJobId(id);
    create.mutate({
      name: parsed.data.name,
      description: parsed.data.description || undefined,
      locationToken: location.token,
      readme,
      remote,
      jobId: id,
    });
  };

  return (
    <SidePanel title="New repository" onClose={onClose} locked={pending}>
      {create.isSuccess ? (
        <Result result={create.data} onClose={onClose} />
      ) : createRemote.isSuccess ? (
        <RemoteResult remote={createRemote.data} onClose={onClose} />
      ) : create.isPending && jobId ? (
        <CreateSteps
          jobId={jobId}
          name={values.name.trim()}
          readme={readme}
          remote={remote}
        />
      ) : (
        <form onSubmit={submit} noValidate className="grid gap-5">
          <div className="grid gap-1.5">
            <span id="create-mode" className="text-sm font-medium text-ink">
              Where it lives
            </span>
            <RadioGroup.Root
              aria-labelledby="create-mode"
              value={mode}
              onValueChange={(next) => setMode(next as Mode)}
              className="rounded-sm border border-line"
            >
              {MODES.map((option) => {
                const needsAccount = option.value !== 'local' && !online;
                return (
                  <RadioGroup.Item
                    key={option.value}
                    value={option.value}
                    disabled={needsAccount}
                    className={cn(
                      'flex w-full items-start gap-3 border-t border-line px-3 py-3 text-left first:rounded-t-sm first:border-t-0 last:rounded-b-sm data-[state=checked]:bg-accent-soft',
                      needsAccount ? 'text-muted' : 'hover:bg-row-hover',
                    )}
                  >
                    <span className="mt-0.5 grid size-4 shrink-0 place-items-center text-accent">
                      <RadioGroup.Indicator>
                        <Check aria-hidden className="size-4" />
                      </RadioGroup.Indicator>
                    </span>
                    <span className="min-w-0">
                      <span
                        className={cn(
                          'block text-sm font-semibold',
                          !needsAccount && 'text-ink',
                        )}
                      >
                        {option.title}
                      </span>
                      <span className="mt-0.5 block text-[0.8125rem] leading-relaxed text-muted">
                        {needsAccount
                          ? 'Needs you to be signed in and connected.'
                          : option.text}
                      </span>
                    </span>
                  </RadioGroup.Item>
                );
              })}
            </RadioGroup.Root>
            <p className="text-[0.8125rem] text-muted">
              Already have a Git folder?{' '}
              <Button
                variant="link"
                className="text-[0.8125rem]"
                pending={ui.adding}
                onClick={() => {
                  onClose();
                  ui.addRepository();
                }}
              >
                Add existing folder
              </Button>
            </p>
          </div>
          <TextField
            label="Name"
            value={values.name}
            onChange={(event) => {
              setValues((v) => ({ ...v, name: event.target.value }));
              setErrors((e) => ({ ...e, name: undefined }));
            }}
            error={errors.name}
            hint="Letters, numbers, dots, dashes and underscores. Renaming later keeps the same repository."
            spellCheck={false}
            autoComplete="off"
            maxLength={100}
          />
          {local && (
            <div className="grid gap-1.5">
              <span
                id="create-location"
                className="text-sm font-medium text-ink"
              >
                Location
              </span>
              <div className="flex gap-2">
                <div
                  aria-labelledby="create-location"
                  aria-invalid={!!errors.location}
                  className="field flex h-9 min-w-0 flex-1 items-center px-3 font-mono text-[0.78125rem] text-muted"
                >
                  <span className="truncate">
                    {location?.displayPath ?? 'No folder chosen'}
                  </span>
                </div>
                <Button
                  pending={choose.isPending}
                  onClick={() =>
                    choose.mutate(undefined, {
                      onSuccess: (picked) => {
                        if (!picked) return;
                        setLocation(picked);
                        setErrors((e) => ({ ...e, location: undefined }));
                      },
                    })
                  }
                >
                  Choose…
                </Button>
              </div>
              {errors.location ? (
                <p className="text-sm text-danger">{errors.location}</p>
              ) : (
                <p className="text-[0.8125rem] text-muted">
                  {location && values.name
                    ? `Creates a new folder named ${values.name} there.`
                    : 'A new folder with the repository name is made inside it.'}
                </p>
              )}
            </div>
          )}
          <TextField
            label="Description (optional)"
            value={values.description}
            onChange={(event) => {
              setValues((v) => ({ ...v, description: event.target.value }));
              setErrors((e) => ({ ...e, description: undefined }));
            }}
            error={errors.description}
            maxLength={280}
          />
          {mode !== 'local' && (
            <div className="flex items-start gap-2.5 rounded-sm border border-line px-3 py-2.5">
              <Lock aria-hidden className="mt-0.5 size-4 shrink-0 text-muted" />
              <div>
                <div className="text-sm font-medium text-ink">Private</div>
                <p className="mt-0.5 text-[0.8125rem] text-muted">
                  Only your signed-in account can see it. Public repositories
                  aren't available.
                </p>
              </div>
            </div>
          )}
          {local && (
            <CheckRow
              id="create-readme"
              checked={readme}
              onChange={setReadme}
              label="Add a README and make the first commit"
              hint="Uses the Git name and email from Settings, so the branch exists."
            />
          )}
          <div className="flex gap-2">
            <Button type="submit" variant="primary" pending={pending}>
              Create repository
            </Button>
            {/* Stays focusable but inert while creating, so the result can't be thrown away. */}
            <Button
              variant="ghost"
              aria-disabled={pending || undefined}
              onClick={() => !pending && onClose()}
            >
              Cancel
            </Button>
          </div>
          {(create.isError || createRemote.isError) && (
            <InlineStatus tone="danger">
              {ipcErrorMessage(
                create.error ?? createRemote.error,
                "Couldn't create the repository.",
              )}
            </InlineStatus>
          )}
        </form>
      )}
    </SidePanel>
  );
}
