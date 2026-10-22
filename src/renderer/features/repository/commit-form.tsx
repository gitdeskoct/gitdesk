import { ChevronDown, ChevronUp } from 'lucide-react';
import { useRef, useState, type FormEvent, type KeyboardEvent } from 'react';
import type { RepositorySummary } from '../../../shared/repos';
import type { CommitResult } from '../../../shared/workspace';
import { Button } from '../../components/ui/button';
import { InlineStatus } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import { ipcErrorMessage } from '../../lib/ipc-error';
import { modLabel } from '../../lib/shortcuts';
import { useCommit, useSettings } from '../../lib/queries';
import { useNavigation } from '../../app/navigation';

const plural = (count: number, word: string) =>
  `${count} ${word}${count === 1 ? '' : 's'}`;

// A per-viewer convenience: whether the docked form shows its fields. Storage can be unavailable.
const OPEN_KEY = 'gitdesk.commit-form-open';
function readOpen(): boolean {
  try {
    return localStorage.getItem(OPEN_KEY) !== 'false';
  } catch {
    return true;
  }
}
function saveOpen(open: boolean): void {
  try {
    localStorage.setItem(OPEN_KEY, String(open));
  } catch {
    // The choice simply isn't remembered.
  }
}

// Writes a local commit from what is staged. Results stay in the form, which is still on screen,
// so nothing here is a toast; a commit is never pushed from here.
export function CommitForm({
  repo,
  staged,
  conflicts,
  compact = false,
}: {
  repo: RepositorySummary;
  staged: number;
  conflicts: number;
  compact?: boolean;
}) {
  const { data: settings } = useSettings();
  const { navigate } = useNavigation();
  const commit = useCommit(repo.id);
  const [summary, setSummary] = useState('');
  const [description, setDescription] = useState('');
  const [result, setResult] = useState<CommitResult | null>(null);
  // Docked beside the file list, the fields can fold away so more files fit; the text is kept.
  const [open, setOpenState] = useState(() => !compact || readOpen());
  const summaryRef = useRef<HTMLInputElement>(null);
  const setOpen = (next: boolean) => {
    setOpenState(next);
    saveOpen(next);
    if (next) requestAnimationFrame(() => summaryRef.current?.focus());
  };
  const branch = repo.status?.branch;
  const guide = settings?.commitSummaryGuide ?? 72;
  const over = guide > 0 && summary.trim().length > guide;
  const blocked = staged === 0 || conflicts > 0 || !summary.trim();
  const reason =
    conflicts > 0
      ? `${plural(conflicts, 'file')} still ${conflicts === 1 ? 'has' : 'have'} conflicts. Resolve and stage them first.`
      : staged === 0
        ? 'Stage at least one file to commit.'
        : !summary.trim()
          ? 'Write a summary to commit.'
          : 'A local commit. It stays on this computer until you push.';

  const submit = (event?: FormEvent) => {
    event?.preventDefault();
    // Folded with no summary yet: open the fields instead of refusing silently.
    if (!open && staged > 0 && !summary.trim()) return setOpen(true);
    if (blocked || commit.isPending) return;
    setResult(null);
    commit.mutate(
      { summary: summary.trim(), description },
      {
        onSuccess: (outcome) => {
          setResult(outcome);
          if (outcome.status === 'committed') {
            setSummary('');
            setDescription('');
          }
        },
      },
    );
  };
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) submit();
  };

  const label =
    staged > 0
      ? `Commit ${plural(staged, 'file')}${branch ? ` to ${branch}` : ''}`
      : `Commit${branch ? ` to ${branch}` : ''}`;

  return (
    <form
      onSubmit={submit}
      aria-label="Commit"
      className={cn(
        'grid gap-2',
        compact ? 'p-3' : 'pt-3',
        compact && !open && 'py-2',
      )}
      noValidate
    >
      {compact && !open && (
        <div className="flex items-center gap-2">
          <Button
            size="sm"
            variant="ghost"
            aria-expanded={false}
            aria-controls="commit-fields"
            onClick={() => setOpen(true)}
          >
            <ChevronUp />
            Show message
          </Button>
          <span
            className="min-w-0 flex-1 truncate text-xs text-muted"
            title={summary || undefined}
          >
            {summary.trim() || (staged ? 'No summary yet' : 'Nothing staged')}
          </span>
          <Button
            type="submit"
            size="sm"
            variant="primary"
            pending={commit.isPending}
            aria-disabled={staged === 0 || conflicts > 0 || undefined}
          >
            {staged > 0 ? `Commit ${plural(staged, 'file')}` : 'Commit'}
          </Button>
        </div>
      )}
      {compact && open && (
        <div className="-mt-1 -mb-1 flex items-center justify-between">
          <span className="text-xs font-medium text-muted">Commit message</span>
          <Button
            size="sm"
            variant="ghost"
            aria-expanded
            aria-controls="commit-fields"
            onClick={() => setOpen(false)}
          >
            <ChevronDown />
            Hide
          </Button>
        </div>
      )}
      {open && (
        <div id="commit-fields" className="grid gap-2">
          <label className="grid gap-1 text-xs font-medium text-ink">
            <span className="flex justify-between">
              Summary
              {guide > 0 && summary.length > 0 && (
                <span
                  className={cn(
                    'tabular-nums',
                    over ? 'font-semibold text-ink' : 'text-muted',
                  )}
                >
                  {summary.trim().length}/{guide}
                </span>
              )}
            </span>
            <input
              ref={summaryRef}
              type="text"
              value={summary}
              onChange={(event) =>
                setSummary(event.target.value.replace(/[\r\n]/g, ' '))
              }
              onKeyDown={onKeyDown}
              maxLength={500}
              placeholder="What this commit does"
              aria-invalid={over || undefined}
              aria-describedby="commit-reason"
              className="field h-9 px-3 text-[0.8125rem] outline-none placeholder:text-muted"
            />
          </label>
          {over && (
            <p className="text-xs text-muted">
              Past {guide} characters. Git tools often cut a longer summary
              short.
            </p>
          )}
          <label className="grid gap-1 text-xs font-medium text-ink">
            Description
            <textarea
              value={description}
              onChange={(event) => setDescription(event.target.value)}
              onKeyDown={onKeyDown}
              rows={compact ? 3 : 4}
              maxLength={10_000}
              placeholder="Optional. What changed and why."
              className="field resize-y px-3 py-2 text-[0.8125rem] outline-none placeholder:text-muted"
            />
          </label>
          <Button
            type="submit"
            variant="primary"
            pending={commit.isPending}
            aria-disabled={blocked || undefined}
            className={cn(compact && 'w-full')}
          >
            {label}
          </Button>
          <p id="commit-reason" className="text-xs text-muted">
            {commit.isPending
              ? 'Committing. Your Git hooks run as they would in a terminal.'
              : reason}
            {!commit.isPending && !blocked && ` ${modLabel()}+Enter commits.`}
          </p>
        </div>
      )}

      {result?.status === 'committed' && (
        <InlineStatus tone="success">
          Committed{' '}
          <b className="font-mono text-[0.78125rem] font-semibold">
            {result.oid.slice(0, 7)}
          </b>
          {result.branch ? ` to ${result.branch}` : ''}. It stays on this
          computer until you push.
        </InlineStatus>
      )}
      {result?.status === 'rejected' && result.reason === 'identity' && (
        <InlineStatus
          tone="warning"
          action={
            <Button
              size="sm"
              variant="link"
              onClick={() =>
                navigate({
                  name: 'settings',
                  section: 'git',
                  row: 'git-identity',
                })
              }
            >
              Set them
            </Button>
          }
        >
          Git needs your name and email before it can commit.
        </InlineStatus>
      )}
      {result?.status === 'rejected' && result.reason !== 'identity' && (
        <div
          role="alert"
          className="grid gap-2 bg-danger-soft px-3 py-2.5 text-[0.8125rem] text-ink"
        >
          <span>
            {result.reason === 'hook'
              ? 'A Git hook stopped the commit. Nothing was committed and your staged files are unchanged.'
              : result.reason === 'nothing-staged'
                ? 'Nothing is staged any more, so there was nothing to commit.'
                : result.reason === 'conflicts'
                  ? 'Some files still have conflicts. Resolve and stage them first.'
                  : result.reason === 'busy'
                    ? 'Another Git process is using this repository. Try again in a moment.'
                    : 'Git did not make the commit. Nothing was changed.'}
          </span>
          {result.output && (
            <pre className="max-h-32 overflow-auto rounded-[4px] bg-surface p-2 font-mono text-[0.71875rem] leading-4 whitespace-pre-wrap">
              {result.output}
            </pre>
          )}
        </div>
      )}
      {commit.isError && (
        <InlineStatus tone="danger">
          {ipcErrorMessage(commit.error, "The commit wasn't made. Try again.")}
        </InlineStatus>
      )}
    </form>
  );
}
