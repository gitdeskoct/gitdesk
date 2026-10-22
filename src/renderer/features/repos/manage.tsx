import { useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  descriptionSchema,
  displayNameSchema,
  repositoryNameSchema,
  type RemoteRepository,
  type RepositorySummary,
} from '../../../shared/repos';
import { Button } from '../../components/ui/button';
import { InlineStatus } from '../../components/ui/status';
import { TextField } from '../../components/ui/text-field';
import { useToast } from '../../components/ui/toast';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { changeCount } from '../../lib/repo-status';
import {
  useDeleteRemote,
  useRemoveRepository,
  useTrashRepository,
  useUnlinkRepository,
  useUpdateRemote,
  useUpdateRepository,
} from '../../lib/queries';

// The inline forms and confirmations behind a repository's menu. Each acts on one thing: the
// registration, the folder, the link or the remote. None is a modal: the app's CSP blocks the style
// tag a modal's scroll lock injects, and an inline band keeps the repository in view.

export type ManageMode =
  | 'remove'
  | 'rename'
  | 'unlink'
  | 'trash'
  | 'edit-remote'
  | 'delete-remote';

export const trashName = () =>
  window.desktop.platform === 'win32' ? 'Recycle Bin' : 'Trash';

const band = 'grid gap-3 bg-danger-soft px-3 py-3 text-[0.8125rem] text-ink';

const plural = (n: number, one: string, many: string) =>
  `${n} ${n === 1 ? one : many}`;

// The band for one mode. `onGone` runs when the thing on screen no longer exists (removed,
// trashed, or a remote-only repository deleted), so a details page can leave.
export function ManageBand({
  mode,
  repo,
  remote,
  onClose,
  onGone = onClose,
}: {
  mode: ManageMode;
  repo?: RepositorySummary;
  remote?: RemoteRepository | null;
  onClose: () => void;
  onGone?: () => void;
}) {
  if (repo && mode === 'remove')
    return <RemoveConfirm repo={repo} onCancel={onClose} onRemoved={onGone} />;
  if (repo && mode === 'rename')
    return <RenameRow repo={repo} onDone={onClose} />;
  if (repo && mode === 'unlink')
    return <UnlinkConfirm repo={repo} onDone={onClose} />;
  if (repo && mode === 'trash')
    return <TrashConfirm repo={repo} onCancel={onClose} onTrashed={onGone} />;
  if (remote && mode === 'edit-remote')
    return <RemoteEditRow repo={remote} onDone={onClose} />;
  if (remote && mode === 'delete-remote')
    return (
      <DeleteRemoteRow
        repo={remote}
        onCancel={onClose}
        onDeleted={repo ? onClose : onGone}
      />
    );
  return null;
}

// Removes the registration only; the folder, its history and any remote are left alone.
export function RemoveConfirm({
  repo,
  onCancel,
  onRemoved = onCancel,
}: {
  repo: RepositorySummary;
  onCancel: () => void;
  onRemoved?: () => void;
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
        {remove.isError && (
          <InlineStatus tone="danger" className="mt-1.5">
            {ipcErrorMessage(remove.error, "It wasn't removed. Try again.")}
          </InlineStatus>
        )}
      </span>
      <Button
        size="sm"
        variant="danger"
        pending={remove.isPending}
        onClick={() => remove.mutate(repo.id, { onSuccess: onRemoved })}
      >
        Remove
      </Button>
      <Button size="sm" variant="ghost" onClick={onCancel} autoFocus>
        Cancel
      </Button>
    </div>
  );
}

// Renames the registration; a linked repository's remote gets the same name first.
export function RenameRow({
  repo,
  onDone,
}: {
  repo: RepositorySummary;
  onDone: () => void;
}) {
  const update = useUpdateRepository();
  const toast = useToast();
  const linked = !!repo.remoteId;
  const schema = z.object({
    name: linked ? repositoryNameSchema : displayNameSchema,
    description: descriptionSchema,
  });
  const [values, setValues] = useState({
    name: repo.name,
    description: repo.description ?? '',
  });
  const [errors, setErrors] = useState<{ name?: string; description?: string }>(
    {},
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = schema.safeParse(values);
    if (!parsed.success) {
      const fields = z.flattenError(parsed.error).fieldErrors;
      return setErrors({
        name: fields.name?.[0],
        description: fields.description?.[0],
      });
    }
    const name = parsed.data.name === repo.name ? undefined : parsed.data.name;
    const description =
      (parsed.data.description || null) === repo.description
        ? undefined
        : parsed.data.description || null;
    if (name === undefined && description === undefined) return onDone();
    update.mutate(
      { id: repo.id, name, description },
      {
        onSuccess: () => {
          toast({ tone: 'success', title: 'Details saved' });
          onDone();
        },
      },
    );
  };
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={`Edit ${repo.name}`}
      className="grid gap-3 border-b border-line bg-sunken px-3 py-3"
    >
      <TextField
        label="Name"
        value={values.name}
        onChange={(event) =>
          setValues((v) => ({ ...v, name: event.target.value }))
        }
        error={errors.name}
        hint={
          linked
            ? 'Also renames the remote. The folder on disk keeps its name.'
            : 'Only the name in gitdesk changes. The folder on disk keeps its name.'
        }
        spellCheck={false}
        autoComplete="off"
        maxLength={100}
        autoFocus
      />
      <TextField
        label="Description"
        value={values.description}
        onChange={(event) =>
          setValues((v) => ({ ...v, description: event.target.value }))
        }
        error={errors.description}
        hint="One line, up to 280 characters."
        maxLength={280}
      />
      {update.isError && (
        <InlineStatus tone="danger">
          {ipcErrorMessage(update.error, "Those details weren't saved.")}
        </InlineStatus>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          pending={update.isPending}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

export function UnlinkConfirm({
  repo,
  onDone,
}: {
  repo: RepositorySummary;
  onDone: () => void;
}) {
  const unlink = useUnlinkRepository();
  const toast = useToast();
  return (
    <div
      role="group"
      aria-label={`Disconnect ${repo.name}`}
      className="flex flex-wrap items-center gap-3 bg-danger-soft px-3 py-2.5 text-[0.8125rem] text-ink"
    >
      <span className="min-w-0 flex-1">
        Disconnect <b className="font-semibold">{repo.name}</b> from its remote?
        Files, history, Git settings and the remote stay as they are.
        {unlink.isError && (
          <InlineStatus tone="danger" className="mt-1.5">
            {ipcErrorMessage(unlink.error, "It wasn't disconnected.")}
          </InlineStatus>
        )}
      </span>
      <Button
        size="sm"
        variant="danger"
        pending={unlink.isPending}
        onClick={() =>
          unlink.mutate(repo.id, {
            onSuccess: () => {
              toast({ tone: 'success', title: `${repo.name} disconnected` });
              onDone();
            },
          })
        }
      >
        Disconnect
      </Button>
      <Button size="sm" variant="ghost" onClick={onDone} autoFocus>
        Cancel
      </Button>
    </div>
  );
}

// The folder goes to the system trash, never straight to deletion, and only after its name is
// typed. What would go with it is said plainly; an unchecked folder is never called safe.
export function TrashConfirm({
  repo,
  onCancel,
  onTrashed = onCancel,
}: {
  repo: RepositorySummary;
  onCancel: () => void;
  onTrashed?: () => void;
}) {
  const trash = useTrashRepository();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === repo.name;
  const changes = repo.status ? changeCount(repo.status) : null;
  return (
    <div
      role="group"
      aria-label={`Move ${repo.name} to the ${trashName()}`}
      className={band}
    >
      <p className="leading-relaxed">
        Move <b className="font-mono font-semibold">{repo.displayPath}</b> to
        the {trashName()}? Its whole history goes with it.{' '}
        {changes === null ? (
          <b className="font-semibold">
            gitdesk hasn't checked it for uncommitted work.
          </b>
        ) : changes > 0 ? (
          <b className="font-semibold">
            {plural(
              changes,
              'uncommitted change goes',
              'uncommitted changes go',
            )}{' '}
            with it.
          </b>
        ) : (
          'It had no uncommitted changes at the last check.'
        )}{' '}
        {repo.remoteId && 'The remote is not touched. '}You can restore the
        folder from the {trashName()}.
      </p>
      <TextField
        label={`Type ${repo.name} to confirm`}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        spellCheck={false}
        autoComplete="off"
        autoFocus
      />
      {trash.isError && (
        <InlineStatus tone="danger">
          {ipcErrorMessage(trash.error, 'The folder was not moved.')}
        </InlineStatus>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="danger"
          pending={trash.isPending}
          aria-disabled={!matches || undefined}
          onClick={() =>
            matches &&
            trash.mutate(
              { id: repo.id, confirmName: typed.trim() },
              {
                onSuccess: () => {
                  toast({
                    tone: 'success',
                    title: `${repo.name} moved to the ${trashName()}`,
                  });
                  onTrashed();
                },
              },
            )
          }
        >
          Move to {trashName()}
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

const remoteSchema = z.object({
  name: repositoryNameSchema,
  description: descriptionSchema,
});

export function RemoteEditRow({
  repo,
  onDone,
}: {
  repo: RemoteRepository;
  onDone: () => void;
}) {
  const update = useUpdateRemote();
  const toast = useToast();
  const [values, setValues] = useState({
    name: repo.name,
    description: repo.description ?? '',
  });
  const [errors, setErrors] = useState<{ name?: string; description?: string }>(
    {},
  );
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = remoteSchema.safeParse(values);
    if (!parsed.success) {
      const fields = z.flattenError(parsed.error).fieldErrors;
      return setErrors({
        name: fields.name?.[0],
        description: fields.description?.[0],
      });
    }
    const name = parsed.data.name === repo.name ? undefined : parsed.data.name;
    const description =
      (parsed.data.description || null) === repo.description
        ? undefined
        : parsed.data.description || null;
    if (name === undefined && description === undefined) return onDone();
    update.mutate(
      { id: repo.id, name, description },
      {
        onSuccess: () => {
          toast({ tone: 'success', title: 'Remote details saved' });
          onDone();
        },
      },
    );
  };
  return (
    <form
      onSubmit={submit}
      noValidate
      aria-label={`Edit ${repo.name}`}
      className="grid gap-3 border-b border-line bg-sunken px-3 py-3"
    >
      <TextField
        label="Name"
        value={values.name}
        onChange={(event) =>
          setValues((v) => ({ ...v, name: event.target.value }))
        }
        error={errors.name}
        hint="Renaming keeps the same repository and its stored data."
        spellCheck={false}
        autoComplete="off"
        maxLength={100}
        autoFocus
      />
      <TextField
        label="Description"
        value={values.description}
        onChange={(event) =>
          setValues((v) => ({ ...v, description: event.target.value }))
        }
        error={errors.description}
        hint="One line, up to 280 characters."
        maxLength={280}
      />
      {update.isError && (
        <InlineStatus tone="danger">
          {ipcErrorMessage(update.error, "Those details weren't saved.")}
        </InlineStatus>
      )}
      <div className="flex gap-2">
        <Button
          type="submit"
          variant="primary"
          size="sm"
          pending={update.isPending}
        >
          Save
        </Button>
        <Button size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </form>
  );
}

// Deleting a remote can't be undone, so the name must be typed. A deletion the server couldn't
// finish keeps the repository as `deleting` and says so; asking again resumes it.
export function DeleteRemoteRow({
  repo,
  onCancel,
  onDeleted = onCancel,
}: {
  repo: RemoteRepository;
  onCancel: () => void;
  onDeleted?: () => void;
}) {
  const remove = useDeleteRemote();
  const toast = useToast();
  const [typed, setTyped] = useState('');
  const matches = typed.trim() === repo.name;
  return (
    <div role="group" aria-label={`Delete ${repo.name}`} className={band}>
      <p className="leading-relaxed">
        Delete <b className="font-semibold">{repo.name}</b> and its stored data
        from your account? This can't be undone. Local folders and their history
        stay on your computers.
      </p>
      <TextField
        label={`Type ${repo.name} to confirm`}
        value={typed}
        onChange={(event) => setTyped(event.target.value)}
        spellCheck={false}
        autoComplete="off"
        autoFocus
      />
      {remove.isError && (
        <InlineStatus tone="danger">
          {ipcErrorMessage(remove.error, "The remote wasn't deleted.")}
        </InlineStatus>
      )}
      <div className="flex gap-2">
        <Button
          size="sm"
          variant="danger"
          pending={remove.isPending}
          aria-disabled={!matches || undefined}
          onClick={() =>
            matches &&
            remove.mutate(repo.id, {
              onSuccess: (result) => {
                if (result.status === 'incomplete') {
                  toast({
                    tone: 'danger',
                    title: `Deleting ${repo.name} didn't finish`,
                    description:
                      'Some stored data is still in your account. Delete it again to finish.',
                  });
                  return onCancel();
                }
                toast({
                  tone: 'success',
                  title: `${repo.name} deleted from your account`,
                });
                onDeleted();
              },
            })
          }
        >
          Delete remote
        </Button>
        <Button size="sm" variant="ghost" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
