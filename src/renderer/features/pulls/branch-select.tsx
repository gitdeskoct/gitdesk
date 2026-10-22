import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, GitBranch } from 'lucide-react';
import { useState } from 'react';
import type { LocalBranch } from '../../../shared/workspace';
import { Loading } from '../../components/ui/status';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';

// Picks one of this computer's branches. Pull requests compare local branches, so remote-tracking
// ones are left out; fetch and check one out first to use it.
export function BranchSelect({
  id,
  label,
  value,
  branches,
  loading,
  onChange,
}: {
  id: string;
  label: string;
  value: string | null;
  branches: LocalBranch[];
  loading: boolean;
  onChange: (name: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const shown = branches.filter((b) => b.name.toLowerCase().includes(q));
  return (
    <div className="min-w-0 flex-1">
      <span
        id={`${id}-label`}
        className="mb-1.5 block text-[0.8125rem] font-medium text-ink"
      >
        {label}
      </span>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-labelledby={`${id}-label ${id}-value`}
            className="field flex h-9 w-full items-center gap-2 px-3 text-left"
          >
            <GitBranch aria-hidden className="size-4 shrink-0 text-muted" />
            <span
              id={`${id}-value`}
              className={cn(
                'min-w-0 flex-1 truncate font-mono text-[0.78125rem]',
                !value && 'font-sans text-muted',
              )}
            >
              {value ?? 'Choose a branch'}
            </span>
            <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            aria-label={label}
            className="z-50 w-80 rounded-sm border border-line bg-raised p-1.5 shadow-[0_8px_24px_rgb(0_0_0/0.14)]"
          >
            <label className="field flex h-8 items-center px-2.5">
              <span className="sr-only">Find a branch</span>
              <input
                autoFocus
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder="Find a branch"
                spellCheck={false}
                className="min-w-0 flex-1 bg-transparent font-mono text-[0.78125rem] text-ink outline-none placeholder:font-sans placeholder:text-muted"
              />
            </label>
            <div
              role="listbox"
              aria-label={label}
              className="mt-1 max-h-72 overflow-auto"
            >
              {loading && <Loading label="Reading branches…" />}
              {!loading && !shown.length && (
                <p className="px-2 py-3 text-[0.8125rem] text-muted">
                  No branch matches.
                </p>
              )}
              {shown.map((branch) => (
                <button
                  key={branch.name}
                  type="button"
                  role="option"
                  aria-selected={branch.name === value}
                  onClick={() => {
                    onChange(branch.name);
                    setOpen(false);
                    setQuery('');
                  }}
                  className="flex h-8 w-full items-center gap-2 rounded-[4px] px-2 text-left text-[0.8125rem] hover:bg-control focus-visible:outline-offset-[-2px]"
                >
                  <span className="min-w-0 flex-1 truncate font-mono text-[0.78125rem] text-ink">
                    {branch.name}
                  </span>
                  {branch.at && (
                    <span className="shrink-0 text-xs text-muted">
                      {relativeTime(branch.at)}
                    </span>
                  )}
                  {branch.name === value && (
                    <Check aria-hidden className="size-3.5 text-accent" />
                  )}
                </button>
              ))}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
