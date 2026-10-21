import { CircleAlert, CircleCheck } from 'lucide-react';
import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  descriptionSchema,
  repositoryNameSchema,
  type CreateRepositoryResult,
} from '../../../shared/repos';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { InlineStatus } from '../../components/ui/status';
import { TextField } from '../../components/ui/text-field';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useAuthStatus,
  useChooseLocation,
  useCreateRepository,
  useLinkRemote,
} from '../../lib/queries';
import { useOpenRepo } from './repo-row';
import { SidePanel } from './side-panel';

const formSchema = z.object({
  name: repositoryNameSchema,
  description: descriptionSchema,
});

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
          className={disabled ? 'text-sm font-medium text-muted' : 'text-sm font-medium text-ink'}
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
        <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
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
          <CircleCheck aria-hidden className="mt-0.5 size-4 shrink-0 text-success" />
          <span>
            <b className="font-semibold">Private remote created</b> on your
            gitdesk account.
          </span>
        </p>
      )}
      {remoteFailed && (
        <>
          <p className="flex gap-2.5">
            <CircleAlert aria-hidden className="mt-0.5 size-4 shrink-0 text-danger" />
            <span>
              <b className="font-semibold">The remote wasn't created.</b>{' '}
              {link.isError
                ? ipcErrorMessage(link.error, 'Try again in a minute.')
                : result.remote.status === 'failed' && result.remote.message}{' '}
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

// Create runs locally first; the remote step is optional, needs a connection, and is reported
// on its own so a network failure never hides or undoes the local repository.
export function CreatePanel({ onClose }: { onClose: () => void }) {
  const { data: auth } = useAuthStatus();
  const online = auth?.status === 'authenticated';
  const choose = useChooseLocation();
  const create = useCreateRepository();
  const [values, setValues] = useState({ name: '', description: '' });
  const [errors, setErrors] = useState<{ name?: string; description?: string; location?: string }>({});
  const [location, setLocation] = useState<{ token: string; displayPath: string } | null>(null);
  const [readme, setReadme] = useState(true);
  const [remote, setRemote] = useState(online);

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = formSchema.safeParse(values);
    const fields = parsed.success ? {} : z.flattenError(parsed.error).fieldErrors;
    const next = {
      name: fields.name?.[0],
      description: fields.description?.[0],
      location: location ? undefined : 'Choose where to create it.',
    };
    setErrors(next);
    if (!parsed.success || !location) return;
    create.mutate({
      name: parsed.data.name,
      description: parsed.data.description || undefined,
      locationToken: location.token,
      readme,
      remote: remote && online,
    });
  };

  return (
    <SidePanel title="Create repository" onClose={onClose}>
      {create.isSuccess ? (
        <Result result={create.data} onClose={onClose} />
      ) : (
        <form onSubmit={submit} noValidate className="grid gap-5">
          <TextField
            label="Name"
            value={values.name}
            onChange={(event) => {
              setValues((v) => ({ ...v, name: event.target.value }));
              setErrors((e) => ({ ...e, name: undefined }));
            }}
            error={errors.name}
            hint="Letters, numbers, dots, dashes and underscores."
            spellCheck={false}
            autoComplete="off"
            maxLength={100}
          />
          <div className="grid gap-1.5">
            <span id="create-location" className="text-sm font-medium text-ink">
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
          <CheckRow
            id="create-readme"
            checked={readme}
            onChange={setReadme}
            label="Add a README"
            hint="Makes the first commit, so the branch exists."
          />
          <CheckRow
            id="create-remote"
            checked={remote && online}
            onChange={setRemote}
            disabled={!online}
            label="Also create a private remote"
            hint={
              online
                ? 'Registers it on your gitdesk account. The local repository is made first either way.'
                : 'Needs you to be signed in and connected. You can add it later from the repository menu.'
            }
          />
          <div className="flex gap-2">
            <Button type="submit" variant="primary" pending={create.isPending}>
              {create.isPending ? 'Creating…' : 'Create repository'}
            </Button>
            <Button variant="ghost" onClick={onClose}>
              Cancel
            </Button>
          </div>
          {create.isError && (
            <InlineStatus tone="danger">
              {ipcErrorMessage(create.error, "Couldn't create the repository.")}
            </InlineStatus>
          )}
        </form>
      )}
    </SidePanel>
  );
}
