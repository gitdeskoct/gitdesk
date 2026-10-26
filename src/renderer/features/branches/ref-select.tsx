import * as Popover from '@radix-ui/react-popover';
import { Check, ChevronDown, GitBranch } from 'lucide-react';
import { useState } from 'react';
import type { BranchRef } from '../../../shared/branches';
import type { BranchList } from '../../../shared/workspace';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { shortOid } from '../pulls/pull-bits';

// Picks a local or a remote-tracking branch, each group under its own heading so the two are
// never confused. The trigger shows the commit the choice points at.
export function RefSelect({
  id,
  label,
  value,
  list,
  onChange,
  localOnly = false,
}: {
  id: string;
  label: string;
  value: BranchRef | null;
  list: BranchList;
  onChange: (ref: BranchRef) => void;
  localOnly?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const q = query.trim().toLowerCase();
  const groups: {
    title: string;
    kind: BranchRef['kind'];
    rows: { name: string; oid: string; at: number | null }[];
  }[] = [
    {
      title: 'On this computer',
      kind: 'local',
      rows: list.local.filter((b) => b.name.toLowerCase().includes(q)),
    },
    ...(localOnly
      ? []
      : [
          {
            title: 'Remote-tracking',
            kind: 'remote' as const,
            rows: list.remote.filter((b) => b.name.toLowerCase().includes(q)),
          },
        ]),
  ];
  const oid = value
    ? (value.kind === 'local' ? list.local : list.remote).find(
        (b) => b.name === value.name,
      )?.oid
    : undefined;
  const empty = groups.every((g) => !g.rows.length);
  return (
    <div className="grid min-w-0 gap-1">
      <span id={`${id}-label`} className="text-xs text-muted">
        {label}
      </span>
      <Popover.Root open={open} onOpenChange={setOpen}>
        <Popover.Trigger asChild>
          <button
            type="button"
            aria-labelledby={`${id}-label ${id}-value`}
            className="field flex h-8 max-w-full min-w-48 items-center gap-2 px-2.5 text-left"
          >
            <GitBranch aria-hidden className="size-3.5 shrink-0 text-muted" />
            <span
              id={`${id}-value`}
              className={cn(
                'min-w-0 flex-1 truncate font-mono text-[0.78125rem] text-ink',
                !value && 'font-sans text-muted',
              )}
            >
              {value?.name ?? 'Choose a branch'}
            </span>
            {oid && (
              <span className="shrink-0 font-mono text-xs text-muted">
                {shortOid(oid)}
              </span>
            )}
            <ChevronDown aria-hidden className="size-3.5 shrink-0 text-muted" />
          </button>
        </Popover.Trigger>
        <Popover.Portal>
          <Popover.Content
            align="start"
            sideOffset={6}
            collisionPadding={8}
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
            <div className="mt-1 max-h-80 overflow-auto">
              {empty && (
                <p className="px-2 py-3 text-[0.8125rem] text-muted">
                  No branch matches.
                </p>
              )}
              {groups.map(
                (group) =>
                  group.rows.length > 0 && (
                    <div
                      key={group.kind}
                      role="listbox"
                      aria-label={group.title}
                    >
                      <p className="px-2 pt-2 pb-1 text-xs font-medium text-muted">
                        {group.title}
                      </p>
                      {group.rows.map((row) => {
                        const selected =
                          value?.kind === group.kind && value.name === row.name;
                        return (
                          <button
                            key={row.name}
                            type="button"
                            role="option"
                            aria-selected={selected}
                            onClick={() => {
                              onChange({ kind: group.kind, name: row.name });
                              setOpen(false);
                              setQuery('');
                            }}
                            className="flex h-8 w-full items-center gap-2 rounded-[4px] px-2 text-left text-[0.8125rem] hover:bg-control focus-visible:outline-offset-[-2px]"
                          >
                            <span className="min-w-0 flex-1 truncate font-mono text-[0.78125rem] text-ink">
                              {row.name}
                            </span>
                            {row.at && (
                              <span className="shrink-0 text-xs text-muted">
                                {relativeTime(row.at)}
                              </span>
                            )}
                            {selected && (
                              <Check
                                aria-hidden
                                className="size-3.5 text-accent"
                              />
                            )}
                          </button>
                        );
                      })}
                    </div>
                  ),
              )}
            </div>
          </Popover.Content>
        </Popover.Portal>
      </Popover.Root>
    </div>
  );
}
