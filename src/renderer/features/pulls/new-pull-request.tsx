import { ArrowLeftRight, GitMerge } from 'lucide-react';
import { useState } from 'react';
import type { RepositorySummary } from '../../../shared/repos';
import { pullTitleSchema, type PullRequest } from '../../../shared/pulls';
import { Button } from '../../components/ui/button';
import { Checkbox } from '../../components/ui/checkbox';
import { InlineStatus, Loading } from '../../components/ui/status';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { useComparePreview, useCreatePull } from '../../lib/pull-queries';
import { useBranches } from '../../lib/queries';
import { BranchSelect } from './branch-select';
import { plural, shortOid } from './pull-bits';

const PROBLEMS = {
  'same-branch': 'Pick two different branches.',
  'source-missing': 'That branch no longer exists here.',
  'target-missing': 'That branch no longer exists here.',
  unrelated: 'These branches share no history, so there is nothing to compare.',
  'nothing-to-merge':
    'has nothing the other branch lacks. Did you mean to swap them?',
} as const;

// Inline in the tab, never a modal: the comparison shows before anything is saved.
export function NewPullRequest({
  repo,
  store,
  initial,
  onCreated,
  onCancel,
}: {
  repo: RepositorySummary;
  store: 'local' | 'account';
  initial?: { source: string; target: string };
  onCreated: (pull: PullRequest) => void;
  onCancel: () => void;
}) {
  const branches = useBranches(repo.id, repo.statusAt);
  const local = branches.data?.local ?? [];
  const current = repo.status?.branch ?? null;
  const fallbackTarget =
    local.find((b) => b.name === 'main' || b.name === 'master')?.name ?? null;
  const [target, setTarget] = useState<string | null>(initial?.target ?? null);
  const [source, setSource] = useState<string | null>(initial?.source ?? null);
  const chosenTarget = target ?? fallbackTarget;
  // The current branch when it isn't the target, else the most recently changed other branch.
  const chosenSource =
    source ??
    (current && current !== chosenTarget
      ? current
      : (local.find((b) => b.name !== chosenTarget)?.name ?? null));
  const preview = useComparePreview(
    repo.id,
    chosenSource,
    chosenTarget,
    repo.statusAt,
  );
  const create = useCreatePull(repo.id);
  const [title, setTitle] = useState('');
  const [description, setDescription] = useState('');
  const [draft, setDraft] = useState(false);
  const [titleError, setTitleError] = useState<string>();
  const [key] = useState(() => crypto.randomUUID());

  const ok = preview.data?.status === 'ok' ? preview.data.comparison : null;
  const problem =
    preview.data?.status === 'problem' ? preview.data.problem : null;
  const defaultTitle = ok?.commits.length === 1 ? ok.commits[0]!.subject : '';

  const submit = () => {
    const parsed = pullTitleSchema.safeParse(title || defaultTitle);
    if (!parsed.success) return setTitleError(parsed.error.issues[0]?.message);
    if (!ok || !chosenSource || !chosenTarget || create.isPending) return;
    create.mutate(
      {
        title: parsed.data,
        description,
        source: chosenSource,
        target: chosenTarget,
        draft,
        key,
      },
      { onSuccess: onCreated },
    );
  };

  return (
    <form
      aria-label="New pull request"
      className="grid gap-x-9 gap-y-6 pt-6 @min-[900px]:grid-cols-[minmax(0,1fr)_18rem]"
      onSubmit={(event) => {
        event.preventDefault();
        submit();
      }}
    >
      <div className="min-w-0">
        <h2 className="text-[1.0625rem] font-semibold text-ink">
          New pull request
        </h2>
        <p className="mt-1 text-[0.8125rem] text-muted">
          Pick what to merge and where. Nothing is merged until you merge it
          yourself.
        </p>
        <div className="mt-5 flex flex-wrap items-end gap-2.5">
          <BranchSelect
            id="pr-target"
            label="Merge into"
            value={chosenTarget}
            branches={local}
            loading={branches.isPending}
            onChange={setTarget}
          />
          <Button
            type="button"
            size="icon"
            className="mb-0.5 size-9"
            aria-label="Swap branches"
            title="Swap branches"
            onClick={() => {
              setTarget(chosenSource);
              setSource(chosenTarget);
            }}
          >
            <ArrowLeftRight />
          </Button>
          <BranchSelect
            id="pr-source"
            label="Changes from"
            value={chosenSource}
            branches={local}
            loading={branches.isPending}
            onChange={setSource}
          />
        </div>

        <div className="mt-3.5" aria-live="polite">
          {preview.isFetching && !preview.data && (
            <Loading label="Comparing the branches…" />
          )}
          {preview.isError && (
            <InlineStatus tone="danger">
              {ipcErrorMessage(
                preview.error,
                "Git couldn't compare the branches.",
              )}
            </InlineStatus>
          )}
          {ok && (
            <InlineStatus>
              <span className="inline-flex items-start gap-2">
                <GitMerge
                  aria-hidden
                  className="mt-0.5 size-3.5 shrink-0 text-accent"
                />
                <span>
                  <b className="font-semibold">
                    {plural(ok.commits.length, 'commit')},{' '}
                    {plural(ok.files.length, 'file')}, +{ok.added} −{ok.removed}
                    .
                  </b>{' '}
                  What{' '}
                  <span className="font-mono text-[0.78125rem]">
                    {chosenSource}
                  </span>{' '}
                  adds since it left{' '}
                  <span className="font-mono text-[0.78125rem]">
                    {chosenTarget}
                  </span>{' '}
                  at{' '}
                  <span className="font-mono text-[0.78125rem]">
                    {shortOid(ok.mergeBaseOid)}
                  </span>
                  .
                </span>
              </span>
            </InlineStatus>
          )}
          {problem && (
            <InlineStatus
              tone="warning"
              action={
                problem === 'nothing-to-merge' ? (
                  <Button
                    type="button"
                    size="sm"
                    onClick={() => {
                      setTarget(chosenSource);
                      setSource(chosenTarget);
                    }}
                  >
                    Swap
                  </Button>
                ) : undefined
              }
            >
              {problem === 'nothing-to-merge' ? (
                <>
                  <span className="font-mono text-[0.78125rem]">
                    {chosenSource}
                  </span>{' '}
                  {PROBLEMS[problem]}
                </>
              ) : (
                PROBLEMS[problem]
              )}
            </InlineStatus>
          )}
        </div>

        <label className="mt-5 block">
          <span className="mb-1.5 block text-[0.8125rem] font-medium text-ink">
            Title
          </span>
          <input
            className="field h-9 w-full px-3 text-[0.8125rem] outline-none placeholder:text-muted"
            value={title}
            placeholder={defaultTitle || 'What this change does'}
            maxLength={200}
            aria-invalid={!!titleError || undefined}
            aria-describedby={titleError ? 'pr-title-error' : undefined}
            onChange={(event) => {
              setTitle(event.target.value);
              setTitleError(undefined);
            }}
          />
          {titleError && (
            <span
              id="pr-title-error"
              className="mt-1 block text-xs text-danger"
            >
              {titleError}
            </span>
          )}
        </label>
        <label className="mt-4 block">
          <span className="mb-1.5 block text-[0.8125rem] font-medium text-ink">
            Description
          </span>
          <textarea
            className="field min-h-28 w-full px-3 py-2 text-[0.8125rem] leading-relaxed outline-none placeholder:text-muted"
            value={description}
            maxLength={10_000}
            placeholder="Why this change, what it does, anything to check when reviewing"
            onChange={(event) => setDescription(event.target.value)}
          />
        </label>
        <label className="mt-3 flex items-center gap-2.5 text-[0.8125rem] text-ink">
          <Checkbox
            checked={draft}
            onCheckedChange={(value) => setDraft(value === true)}
          />
          Mark as draft (not ready for review)
        </label>

        {create.isError && (
          <InlineStatus tone="danger" className="mt-4">
            {ipcErrorMessage(create.error, "The pull request wasn't saved.")}
          </InlineStatus>
        )}
        <div className="mt-5 flex flex-wrap items-center gap-2.5">
          <Button
            type="submit"
            variant="primary"
            pending={create.isPending}
            aria-disabled={!ok || undefined}
          >
            Create pull request
          </Button>
          <Button type="button" variant="ghost" onClick={onCancel}>
            Cancel
          </Button>
          <span className="text-xs text-muted">
            {store === 'account'
              ? 'Saved to your account. The branches stay on this computer.'
              : 'Saved on this computer, because this repository is not linked to your account.'}
          </span>
        </div>
      </div>

      <aside aria-label="Commits in this pull request" className="min-w-0">
        <h3 className="text-[0.8125rem] font-semibold text-ink">
          Commits in this pull request
        </h3>
        {ok ? (
          <ul className="mt-2 border-t border-line">
            {ok.commits.slice(0, 12).map((c) => (
              <li
                key={c.oid}
                className="flex gap-2.5 border-b border-line py-2 text-[0.8125rem]"
              >
                <span className="shrink-0 font-mono text-[0.75rem] text-muted">
                  {shortOid(c.oid)}
                </span>
                <span className="min-w-0 truncate text-ink">{c.subject}</span>
              </li>
            ))}
            {ok.commits.length > 12 && (
              <li className="py-2 text-xs text-muted">
                and {ok.commits.length - 12} more
              </li>
            )}
          </ul>
        ) : (
          <p className="mt-2 text-[0.8125rem] text-muted">
            Pick two branches to see them.
          </p>
        )}
        <h3 className="mt-6 text-[0.8125rem] font-semibold text-ink">
          Refused before anything is saved
        </h3>
        <ul className="mt-1.5 list-disc pl-4.5 text-[0.8125rem] leading-relaxed text-muted">
          <li>The same branch on both sides</li>
          <li>No commits to merge</li>
          <li>Branches with no shared history</li>
          <li>A branch that no longer exists</li>
        </ul>
      </aside>
    </form>
  );
}
