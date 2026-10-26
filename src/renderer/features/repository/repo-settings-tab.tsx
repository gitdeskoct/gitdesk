import { X } from 'lucide-react';
import { useEffect, useState, type FormEvent } from 'react';
import { z } from 'zod';
import { gitIdentityInputSchema } from '../../../shared/ipc';
import type { RepositorySummary } from '../../../shared/repos';
import {
  protectedPatternSchema,
  type RepoPreferences,
} from '../../../shared/workspace';
import { OfflineArt } from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import { EmptyState } from '../../components/ui/empty-state';
import { Segmented } from '../../components/ui/segmented';
import { SettingGroup, SettingRow } from '../../components/ui/setting-row';
import { InlineStatus, Loading } from '../../components/ui/status';
import { TextField } from '../../components/ui/text-field';
import { useBranchOverview } from '../../lib/branch-queries';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useEditors,
  useRepoGitConfig,
  useRepoPreferences,
  useSetRepoGitConfig,
  useSetRepoPreferences,
  useSettings,
} from '../../lib/queries';
import { EditorLogo, hasEditorLogo, OpenInEditorButton } from './editor-button';
import { RepoSizeSection } from './repo-size';

const CRLF_LABEL = {
  true: 'Convert',
  input: 'Input only',
  false: 'Off',
} as const;

function IdentityRows({ repoId }: { repoId: string }) {
  const config = useRepoGitConfig(repoId);
  const save = useSetRepoGitConfig(repoId);
  const own = !!(config.data?.identity.name || config.data?.identity.email);
  const [mode, setMode] = useState<'global' | 'local'>('global');
  const [values, setValues] = useState({ name: '', email: '' });
  const [errors, setErrors] = useState<{ name?: string; email?: string }>({});
  useEffect(() => {
    if (!config.data) return;
    setMode(own ? 'local' : 'global');
    setValues({
      name: config.data.identity.name ?? '',
      email: config.data.identity.email ?? '',
    });
  }, [config.data, own]);

  if (!config.data) return null;
  const global = config.data.globalIdentity;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (mode === 'global') return save.mutate({ identity: null });
    const parsed = gitIdentityInputSchema.safeParse(values);
    if (!parsed.success) {
      const fields = z.flattenError(parsed.error).fieldErrors;
      return setErrors({ name: fields.name?.[0], email: fields.email?.[0] });
    }
    save.mutate({ identity: parsed.data });
  };
  return (
    <form onSubmit={submit} noValidate>
      <SettingGroup title="Commit identity">
        <SettingRow
          id="repo-identity"
          label="Who commits here"
          description={
            global.name || global.email
              ? `Your global identity is ${global.name ?? 'no name'}, ${global.email ?? 'no email'}.`
              : 'No global identity is set yet.'
          }
          stacked={mode === 'local'}
        >
          <Segmented
            label="Who commits here"
            value={mode}
            onChange={(next) => {
              setMode(next);
              save.reset();
            }}
            options={[
              { value: 'global', label: 'Follow global' },
              { value: 'local', label: 'This repository only' },
            ]}
          />
          {mode === 'local' && (
            <div className="mt-3 grid gap-3 @min-[560px]:grid-cols-2">
              <TextField
                label="Name"
                value={values.name}
                onChange={(e) => {
                  setValues({ ...values, name: e.target.value });
                  setErrors({});
                }}
                error={errors.name}
                placeholder="Your Name"
              />
              <TextField
                label="Email"
                type="email"
                value={values.email}
                onChange={(e) => {
                  setValues({ ...values, email: e.target.value });
                  setErrors({});
                }}
                error={errors.email}
                placeholder="work@example.com"
              />
            </div>
          )}
        </SettingRow>
      </SettingGroup>
      <div className="mt-3 flex flex-wrap items-center gap-3">
        <Button type="submit" variant="primary" pending={save.isPending}>
          Save identity
        </Button>
        {save.isSuccess && (
          <InlineStatus tone="success">
            {mode === 'local'
              ? "Saved to this repository's .git/config."
              : 'This repository follows your global identity again.'}
          </InlineStatus>
        )}
        {save.isError && (
          <InlineStatus tone="danger">
            {ipcErrorMessage(save.error, "Git couldn't save it. Try again.")}
          </InlineStatus>
        )}
        <span className="text-xs text-muted">Local: user.name, user.email</span>
      </div>
    </form>
  );
}

const MERGE_WORDS = {
  default: "Git's default",
  'no-ff': 'Always a merge commit',
  'ff-only': 'Fast-forward only',
} as const;
const AUTO_WORDS = {
  off: 'Off',
  compare: 'When comparing',
  list: 'Also in the branch list',
} as const;

// Protected names and prefix/* patterns, as removable tags with one field to add another.
function ProtectedBranches({
  value,
  onChange,
}: {
  value: string[];
  onChange: (next: string[]) => void;
}) {
  const [draft, setDraft] = useState('');
  const [error, setError] = useState<string>();
  const add = () => {
    const parsed = protectedPatternSchema.safeParse(draft);
    if (!parsed.success) return setError(parsed.error.issues[0]?.message);
    if (value.includes(parsed.data))
      return setError('That one is already protected.');
    if (value.length >= 20)
      return setError('Protect at most 20 names or patterns.');
    onChange([...value, parsed.data]);
    setDraft('');
    setError(undefined);
  };
  return (
    <div className="grid w-full gap-1.5">
      <div
        role="group"
        aria-label="Protected branches"
        className="field flex min-h-9 w-full flex-wrap items-center gap-1.5 px-1.5 py-1"
      >
        {value.map((name) => (
          <span
            key={name}
            className="inline-flex h-6 items-center gap-1 rounded-[4px] bg-control pr-0.5 pl-2 font-mono text-[0.75rem] text-ink"
          >
            {name}
            <button
              type="button"
              aria-label={`Stop protecting ${name}`}
              onClick={() => onChange(value.filter((v) => v !== name))}
              className="grid size-5 place-items-center rounded-[4px] text-muted hover:text-ink"
            >
              <X aria-hidden className="size-3" />
            </button>
          </span>
        ))}
        <input
          aria-label="Add a protected branch or pattern"
          value={draft}
          onChange={(event) => {
            setDraft(event.target.value);
            setError(undefined);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault();
              add();
            }
          }}
          placeholder="Add a name or pattern, then Enter"
          spellCheck={false}
          className="h-6 min-w-40 flex-1 bg-transparent px-1 font-mono text-[0.78125rem] text-ink outline-none placeholder:font-sans placeholder:text-muted"
        />
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}
    </div>
  );
}

function BranchRows({
  repo,
  own,
  patch,
}: {
  repo: RepositorySummary;
  own: RepoPreferences;
  patch: (value: Partial<RepoPreferences>) => void;
}) {
  const { data: settings } = useSettings();
  const overview = useBranchOverview(repo.id, repo.statusAt);
  const list = overview.data;
  const resolved =
    list?.target && list.target.source !== 'setting' ? list.target.name : null;
  return (
    <SettingGroup title="Branches">
      <SettingRow
        id="repo-compare-against"
        label="Compare against"
        description="The branch that Merged, Unmerged, the Compare base and the automatic checks use. By default gitdesk reads it from the remote's default branch."
        stacked
      >
        <select
          aria-label="Compare against"
          value={own.compareAgainst ?? ''}
          onChange={(e) => patch({ compareAgainst: e.target.value || null })}
          className="field h-9 max-w-full px-2.5 font-mono text-[0.78125rem]"
        >
          <option value="">
            {resolved ? `Remote default · ${resolved}` : 'Remote default'}
          </option>
          {list?.local.map((b) => (
            <option key={`l:${b.name}`} value={b.name}>
              {b.name}
            </option>
          ))}
          {list?.remote.map((b) => (
            <option key={`r:${b.name}`} value={b.name}>
              {b.name}
            </option>
          ))}
        </select>
      </SettingRow>
      <SettingRow
        id="repo-protected-branches"
        label="Protected branches"
        description="gitdesk won't rename or delete these, here or on a remote, and asks once more before merging into them. release/* covers every branch under release/. Git and the terminal aren't changed."
        stacked
      >
        <ProtectedBranches
          value={own.protectedBranches}
          onChange={(protectedBranches) => patch({ protectedBranches })}
        />
      </SettingRow>
      <SettingRow
        id="repo-branch-start"
        label="New branches start from"
        description="What New branch picks first. You can still choose any branch or commit in it."
        stacked
      >
        <Segmented
          label="New branches start from"
          value={own.branchStart}
          onChange={(branchStart) => patch({ branchStart })}
          options={[
            { value: 'current', label: 'Current branch' },
            { value: 'compare-against', label: 'Compare-against branch' },
          ]}
        />
      </SettingRow>
      <SettingRow
        id="repo-merge-method"
        label="Merge method"
        description={`What Merge on the Branches tab picks first; you can choose another for one merge. Global is ${MERGE_WORDS[settings?.branchMergeMethod ?? 'default']}.`}
        stacked
      >
        <Segmented
          label="Merge method"
          value={own.mergeMethod}
          onChange={(mergeMethod) => patch({ mergeMethod })}
          options={[
            { value: 'global', label: 'Follow global' },
            { value: 'default', label: "Git's default" },
            { value: 'no-ff', label: 'Always a merge commit' },
            { value: 'ff-only', label: 'Fast-forward only' },
          ]}
        />
      </SettingRow>
      <SettingRow
        id="repo-auto-mergeability"
        label="Check mergeability automatically"
        description={`Global is ${AUTO_WORDS[settings?.branchAutoMergeability ?? 'list']}. Turn it off for a very large repository where each check takes a while.`}
        stacked
      >
        <Segmented
          label="Check mergeability automatically"
          value={own.autoMergeability}
          onChange={(autoMergeability) => patch({ autoMergeability })}
          options={[
            { value: 'global', label: 'Follow global' },
            { value: 'off', label: 'Off' },
            { value: 'compare', label: 'When comparing' },
            { value: 'list', label: 'Also in the branch list' },
          ]}
        />
      </SettingRow>
    </SettingGroup>
  );
}

export function RepoSettingsTab({ repo }: { repo: RepositorySummary }) {
  const config = useRepoGitConfig(repo.id);
  const prefs = useRepoPreferences(repo.id);
  const setConfig = useSetRepoGitConfig(repo.id);
  const setPrefs = useSetRepoPreferences(repo.id);
  const { data: settings } = useSettings();
  const { data: editors } = useEditors();

  if (config.isPending || prefs.isPending)
    return <Loading label="Reading this repository's settings…" />;
  if (config.isError || prefs.isError)
    return (
      <EmptyState
        art={<OfflineArt />}
        title="Couldn't read this repository's settings"
        action={
          <Button
            pending={config.isFetching || prefs.isFetching}
            onClick={() => {
              void config.refetch();
              void prefs.refetch();
            }}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(config.error ?? prefs.error, 'Git did not answer.')}
      </EmptyState>
    );

  const git = config.data;
  const own = prefs.data;
  const failure = setConfig.error ?? setPrefs.error;
  const patch = (value: Partial<Omit<RepoPreferences, never>>) =>
    setPrefs.mutate(value);
  const globalPrune =
    git.globalPrune === null ? 'off (not set)' : git.globalPrune ? 'on' : 'off';
  const globalCrlf = git.globalAutocrlf
    ? CRLF_LABEL[git.globalAutocrlf]
    : 'not set';

  return (
    <div className="@container mt-6">
      <p className="mb-8 max-w-[760px] text-sm leading-relaxed text-muted">
        These apply to this repository only. Git settings here are saved in its
        own config (
        <span className="font-mono text-[0.78125rem]">.git/config</span>) and
        win over your global ones. A row left on Follow global keeps nothing
        here.
      </p>
      {failure && (
        <InlineStatus tone="danger" className="mb-6">
          {ipcErrorMessage(failure, "That setting wasn't saved. Try again.")}
        </InlineStatus>
      )}
      <RepoSizeSection repo={repo} />
      <div className="mt-12">
        <IdentityRows repoId={repo.id} />
      </div>

      <div className="mt-12">
        <SettingGroup title="Fetching">
          <SettingRow
            id="repo-default-remote"
            label="Default remote"
            description="The one the Fetch button and automatic fetch use."
          >
            {git.remotes.length ? (
              <select
                aria-label="Default remote"
                value={own.defaultRemote ?? ''}
                onChange={(e) =>
                  patch({ defaultRemote: e.target.value || null })
                }
                className="field h-9 px-2.5 font-mono text-[0.78125rem]"
              >
                <option value="">
                  {git.remotes.includes('origin')
                    ? 'origin (default)'
                    : `${git.remotes[0]} (default)`}
                </option>
                {git.remotes.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
                ))}
              </select>
            ) : (
              <span className="text-[0.8125rem] text-muted">
                No remotes configured
              </span>
            )}
          </SettingRow>
          <SettingRow
            id="repo-prune"
            label="Prune deleted remote branches"
            description={`Global is ${globalPrune}. Local: fetch.prune`}
          >
            <Segmented
              label="Prune deleted remote branches"
              value={git.prune === null ? 'global' : git.prune ? 'on' : 'off'}
              onChange={(next) =>
                setConfig.mutate({
                  prune: next === 'global' ? null : next === 'on',
                })
              }
              options={[
                { value: 'global', label: 'Follow global' },
                { value: 'on', label: 'On' },
                { value: 'off', label: 'Off' },
              ]}
            />
          </SettingRow>
          <SettingRow
            id="repo-auto-fetch"
            label="Fetch automatically"
            description={`Global is ${settings?.autoFetch ? `every ${settings.autoFetch} minutes` : 'off'}. A gitdesk setting, not written to Git.`}
          >
            <Segmented
              label="Fetch automatically"
              value={String(own.autoFetch)}
              onChange={(next) =>
                patch({
                  autoFetch:
                    next === 'global'
                      ? 'global'
                      : (Number(next) as 0 | 5 | 15 | 30),
                })
              }
              options={[
                { value: 'global', label: 'Follow global' },
                { value: '0', label: 'Off' },
                { value: '15', label: '15 min' },
              ]}
            />
          </SettingRow>
        </SettingGroup>
      </div>

      <div className="mt-12">
        <BranchRows repo={repo} own={own} patch={patch} />
      </div>

      <div className="mt-12">
        <SettingGroup title="Files">
          <SettingRow
            id="repo-line-endings"
            label="Line endings"
            description={`Global is ${globalCrlf}. Local: core.autocrlf. A .gitattributes file in the repository wins over both.`}
          >
            <Segmented
              label="Line endings"
              value={git.autocrlf ?? 'global'}
              onChange={(next) =>
                setConfig.mutate({ autocrlf: next === 'global' ? null : next })
              }
              options={[
                { value: 'global', label: 'Follow global' },
                { value: 'true', label: 'Convert' },
                { value: 'input', label: 'Input only' },
                { value: 'false', label: 'Off' },
              ]}
            />
          </SettingRow>
          <SettingRow
            id="repo-gitignore"
            label="Ignored files"
            description="Files listed in .gitignore never appear in Changes and Stage all never stages them."
          >
            <OpenInEditorButton repoId={repo.id} path=".gitignore" />
          </SettingRow>
        </SettingGroup>
      </div>

      <div className="mt-12">
        <SettingGroup title="Workspace">
          <SettingRow
            id="repo-layout"
            label="Layout"
            description={`Global is ${settings?.workspaceLayout ?? 'auto'}.`}
          >
            <Segmented
              label="Layout for this repository"
              value={own.layout}
              onChange={(layout) => patch({ layout })}
              options={[
                { value: 'global', label: 'Follow global' },
                { value: 'centered', label: 'Centered' },
                { value: 'split', label: 'Split' },
              ]}
            />
          </SettingRow>
          <SettingRow
            id="repo-opens-on"
            label="Opens on"
            description="The tab you see when you open this repository."
          >
            <Segmented
              label="Opens on"
              value={own.openOn}
              onChange={(openOn) => patch({ openOn })}
              options={[
                { value: 'changes', label: 'Changes' },
                { value: 'source', label: 'Files' },
                { value: 'overview', label: 'Overview' },
              ]}
            />
          </SettingRow>
          <SettingRow
            id="repo-files-layout"
            label="Files layout"
            description={`Global is ${settings?.sourceLayout ?? 'auto'}.`}
          >
            <Segmented
              label="Files layout for this repository"
              value={own.sourceLayout}
              onChange={(sourceLayout) => patch({ sourceLayout })}
              options={[
                { value: 'global', label: 'Follow global' },
                { value: 'centered', label: 'Centered' },
                { value: 'split', label: 'Split' },
              ]}
            />
          </SettingRow>
          <SettingRow
            id="repo-editor"
            label="Code editor"
            description="Where Open in editor sends this repository's files."
          >
            <div className="flex shrink-0 items-center">
              {(() => {
                const chosen = own.editor ?? settings?.editor ?? 'system';
                const found = editors?.find((e) => e.id === chosen);
                // The editor in use, by its own logo; the select keeps native keyboard behavior.
                return hasEditorLogo(chosen, found?.icon) ? (
                  <span className="mr-2 grid size-7 place-items-center rounded-sm bg-control">
                    <EditorLogo id={chosen} icon={found?.icon} />
                  </span>
                ) : null;
              })()}
              <select
                aria-label="Code editor for this repository"
                value={own.editor ?? ''}
                onChange={(e) =>
                  patch({
                    editor: (e.target.value ||
                      null) as RepoPreferences['editor'],
                  })
                }
                className="field h-9 px-2.5 text-[0.8125rem]"
              >
                <option value="">Follow global</option>
                <option value="system">System default app</option>
                {(editors ?? []).map((editor) => (
                  <option key={editor.id} value={editor.id}>
                    {editor.name}
                  </option>
                ))}
              </select>
            </div>
          </SettingRow>
        </SettingGroup>
      </div>

      <section aria-labelledby="repo-programs" className="mt-12">
        <h2
          id="repo-programs"
          className="mb-2 text-[0.9375rem] font-semibold text-ink"
        >
          Settings that run programs
        </h2>
        {git.programs.length || git.hooks.length ? (
          <InlineStatus tone="warning" className="bg-warning-soft px-3 py-3">
            {git.programs.length > 0 && (
              <>
                This repository's own config sets{' '}
                {git.programs.map((key, i) => (
                  <span key={key}>
                    {i > 0 && ', '}
                    <b className="font-mono text-[0.78125rem] font-semibold">
                      {key}
                    </b>
                  </span>
                ))}
                .{' '}
              </>
            )}
            {git.hooks.length > 0 &&
              `It has ${git.hooks.length} ${git.hooks.length === 1 ? 'hook' : 'hooks'} (${git.hooks.join(', ')}). `}
            They run when you commit, switch or fetch, as they would in a
            terminal. gitdesk never runs them to show status, diffs or history.
          </InlineStatus>
        ) : (
          <InlineStatus tone="success" className="border-y border-line py-3">
            Nothing in this repository's own config runs a program, and it has
            no hooks.
          </InlineStatus>
        )}
      </section>
    </div>
  );
}
