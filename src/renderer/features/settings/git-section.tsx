import { ExternalLink } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { gitIdentityInputSchema } from '../../../shared/ipc';
import { GitMissingArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { InlineStatus, Loading } from '../../components/ui/status';
import { TextField } from '../../components/ui/text-field';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useGitIdentity, useSetGitIdentity } from '../../lib/queries';
import { PageTitle } from '../shell/page';

type FieldErrors = Partial<Record<'name' | 'email', string>>;

function IdentityForm({
  initial,
}: {
  initial: { name: string; email: string };
}) {
  const save = useSetGitIdentity();
  const [values, setValues] = useState(initial);
  const [errors, setErrors] = useState<FieldErrors>({});
  useEffect(() => setValues(initial), [initial.name, initial.email]);

  const edit =
    (field: keyof typeof values) => (event: { target: { value: string } }) => {
      setValues((current) => ({ ...current, [field]: event.target.value }));
      setErrors((current) => ({ ...current, [field]: undefined }));
      save.reset();
    };

  // The same schema main validates with; this copy only gives faster feedback.
  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = gitIdentityInputSchema.safeParse(values);
    if (!parsed.success) {
      const fields = z.flattenError(parsed.error).fieldErrors;
      setErrors({ name: fields.name?.[0], email: fields.email?.[0] });
      return;
    }
    save.mutate(parsed.data);
  };

  return (
    <form
      id="git-identity"
      onSubmit={submit}
      noValidate
      className="grid max-w-[380px] scroll-mt-6 gap-4.5"
    >
      <TextField
        label="Name"
        value={values.name}
        onChange={edit('name')}
        error={errors.name}
        autoComplete="name"
        placeholder="Your Name"
      />
      <TextField
        label="Email"
        type="email"
        value={values.email}
        onChange={edit('email')}
        error={errors.email}
        autoComplete="email"
        placeholder="email@example.com"
      />
      <div className="flex flex-wrap items-center gap-3">
        <Button
          type="submit"
          variant="primary"
          pending={save.isPending}
          className="min-w-30"
        >
          {save.isPending ? 'Saving…' : 'Save identity'}
        </Button>
        {save.isSuccess && (
          <InlineStatus tone="success">
            Saved to your global Git config.
          </InlineStatus>
        )}
      </div>
      {save.isError && (
        <InlineStatus tone="danger">
          {ipcErrorMessage(
            save.error,
            "Git couldn't save your identity. Check that Git is installed, then try again.",
          )}
        </InlineStatus>
      )}
    </form>
  );
}

export function GitSection() {
  const identity = useGitIdentity();

  if (identity.isPending) return <Loading label="Reading your Git config…" />;
  if (identity.isError || !identity.data.available) {
    return (
      <EmptyState
        art={<GitMissingArt />}
        title="Git is not installed"
        action={
          <Button onClick={() => void window.desktop.git.openInstallPage()}>
            <ExternalLink />
            Download Git
          </Button>
        }
      >
        gitdesk uses the Git on your computer for every commit. Install it, then
        reopen this page.
      </EmptyState>
    );
  }

  return (
    <>
      <PageTitle title="Commit identity">
        Written into every commit on this computer. Saved to your global Git
        config; repository settings are left alone.
      </PageTitle>
      <IdentityForm
        initial={{
          name: identity.data.name ?? '',
          email: identity.data.email ?? '',
        }}
      />
    </>
  );
}
