import { CircleCheck, ExternalLink } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import {
  gitDefaultsSchema,
  gitIdentityInputSchema,
  type GitDefaults,
} from '../../../shared/ipc';
import { GitMissingArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { Segmented } from '../../components/ui/segmented';
import { Switch } from '../../components/ui/switch';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { InlineStatus, Loading } from '../../components/ui/status';
import { TextField } from '../../components/ui/text-field';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useChooseGit,
  useGitDefaultsMutation,
  useGitIdentity,
  useGitInstall,
  useOpenGitInstallPage,
  useRevealDiscarded,
  useSetGitIdentity,
  useSetGlobalPrune,
  useSettings,
  useUpdateSettings,
  useUsePathGit,
} from '../../lib/queries';
import type { Settings } from '../../../shared/settings';
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

const LINE_ENDINGS = [
  { value: 'true', label: 'Convert' },
  { value: 'input', label: 'Input only' },
  { value: 'false', label: 'Off' },
] as const;

// Unset values are shown as the usual choice for the platform, and the row says they aren't saved yet.
function DefaultsForm({
  defaultBranch,
  autocrlf,
}: {
  defaultBranch: string | null;
  autocrlf: GitDefaults['autocrlf'] | null;
}) {
  const save = useGitDefaultsMutation();
  const fallbackCrlf = window.desktop.platform === 'win32' ? 'true' : 'input';
  const [values, setValues] = useState<GitDefaults>({
    defaultBranch: defaultBranch ?? 'main',
    autocrlf: autocrlf ?? fallbackCrlf,
  });
  const [error, setError] = useState<string>();
  const change = (patch: Partial<GitDefaults>) => {
    setValues((current) => ({ ...current, ...patch }));
    setError(undefined);
    save.reset();
  };

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = gitDefaultsSchema.safeParse(values);
    if (!parsed.success) {
      setError(z.flattenError(parsed.error).fieldErrors.defaultBranch?.[0]);
      return;
    }
    save.mutate(parsed.data);
  };

  return (
    <form
      id="git-defaults"
      onSubmit={submit}
      noValidate
      className="mt-12 scroll-mt-6"
    >
      <SettingGroup title="New repositories">
        <SettingRow
          label="Default branch name"
          description={
            defaultBranch
              ? 'Used by git init. Saved as init.defaultBranch.'
              : 'Used by git init. Not set yet, so Git falls back to its own default.'
          }
        >
          <TextField
            label="Default branch name"
            hideLabel
            className="w-44"
            value={values.defaultBranch}
            onChange={(event) => change({ defaultBranch: event.target.value })}
            error={error}
            placeholder="main"
            spellCheck={false}
          />
        </SettingRow>
        <SettingRow
          label="Line endings"
          description={
            autocrlf
              ? 'How Git converts line endings (core.autocrlf).'
              : 'How Git converts line endings (core.autocrlf). Not set in your global config yet.'
          }
        >
          <Segmented
            label="Line endings"
            value={values.autocrlf}
            onChange={(next) => change({ autocrlf: next })}
            options={LINE_ENDINGS}
          />
        </SettingRow>
      </SettingGroup>
      <div className="mt-4 flex flex-wrap items-center gap-3">
        <Button type="submit" pending={save.isPending} className="min-w-30">
          {save.isPending ? 'Saving…' : 'Save defaults'}
        </Button>
        {save.isSuccess && (
          <InlineStatus tone="success">
            Saved to your global Git config.
          </InlineStatus>
        )}
        {save.isError && (
          <InlineStatus tone="danger">
            {ipcErrorMessage(
              save.error,
              "Git couldn't save these defaults. Try again.",
            )}
          </InlineStatus>
        )}
      </div>
    </form>
  );
}

// Which Git runs: the one on PATH, or one picked here. Main checks a picked program answers as Git.
function GitInstallGroup() {
  const install = useGitInstall();
  const choose = useChooseGit();
  const usePath = useUsePathGit();
  const failure = choose.error ?? usePath.error;
  const data = install.data;
  return (
    <SettingGroup title="Git on this computer">
      <SettingRow
        id="git-install"
        label={
          install.isPending
            ? 'Checking Git…'
            : data?.available
              ? `Git ${data.version}`
              : 'Git not found'
        }
        description={
          data?.available ? (
            <span className="font-mono text-[0.78125rem]">
              {data.location ?? 'On your PATH'}
            </span>
          ) : (
            'gitdesk could not run Git with the current choice.'
          )
        }
      >
        <Button
          size="sm"
          pending={install.isFetching}
          onClick={() => void install.refetch()}
        >
          Check again
        </Button>
      </SettingRow>
      <SettingRow
        id="git-binary"
        label="Which Git to use"
        description="The one on your PATH, or a Git you pick. gitdesk checks it answers as Git before using it."
        stacked={!!failure}
      >
        <div className="flex flex-wrap items-center gap-2">
          <Button
            size="sm"
            variant={data && !data.custom ? 'secondary' : 'ghost'}
            aria-pressed={!!data && !data.custom}
            pending={usePath.isPending}
            onClick={() => usePath.mutate(undefined)}
          >
            {data && !data.custom && !usePath.isPending && <CircleCheck />}
            From PATH
          </Button>
          <Button
            size="sm"
            variant={data?.custom ? 'secondary' : 'ghost'}
            aria-pressed={!!data?.custom}
            pending={choose.isPending}
            onClick={() => choose.mutate(undefined)}
          >
            {data?.custom && !choose.isPending && <CircleCheck />}
            Choose…
          </Button>
        </div>
        {failure && (
          <InlineStatus tone="danger">
            {ipcErrorMessage(failure, "That Git wasn't used. Try another.")}
          </InlineStatus>
        )}
      </SettingRow>
    </SettingGroup>
  );
}

const GUIDES = [
  { value: '50', label: '50' },
  { value: '72', label: '72' },
  { value: '0', label: 'Off' },
] as const;
const FETCH_INTERVALS = [
  { value: '0', label: 'Off' },
  { value: '5', label: '5 min' },
  { value: '15', label: '15 min' },
  { value: '30', label: '30 min' },
] as const;

const UNTRACKED = [
  { value: 'all', label: 'Each file' },
  { value: 'normal', label: 'Folders only' },
] as const;
const SUBMODULES = [
  { value: 'none', label: 'All' },
  { value: 'dirty', label: 'Commits only' },
  { value: 'all', label: 'Hide' },
] as const;

function CommitFetchGroups() {
  const { data: settings } = useSettings();
  const update = useUpdateSettings();
  const showDiscarded = useRevealDiscarded();
  const install = useGitInstall();
  const prune = useSetGlobalPrune();
  if (!settings) return null;
  const data = install.data?.available ? install.data : null;
  return (
    <>
      <SettingGroup title="Committing">
        <SettingRow
          id="commit-guide"
          label="Summary length guide"
          description="The commit form counts characters and marks a summary past this length. It never blocks the commit."
        >
          <Segmented
            label="Summary length guide"
            value={String(settings.commitSummaryGuide) as '0' | '50' | '72'}
            options={GUIDES}
            onChange={(next) =>
              update.mutate({
                commitSummaryGuide: Number(
                  next,
                ) as Settings['commitSummaryGuide'],
              })
            }
          />
        </SettingRow>
        <SettingRow
          id="commit-signoff"
          label="Add Signed-off-by"
          description="Appends your name and email as a sign-off line (git commit --signoff)."
        >
          <Switch
            aria-label="Add Signed-off-by"
            checked={settings.commitSignoff}
            onCheckedChange={(commitSignoff) =>
              update.mutate({ commitSignoff })
            }
          />
        </SettingRow>
        <SettingRow
          id="commit-signing"
          label="Signed commits"
          description={
            data?.signing
              ? 'commit.gpgsign is on in your Git config, so Git signs each commit with your own key.'
              : 'commit.gpgsign is off in your Git config. Turn it on in a terminal once your GPG or SSH key is set up.'
          }
        >
          <span className="text-xs text-muted">Read from Git</span>
        </SettingRow>
        <SettingRow
          id="git-hooks"
          label="Git hooks"
          description="Hooks in a repository run on commit, switch and fetch, the same as in a terminal. Viewing status, diffs and history never runs them."
        >
          <span className="text-xs text-muted">Always</span>
        </SettingRow>
      </SettingGroup>
      <SettingGroup title="Changes and staging">
        <SettingRow
          id="changes-untracked"
          label="Untracked files"
          description="Each file lists every new file on its own, so each can be staged alone. Folders only shows a new folder as one row."
        >
          <Segmented
            label="Untracked files"
            value={settings.changesUntracked}
            options={UNTRACKED}
            onChange={(changesUntracked) => update.mutate({ changesUntracked })}
          />
        </SettingRow>
        <SettingRow
          id="changes-renames"
          label="Detect renames"
          description="Git pairs a deleted and an added file as one rename when their contents are mostly the same."
        >
          <Switch
            aria-label="Detect renames"
            checked={settings.changesRenames}
            onCheckedChange={(changesRenames) =>
              update.mutate({ changesRenames })
            }
          />
        </SettingRow>
        <SettingRow
          id="changes-submodules"
          label="Submodule changes"
          description="All shows a submodule's new commit and edits inside it. Commits only leaves out edits inside. Hide leaves submodules out of Changes."
        >
          <Segmented
            label="Submodule changes"
            value={settings.changesSubmodules}
            options={SUBMODULES}
            onChange={(changesSubmodules) =>
              update.mutate({ changesSubmodules })
            }
          />
        </SettingRow>
        <SettingRow
          id="changes-partial"
          label="Stage parts of a file"
          description="Shows a select box on each changed line and Stage change on each change in a diff. Whole files can always be staged."
        >
          <Switch
            aria-label="Stage parts of a file"
            checked={settings.changesPartial}
            onCheckedChange={(changesPartial) =>
              update.mutate({ changesPartial })
            }
          />
        </SettingRow>
        <SettingRow
          id="changes-keep-discarded"
          label="Keep a copy of discarded changes"
          description="Saves what each discard removes as a patch file in Discarded changes, in gitdesk's app data folder, before Git runs."
        >
          <div className="flex items-center gap-3">
            <Button
              size="sm"
              pending={showDiscarded.isPending}
              onClick={() => showDiscarded.mutate(null)}
            >
              Show folder
            </Button>
            <Switch
              aria-label="Keep a copy of discarded changes"
              checked={settings.changesKeepDiscarded}
              onCheckedChange={(changesKeepDiscarded) =>
                update.mutate({ changesKeepDiscarded })
              }
            />
          </div>
        </SettingRow>
        <SettingRow
          id="changes-resolved"
          label="Mark resolved"
          description="Stages the whole working file, the way git add does. It stays unavailable while conflict markers remain."
        >
          <span className="text-xs text-muted">Always</span>
        </SettingRow>
      </SettingGroup>
      {showDiscarded.isError && (
        <InlineStatus tone="danger" className="mt-3">
          {ipcErrorMessage(
            showDiscarded.error,
            "Couldn't open the Discarded changes folder.",
          )}
        </InlineStatus>
      )}
      <SettingGroup title="Fetching">
        <SettingRow
          id="auto-fetch"
          label="Fetch automatically"
          description="Only for the repository you have open, from its default remote, and never while you are offline. Fetch never changes your files."
        >
          <Segmented
            label="Fetch automatically"
            value={String(settings.autoFetch) as '0' | '5' | '15' | '30'}
            options={FETCH_INTERVALS}
            onChange={(next) =>
              update.mutate({
                autoFetch: Number(next) as Settings['autoFetch'],
              })
            }
          />
        </SettingRow>
        <SettingRow
          id="fetch-prune"
          label="Prune deleted remote branches"
          description="Removes local copies of branches deleted on the remote when you fetch. Your own branches stay. Global: fetch.prune"
        >
          <Switch
            aria-label="Prune deleted remote branches"
            checked={data?.prune ?? false}
            disabled={!data || prune.isPending}
            onCheckedChange={(enabled) => prune.mutate(enabled)}
          />
        </SettingRow>
        <SettingRow
          id="git-credentials"
          label="Credentials"
          description={
            data?.credentialHelper
              ? `Git uses ${data.credentialHelper} to sign in to remotes. gitdesk never asks for or stores Git passwords.`
              : 'No credential helper is set, so private remotes need SSH keys or a helper. gitdesk never asks for or stores Git passwords.'
          }
        >
          <span className="text-xs text-muted">Read from Git</span>
        </SettingRow>
      </SettingGroup>
      {prune.isError && (
        <InlineStatus tone="danger" className="mt-3">
          {ipcErrorMessage(prune.error, "fetch.prune wasn't saved. Try again.")}
        </InlineStatus>
      )}
    </>
  );
}

export function GitSection() {
  const identity = useGitIdentity();
  const install = useOpenGitInstallPage();

  if (identity.isPending) return <Loading label="Reading your Git config…" />;
  // A failed check is not the same as Git missing: offer to check again instead of a download.
  if (identity.isError)
    return (
      <EmptyState
        art={<GitMissingArt />}
        title="Couldn't read your Git setup"
        action={
          <Button
            pending={identity.isFetching}
            onClick={() => void identity.refetch()}
          >
            Check again
          </Button>
        }
      >
        {ipcErrorMessage(
          identity.error,
          'Git did not answer when gitdesk asked for its config.',
        )}
      </EmptyState>
    );
  if (!identity.data.available) {
    return (
      <>
        <EmptyState
          art={<GitMissingArt />}
          title="Git is not installed"
          action={
            <Button
              pending={install.isPending}
              onClick={() => install.mutate()}
            >
              {!install.isPending && <ExternalLink />}
              Download Git
            </Button>
          }
        >
          gitdesk uses the Git on your computer for every commit, so install it
          and reopen this page.
        </EmptyState>
        <GitInstallGroup />
      </>
    );
  }

  return (
    <>
      <PageTitle title="Git">
        Rows here change your global Git config, which your terminal and editor
        use too. Each repository can override them on its own Settings tab.
      </PageTitle>
      <GitInstallGroup />
      <h2 className="mt-12 mb-3 text-[0.8125rem] font-medium text-muted">
        Commit identity
      </h2>
      <IdentityForm
        initial={{
          name: identity.data.name ?? '',
          email: identity.data.email ?? '',
        }}
      />
      <div className="mt-12">
        <CommitFetchGroups />
      </div>
      <DefaultsForm
        defaultBranch={identity.data.defaultBranch}
        autocrlf={identity.data.autocrlf}
      />
    </>
  );
}
