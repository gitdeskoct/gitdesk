import * as Toolbar from '@radix-ui/react-toolbar';
import {
  ArrowDown,
  ArrowLeftRight,
  ArrowUp,
  Check,
  CircleCheck,
  CloudDownload,
  CloudOff,
  CloudUpload,
  Copy,
  GitBranch,
  GitCompare,
  GitMerge,
  GitPullRequest,
  Link2,
  Lock,
  MoreHorizontal,
  Pencil,
  Plus,
  Radar,
  RefreshCw,
  Trash2,
  TriangleAlert,
  type LucideIcon,
} from 'lucide-react';
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  isProtected,
  LIST_MERGEABILITY_LIMIT,
  type BranchMergeMethod,
  type BranchOverview,
  type BranchRef,
  type MergeabilityCheck,
  type RemoteHeadsCheck,
} from '../../../shared/branches';
import type { RepositorySummary } from '../../../shared/repos';
import type {
  LocalBranch,
  RemoteBranch,
  SwitchResult,
} from '../../../shared/workspace';
import { useNavigation } from '../../app/navigation';
import {
  BranchesArt,
  NoResultsArt,
  OfflineArt,
  RemoteArt,
} from '../../components/illustrations';
import { Button } from '../../components/ui/button';
import {
  ContextMenu,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuTrigger,
} from '../../components/ui/context-menu';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '../../components/ui/dropdown-menu';
import { EmptyState } from '../../components/ui/empty-state';
import { Segmented } from '../../components/ui/segmented';
import { Spinner } from '../../components/ui/spinner';
import { InlineStatus, Loading } from '../../components/ui/status';
import { useToast } from '../../components/ui/toast';
import {
  useBranchOverview,
  useCheckRemote,
  useListMergeability,
  usePushBranch,
} from '../../lib/branch-queries';
import { cn } from '../../lib/cn';
import { relativeTime } from '../../lib/format';
import { ipcErrorMessage } from '../../lib/ipc-error';
import {
  useRemotes,
  useRepoPreferences,
  useSettings,
  useSwitchBranch,
} from '../../lib/queries';
import { plural } from '../pulls/pull-bits';
import type { SwitchOutcome } from '../repository/branch-picker';
import { Section, SummaryStrip } from '../repository/history';
import { useFetchAction } from '../repository/use-fetch';
import {
  BandSlot,
  DeleteBand,
  DeleteRemoteBand,
  NewBranchBand,
  RenameBand,
  RenamedBand,
  UpstreamBand,
} from './branch-bands';
import { CompareWorkspace, effectiveAuto } from './compare-workspace';

type Filter =
  | 'all'
  | 'local'
  | 'remote'
  | 'diverging'
  | 'no-upstream'
  | 'merged'
  | 'stale';

type Band =
  | { kind: 'new' }
  | { kind: 'rename'; name: string }
  | { kind: 'renamed'; to: string; upstream: string }
  | { kind: 'delete'; name: string }
  | { kind: 'upstream'; name: string }
  | {
      kind: 'delete-remote';
      anchor: string;
      remote: string;
      branch: string;
      oid: string;
    };

type Action = {
  key: string;
  label: string;
  icon: LucideIcon;
  danger?: boolean;
  onSelect: () => void;
};

const DAY_MS = 24 * 60 * 60_000;

// The relationship to the upstream in words and an arrow, never a color alone.
function upstreamState(branch: LocalBranch): {
  icon: LucideIcon;
  tone: string;
  text: string;
} {
  if (!branch.upstream)
    return { icon: CloudOff, tone: 'text-muted', text: 'No upstream' };
  if (branch.gone)
    return {
      icon: TriangleAlert,
      tone: 'text-warning',
      text: 'Upstream missing',
    };
  const ahead = branch.ahead ?? 0;
  const behind = branch.behind ?? 0;
  if (ahead && behind)
    return {
      icon: ArrowLeftRight,
      tone: 'text-warning',
      text: `Diverged · ↑ ${ahead} · ↓ ${behind}`,
    };
  if (ahead)
    return { icon: ArrowUp, tone: 'text-accent', text: `${ahead} ahead` };
  if (behind)
    return { icon: ArrowDown, tone: 'text-accent', text: `${behind} behind` };
  return { icon: CircleCheck, tone: 'text-success', text: 'Up to date' };
}

function Overflow({ label, actions }: { label: string; actions: Action[][] }) {
  const groups = actions.filter((group) => group.length);
  if (!groups.length) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button size="icon" variant="ghost" aria-label={`More for ${label}`}>
          <MoreHorizontal />
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="end" aria-label={label}>
        {groups.map((group, index) => (
          <div key={index}>
            {index > 0 && <DropdownMenuSeparator />}
            {group.map((action) => (
              <DropdownMenuItem
                key={action.key}
                onSelect={action.onSelect}
                className={
                  action.danger ? 'text-danger [&_svg]:text-danger' : undefined
                }
              >
                <action.icon aria-hidden />
                {action.label}
              </DropdownMenuItem>
            ))}
          </div>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

function MergeLine({
  check,
  checking,
  target,
}: {
  check: MergeabilityCheck | undefined;
  checking: boolean;
  target: string;
}) {
  if (check?.mergeability === 'mergeable')
    return (
      <span className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-ink">
        <CircleCheck aria-hidden className="size-3.5 text-success" />
        Merges cleanly into {target}
      </span>
    );
  if (check?.mergeability === 'conflicts')
    return (
      <span className="mt-0.5 flex items-center gap-1.5 text-xs font-medium text-ink">
        <TriangleAlert aria-hidden className="size-3.5 text-warning" />
        {check.conflicts.length
          ? `Conflicts with ${target} in ${plural(check.conflicts.length, 'file')}`
          : `Conflicts with ${target}`}
      </span>
    );
  if (checking && !check)
    return (
      <span className="mt-0.5 flex items-center gap-1.5 text-xs text-muted">
        <Spinner className="size-3.5" />
        Checking against {target}…
      </span>
    );
  return null;
}

// Arrow keys move between rows; each row's name button is its one tab stop.
function rowKeys(event: KeyboardEvent<HTMLUListElement>) {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [
    ...event.currentTarget.querySelectorAll<HTMLElement>('[data-row-focus]'),
  ];
  const at = rows.indexOf(document.activeElement as HTMLElement);
  if (at < 0) return;
  event.preventDefault();
  rows[
    Math.max(
      0,
      Math.min(rows.length - 1, at + (event.key === 'ArrowDown' ? 1 : -1)),
    )
  ]?.focus();
}

function Overview({
  repo,
  list,
  onCompare,
  onOutcome,
}: {
  repo: RepositorySummary;
  list: BranchOverview;
  onCompare: (
    base: BranchRef | null,
    source: BranchRef | null,
    merge?: boolean,
  ) => void;
  onOutcome: (outcome: SwitchOutcome) => void;
}) {
  const { navigate } = useNavigation();
  const { data: settings } = useSettings();
  const prefs = useRepoPreferences(repo.id);
  const remotes = useRemotes(repo.id, repo.statusAt);
  const switchBranch = useSwitchBranch(repo.id);
  const push = usePushBranch(repo.id);
  const fetchAction = useFetchAction(repo.id, { toast: true });
  const checkRemote = useCheckRemote(repo.id);
  const toast = useToast();
  const [band, setBand] = useState<Band | null>(null);
  const [filter, setFilter] = useState<Filter>('all');
  const [query, setQuery] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const [focusName, setFocusName] = useState<string | null>(null);
  const [heads, setHeads] = useState<Extract<
    RemoteHeadsCheck,
    { status: 'checked' }
  > | null>(null);
  const listRef = useRef<HTMLDivElement>(null);

  const names = remotes.data?.map((r) => r.name) ?? [];
  const remote =
    (prefs.data?.defaultRemote && names.includes(prefs.data.defaultRemote)
      ? prefs.data.defaultRemote
      : names.includes('origin')
        ? 'origin'
        : names[0]) ?? null;
  const target = list.target;
  const targetName = target?.name ?? null;
  const merged = new Set(list.merged);
  const protectedSet = new Set(list.protected);
  const staleDays = settings?.branchStaleDays ?? 90;
  const stale = (b: { at: number | null }) =>
    staleDays > 0 && b.at !== null && Date.now() - b.at > staleDays * DAY_MS;
  const auto = effectiveAuto(settings, prefs.data);
  const current = list.local.find((b) => b.current) ?? null;

  // Unmerged branches, newest first, checked one at a time against the compare-against tip.
  const candidates = useMemo(
    () =>
      list.local
        .filter(
          (b) =>
            !merged.has(b.name) &&
            b.name !== targetName &&
            b.oid !== target?.oid,
        )
        .slice(0, LIST_MERGEABILITY_LIMIT),
    [list, targetName],
  );
  const listChecks = useListMergeability(
    repo.id,
    target?.oid ?? null,
    candidates.map((b) => b.oid),
    auto === 'list',
  );
  const checkFor = (oid: string) =>
    listChecks.data?.find(
      (c) => c.sourceOid === oid && c.targetOid === target?.oid,
    );

  useEffect(() => {
    if (!focusName) return;
    const row = listRef.current?.querySelector<HTMLElement>(
      `[data-row-name="${CSS.escape(focusName)}"]`,
    );
    if (row) {
      row.focus();
      setFocusName(null);
    }
  }, [focusName, list]);

  const q = query.trim().toLowerCase();
  const sortRows = <T extends { name: string; at: number | null }>(
    rows: T[],
  ) =>
    settings?.branchSort === 'name'
      ? [...rows].sort((a, b) => a.name.localeCompare(b.name))
      : rows;
  const localRows = sortRows(
    list.local.filter((b) => {
      if (q && !b.name.toLowerCase().includes(q)) return false;
      switch (filter) {
        case 'remote':
          return false;
        case 'diverging':
          return !!(b.ahead || b.behind);
        case 'no-upstream':
          return !b.upstream;
        case 'merged':
          return merged.has(b.name);
        case 'stale':
          return stale(b);
        default:
          return true;
      }
    }),
  ).sort((a, b) => Number(b.current) - Number(a.current));
  const showRemote =
    filter === 'remote' ||
    (filter === 'all' && (settings?.branchShowRemote ?? true));
  const remoteRows = showRemote
    ? sortRows(
        list.remote.filter((b) => !q || b.name.toLowerCase().includes(q)),
      )
    : [];

  const switchTo = (name: string, kind: 'local' | 'remote') => {
    if (busy) return;
    setBusy(name);
    switchBranch.mutate(
      { name, kind },
      {
        onSuccess: (result: SwitchResult) =>
          onOutcome({ target: name, result }),
        onError: (err) =>
          onOutcome({
            target: name,
            error: ipcErrorMessage(err, 'Git did not switch. Try again.'),
          }),
        onSettled: () => setBusy(null),
      },
    );
  };
  const pushBranch = (name: string) => {
    if (busy) return;
    setBusy(name);
    push.mutate(
      { name, jobId: crypto.randomUUID() },
      {
        onSuccess: (result) =>
          toast(
            result.status === 'pushed'
              ? {
                  tone: 'success',
                  title: `Pushed ${result.branch} to ${result.remote}`,
                }
              : {
                  tone: 'danger',
                  title: "Didn't push",
                  description: result.message,
                },
          ),
        onError: (err) =>
          toast({
            tone: 'danger',
            title: "Didn't push",
            description: ipcErrorMessage(err, 'Git could not push. Try again.'),
          }),
        onSettled: () => setBusy(null),
      },
    );
  };
  const copy = (name: string) =>
    void navigator.clipboard
      .writeText(name)
      .then(() => toast({ tone: 'success', title: `Copied ${name}` }))
      .catch(() => toast({ tone: 'danger', title: "Couldn't copy the name" }));
  const targetRef = (): BranchRef | null =>
    target
      ? {
          kind: list.local.some((b) => b.name === target.name)
            ? 'local'
            : 'remote',
          name: target.name,
        }
      : null;

  const localActions = (b: LocalBranch): Action[][] => {
    const locked = protectedSet.has(b.name);
    const tracking =
      b.upstream && !b.gone
        ? list.remote.find((r) => r.name === b.upstream)
        : undefined;
    return [
      [
        ...(!b.current && !b.otherWorktree
          ? [
              {
                key: 'switch',
                label: 'Switch',
                icon: GitBranch,
                onSelect: () => switchTo(b.name, 'local'),
              },
            ]
          : []),
        ...(targetName && targetName !== b.name
          ? [
              {
                key: 'compare',
                label: `Compare with ${targetName}`,
                icon: GitCompare,
                onSelect: () =>
                  onCompare(targetRef(), { kind: 'local', name: b.name }),
              },
            ]
          : []),
        ...(current && current.name !== b.name
          ? [
              {
                key: 'merge',
                label: `Merge into ${current.name}…`,
                icon: GitMerge,
                onSelect: () =>
                  onCompare(
                    { kind: 'local', name: current.name },
                    { kind: 'local', name: b.name },
                    true,
                  ),
              },
            ]
          : []),
        ...(targetName &&
        targetName !== b.name &&
        list.local.some((l) => l.name === targetName)
          ? [
              {
                key: 'pull',
                label: 'Create pull request',
                icon: GitPullRequest,
                onSelect: () =>
                  navigate({
                    name: 'repository',
                    id: repo.id,
                    tab: 'pulls',
                    newPull: { source: b.name, target: targetName },
                  }),
              },
            ]
          : []),
      ],
      [
        ...(remote
          ? [
              {
                key: 'push',
                label:
                  b.upstream && !b.gone
                    ? `Push${b.ahead ? ` ${plural(b.ahead, 'commit')}` : ''}`
                    : 'Publish',
                icon: CloudUpload,
                onSelect: () => pushBranch(b.name),
              },
            ]
          : []),
        {
          key: 'upstream',
          label: 'Change upstream…',
          icon: Link2,
          onSelect: () => setBand({ kind: 'upstream', name: b.name }),
        },
        ...(!locked && !b.otherWorktree
          ? [
              {
                key: 'rename',
                label: 'Rename…',
                icon: Pencil,
                onSelect: () => setBand({ kind: 'rename', name: b.name }),
              },
            ]
          : []),
        {
          key: 'copy',
          label: 'Copy name',
          icon: Copy,
          onSelect: () => copy(b.name),
        },
      ],
      [
        ...(!locked && !b.current && !b.otherWorktree
          ? [
              {
                key: 'delete',
                label: 'Delete on this computer…',
                icon: Trash2,
                danger: true,
                onSelect: () => setBand({ kind: 'delete', name: b.name }),
              },
            ]
          : []),
        ...(!locked && tracking
          ? [
              {
                key: 'delete-remote',
                label: `Delete on ${tracking.remote}…`,
                icon: CloudOff,
                danger: true,
                onSelect: () =>
                  setBand({
                    kind: 'delete-remote',
                    anchor: b.name,
                    remote: tracking.remote,
                    branch: tracking.branch,
                    oid: tracking.oid,
                  }),
              },
            ]
          : []),
      ],
    ];
  };

  const remoteActions = (b: RemoteBranch): Action[][] => [
    [
      ...(!b.hasLocal
        ? [
            {
              key: 'checkout',
              label: `Check out as ${b.branch}`,
              icon: GitBranch,
              onSelect: () => switchTo(b.name, 'remote'),
            },
          ]
        : []),
      ...(targetName && targetName !== b.name
        ? [
            {
              key: 'compare',
              label: `Compare with ${targetName}`,
              icon: GitCompare,
              onSelect: () =>
                onCompare(targetRef(), { kind: 'remote', name: b.name }),
            },
          ]
        : []),
      ...(current
        ? [
            {
              key: 'merge',
              label: `Merge into ${current.name}…`,
              icon: GitMerge,
              onSelect: () =>
                onCompare(
                  { kind: 'local', name: current.name },
                  { kind: 'remote', name: b.name },
                  true,
                ),
            },
          ]
        : []),
      {
        key: 'copy',
        label: 'Copy name',
        icon: Copy,
        onSelect: () => copy(b.name),
      },
    ],
    !isProtected(b.branch, prefs.data?.protectedBranches ?? [])
      ? [
          {
            key: 'delete-remote',
            label: `Delete on ${b.remote}…`,
            icon: CloudOff,
            danger: true,
            onSelect: () =>
              setBand({
                kind: 'delete-remote',
                anchor: b.name,
                remote: b.remote,
                branch: b.branch,
                oid: b.oid,
              }),
          },
        ]
      : [],
  ];

  const bandFor = (anchor: string): ReactNode => {
    if (!band) return null;
    const close = (focus: string | null = anchor) => {
      setBand(null);
      setFocusName(focus);
    };
    const branch = list.local.find((b) => b.name === anchor);
    switch (band.kind) {
      case 'rename':
        return band.name === anchor && branch ? (
          <BandSlot>
            <RenameBand
              repo={repo}
              branch={branch}
              onCancel={() => close()}
              onDone={(to, upstream) => {
                setFocusName(to);
                setBand(
                  upstream && !branch.gone
                    ? { kind: 'renamed', to, upstream }
                    : null,
                );
              }}
            />
          </BandSlot>
        ) : null;
      case 'renamed':
        return band.to === anchor ? (
          <BandSlot>
            <RenamedBand
              repo={repo}
              to={band.to}
              upstream={band.upstream}
              onClose={() => close()}
              onDeleteOld={() => {
                const old = list.remote.find((r) => r.name === band.upstream);
                if (old)
                  setBand({
                    kind: 'delete-remote',
                    anchor,
                    remote: old.remote,
                    branch: old.branch,
                    oid: old.oid,
                  });
                else close();
              }}
            />
          </BandSlot>
        ) : null;
      case 'delete': {
        if (band.name !== anchor || !branch) return null;
        const rows = localRows.map((b) => b.name);
        const next =
          rows[rows.indexOf(anchor) + 1] ??
          rows[rows.indexOf(anchor) - 1] ??
          null;
        return (
          <BandSlot>
            <DeleteBand
              repo={repo}
              branch={branch}
              merged={merged.has(branch.name)}
              onCancel={() => close()}
              onDone={() => close(next)}
              onCompare={() =>
                onCompare(targetRef(), { kind: 'local', name: branch.name })
              }
              onPublish={() => {
                setBand(null);
                pushBranch(branch.name);
              }}
            />
          </BandSlot>
        );
      }
      case 'upstream':
        return band.name === anchor && branch ? (
          <BandSlot>
            <UpstreamBand
              repo={repo}
              branch={branch}
              list={list}
              onCancel={() => close()}
              onDone={() => close()}
            />
          </BandSlot>
        ) : null;
      case 'delete-remote':
        return band.anchor === anchor ? (
          <BandSlot>
            <DeleteRemoteBand
              repo={repo}
              remote={band.remote}
              branch={band.branch}
              oid={band.oid}
              onCancel={() => close()}
              onDone={() => close()}
            />
          </BandSlot>
        ) : null;
      default:
        return null;
    }
  };

  const aheadCount = list.local.filter(
    (b) => b.upstream && !b.gone && b.ahead,
  ).length;
  const behindCount = list.local.filter(
    (b) => b.upstream && !b.gone && b.behind,
  ).length;
  const noUpstream = list.local.filter((b) => !b.upstream).length;
  const unmerged = list.local.filter((b) => !merged.has(b.name)).length;
  const fetchedAt = repo.status?.fetchedAt ?? null;

  return (
    <div ref={listRef} className="pt-5">
      <Toolbar.Root
        aria-label="Branch actions"
        className="flex flex-wrap items-center gap-2"
      >
        <Toolbar.Button asChild>
          <Button variant="primary" onClick={() => setBand({ kind: 'new' })}>
            <Plus />
            New branch
          </Button>
        </Toolbar.Button>
        {remote && (
          <Toolbar.Button asChild>
            <Button
              pending={!!fetchAction.running}
              onClick={() => !fetchAction.running && fetchAction.start(remote)}
            >
              {!fetchAction.running && <CloudDownload />}
              {fetchAction.running && fetchAction.progress
                ? `Fetching ${fetchAction.progress.percent}%`
                : `Fetch ${remote}`}
            </Button>
          </Toolbar.Button>
        )}
        {remote && (
          <Toolbar.Button asChild>
            <Button
              pending={checkRemote.isPending}
              title={`Asks ${remote} for its branches without downloading anything`}
              onClick={() =>
                !checkRemote.isPending &&
                checkRemote.mutate(remote, {
                  onSuccess: (result) => {
                    if (result.status === 'checked') setHeads(result);
                    else
                      toast({
                        tone: 'danger',
                        title: `Couldn't check ${remote}`,
                        description: result.message,
                      });
                  },
                  onError: (err) =>
                    toast({
                      tone: 'danger',
                      title: `Couldn't check ${remote}`,
                      description: ipcErrorMessage(
                        err,
                        'The remote did not answer.',
                      ),
                    }),
                })
              }
            >
              {!checkRemote.isPending && <Radar />}
              Check remote
            </Button>
          </Toolbar.Button>
        )}
        <Toolbar.Button asChild>
          <Button
            onClick={() =>
              onCompare(
                targetRef(),
                current && current.name !== targetName
                  ? { kind: 'local', name: current.name }
                  : null,
              )
            }
          >
            <GitCompare />
            Compare
          </Button>
        </Toolbar.Button>
        <span className="ml-auto text-xs text-muted">
          {fetchedAt
            ? `Remote-tracking as of the fetch ${relativeTime(fetchedAt)}`
            : remote
              ? 'Not fetched yet'
              : 'No remote'}
          {heads ? ` · ${heads.remote} checked ${relativeTime(heads.at)}` : ''}
        </span>
      </Toolbar.Root>
      {band?.kind === 'new' && (
        <div className="mt-3">
          <NewBranchBand
            repo={repo}
            list={list}
            settings={settings}
            prefs={prefs.data}
            onCancel={() => setBand(null)}
            onDone={(name, switched) => {
              setBand(null);
              setFocusName(name);
              toast({
                tone: 'success',
                title: switched
                  ? `Created and switched to ${name}`
                  : `Created ${name}`,
              });
            }}
          />
        </div>
      )}
      {heads && heads.added.length > 0 && (
        <InlineStatus
          className="mt-3"
          action={
            remote ? (
              <Button
                size="sm"
                pending={!!fetchAction.running}
                onClick={() =>
                  !fetchAction.running && fetchAction.start(remote)
                }
              >
                Fetch
              </Button>
            ) : undefined
          }
        >
          New on {heads.remote} since the fetch:{' '}
          {heads.added.slice(0, 5).join(', ')}
          {heads.added.length > 5 ? ` and ${heads.added.length - 5} more` : ''}.
          Fetch to get them.
        </InlineStatus>
      )}

      <div className="mt-4 @container">
        <SummaryStrip
          cells={[
            {
              label: 'Local',
              value: String(list.local.length),
              context: 'On this computer',
            },
            {
              label: 'Ahead',
              value: String(aheadCount),
              context: 'Have commits to push',
            },
            {
              label: 'Behind',
              value: String(behindCount),
              context: 'As of the last fetch',
            },
            {
              label: 'No upstream',
              value: String(noUpstream),
              context: 'Never published',
            },
            targetName
              ? {
                  label: `Unmerged into ${targetName}`,
                  value: String(unmerged),
                  context: `Have commits ${targetName} lacks`,
                }
              : {
                  label: 'Unmerged',
                  value: 'No base',
                  context: 'Nothing to compare against',
                  word: true,
                },
          ]}
        />
      </div>

      <div className="mt-4 flex flex-wrap items-center gap-2.5">
        <label className="field flex h-8 min-w-0 flex-[1_1_14rem] items-center gap-2 px-2.5">
          <span className="sr-only">Filter branches</span>
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Filter branches"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent font-mono text-[0.78125rem] text-ink outline-none placeholder:font-sans placeholder:text-muted"
          />
        </label>
        <Segmented
          label="Show"
          value={filter}
          onChange={setFilter}
          className="flex-wrap"
          options={[
            { value: 'all', label: 'All' },
            { value: 'local', label: 'Local' },
            { value: 'remote', label: 'Remote-tracking' },
            { value: 'diverging', label: 'Ahead or behind' },
            { value: 'no-upstream', label: 'No upstream' },
            { value: 'merged', label: 'Merged' },
            ...(staleDays > 0
              ? [{ value: 'stale' as const, label: 'Stale' }]
              : []),
          ]}
        />
      </div>

      {filter !== 'remote' && (
        <Section
          id="local-branches-heading"
          title="On this computer"
          className="mt-6"
          meta={
            auto === 'list' && targetName
              ? `Ahead and behind count commits, as of the last fetch · Mergeability into ${targetName} is checked automatically`
              : 'Ahead and behind count commits, as of the last fetch'
          }
        >
          {!list.local.length ? (
            <EmptyState
              compact
              className="border-t border-line"
              art={<BranchesArt />}
              title={
                list.current
                  ? `${list.current} has no commits yet`
                  : 'No branches yet'
              }
              action={
                <Button
                  size="sm"
                  onClick={() =>
                    navigate({
                      name: 'repository',
                      id: repo.id,
                      tab: 'changes',
                    })
                  }
                >
                  Go to Changes
                </Button>
              }
            >
              A branch needs a commit to point at, so this list fills after the
              first one.
            </EmptyState>
          ) : !localRows.length ? (
            <EmptyState
              compact
              className="border-t border-line"
              art={<NoResultsArt />}
              title="No branch matches"
              action={
                <Button
                  size="sm"
                  onClick={() => {
                    setQuery('');
                    setFilter('all');
                  }}
                >
                  Clear filter
                </Button>
              }
            >
              Clear the filter to see all{' '}
              {plural(list.local.length, 'local branch', 'local branches')}.
            </EmptyState>
          ) : (
            <ul
              aria-label="Local branches"
              className="border-t border-line"
              onKeyDown={rowKeys}
            >
              {localRows.map((b) => {
                const state = upstreamState(b);
                const locked = protectedSet.has(b.name);
                const checking =
                  auto === 'list' &&
                  listChecks.isFetching &&
                  candidates.some((c) => c.name === b.name);
                const actions = localActions(b);
                // The next step for this branch: publish it, push it, or switch to it.
                const primary =
                  !b.upstream && remote
                    ? { label: 'Publish', run: () => pushBranch(b.name) }
                    : b.ahead && !b.gone && remote
                      ? { label: 'Push', run: () => pushBranch(b.name) }
                      : !b.current && !b.otherWorktree
                        ? {
                            label: 'Switch',
                            run: () => switchTo(b.name, 'local'),
                          }
                        : null;
                return (
                  <li key={b.name}>
                    <ContextRow label={b.name} actions={actions}>
                      <div
                        className={cn(
                          'flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-2 py-2.5',
                          b.current && 'bg-accent-soft',
                        )}
                      >
                        <div className="min-w-0 flex-[1_1_18rem]">
                          <div className="flex flex-wrap items-center gap-2">
                            <button
                              type="button"
                              data-row-focus
                              data-row-name={b.name}
                              onClick={() =>
                                targetName && targetName !== b.name
                                  ? onCompare(targetRef(), {
                                      kind: 'local',
                                      name: b.name,
                                    })
                                  : undefined
                              }
                              title={
                                targetName && targetName !== b.name
                                  ? `Compare with ${targetName}`
                                  : undefined
                              }
                              className={cn(
                                'min-w-0 truncate rounded-[4px] text-left font-mono text-[0.8125rem] text-ink',
                                b.current && 'font-semibold',
                              )}
                            >
                              {b.name}
                            </button>
                            {b.current && (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-ink">
                                <Check
                                  aria-hidden
                                  className="size-3.5 text-success"
                                />
                                Current
                              </span>
                            )}
                            {locked && (
                              <span className="inline-flex items-center gap-1 text-xs font-medium text-ink">
                                <Lock
                                  aria-hidden
                                  className="size-3.5 text-muted"
                                />
                                Protected
                              </span>
                            )}
                          </div>
                          <div className="mt-0.5 truncate text-xs text-muted">
                            {[
                              b.otherWorktree
                                ? 'Checked out in another worktree'
                                : null,
                              b.upstream ?? 'No upstream',
                              b.subject || null,
                              b.at ? relativeTime(b.at) : null,
                              merged.has(b.name) &&
                              targetName &&
                              targetName !== b.name
                                ? `Merged into ${targetName}`
                                : null,
                              stale(b) ? 'Stale' : null,
                            ]
                              .filter(Boolean)
                              .join(' · ')}
                          </div>
                          {auto === 'list' && targetName && (
                            <MergeLine
                              check={checkFor(b.oid)}
                              checking={checking}
                              target={targetName}
                            />
                          )}
                        </div>
                        <span className="inline-flex items-center gap-1.5 text-[0.8125rem] font-medium whitespace-nowrap text-ink">
                          <state.icon
                            aria-hidden
                            className={cn('size-3.5', state.tone)}
                          />
                          {state.text}
                        </span>
                        {primary && (
                          <Button
                            size="sm"
                            pending={busy === b.name}
                            aria-disabled={
                              (!!busy && busy !== b.name) || undefined
                            }
                            onClick={primary.run}
                          >
                            {primary.label}
                          </Button>
                        )}
                        <Overflow label={b.name} actions={actions} />
                      </div>
                    </ContextRow>
                    {bandFor(b.name)}
                  </li>
                );
              })}
            </ul>
          )}
          {list.truncated && (
            <p className="mt-2 text-xs text-muted">
              Showing the 1,000 most recently committed branches.
            </p>
          )}
          {listChecks.isError && (
            <InlineStatus tone="danger" className="mt-2">
              {ipcErrorMessage(
                listChecks.error,
                "Git couldn't check mergeability for the list.",
              )}
            </InlineStatus>
          )}
        </Section>
      )}

      {showRemote && (
        <Section
          id="remote-branches-heading"
          title="Remote-tracking"
          meta={`Local copies of remote branches, updated by Fetch${heads ? ` · ${heads.remote} checked ${relativeTime(heads.at)}` : ''}`}
        >
          {!list.remote.length ? (
            <EmptyState
              compact
              className="border-t border-line"
              art={<RemoteArt />}
              title="No remote-tracking branches"
              action={
                remote ? (
                  <Button
                    size="sm"
                    pending={!!fetchAction.running}
                    onClick={() =>
                      !fetchAction.running && fetchAction.start(remote)
                    }
                  >
                    Fetch {remote}
                  </Button>
                ) : (
                  <Button
                    size="sm"
                    onClick={() =>
                      navigate({
                        name: 'repository',
                        id: repo.id,
                        tab: 'remotes',
                      })
                    }
                  >
                    Open Remotes
                  </Button>
                )
              }
            >
              {remote
                ? `Fetch ${remote} to see its branches here.`
                : 'This repository has no remote yet. Add one on the Remotes tab, then Fetch to see its branches here.'}
            </EmptyState>
          ) : !remoteRows.length ? (
            <EmptyState
              compact
              className="border-t border-line"
              art={<NoResultsArt />}
              title="No remote-tracking branch matches"
              action={
                <Button size="sm" onClick={() => setQuery('')}>
                  Clear filter
                </Button>
              }
            >
              Clear the filter to see all{' '}
              {plural(
                list.remote.length,
                'remote-tracking branch',
                'remote-tracking branches',
              )}
              .
            </EmptyState>
          ) : (
            <ul
              aria-label="Remote-tracking branches"
              className="border-t border-line"
              onKeyDown={rowKeys}
            >
              {remoteRows.map((b) => {
                const moved = heads?.moved.includes(b.name);
                const gone = heads?.gone.includes(b.name);
                const actions = remoteActions(b);
                return (
                  <li key={b.name}>
                    <ContextRow label={b.name} actions={actions}>
                      <div className="flex flex-wrap items-center gap-x-4 gap-y-2 border-b border-line px-2 py-2.5">
                        <div className="min-w-0 flex-[1_1_18rem]">
                          <button
                            type="button"
                            data-row-focus
                            data-row-name={b.name}
                            onClick={() =>
                              targetName && targetName !== b.name
                                ? onCompare(targetRef(), {
                                    kind: 'remote',
                                    name: b.name,
                                  })
                                : undefined
                            }
                            className="min-w-0 truncate rounded-[4px] text-left font-mono text-[0.8125rem] text-ink"
                          >
                            {b.name}
                          </button>
                          <div className="mt-0.5 truncate text-xs text-muted">
                            {b.subject || 'No message'}
                            {b.at ? ` · ${relativeTime(b.at)}` : ''}
                          </div>
                        </div>
                        {moved && (
                          <span className="inline-flex items-center gap-1.5 text-[0.8125rem] font-medium text-ink">
                            <RefreshCw
                              aria-hidden
                              className="size-3.5 text-warning"
                            />
                            Moved on {b.remote} since the fetch
                          </span>
                        )}
                        {gone && (
                          <span className="inline-flex items-center gap-1.5 text-[0.8125rem] font-medium text-ink">
                            <TriangleAlert
                              aria-hidden
                              className="size-3.5 text-warning"
                            />
                            No longer on {b.remote}
                          </span>
                        )}
                        {b.hasLocal ? (
                          <span className="text-xs text-muted">
                            Has a local branch
                          </span>
                        ) : (
                          <Button
                            size="sm"
                            pending={busy === b.name}
                            aria-disabled={
                              (!!busy && busy !== b.name) || undefined
                            }
                            onClick={() => switchTo(b.name, 'remote')}
                          >
                            Check out as {b.branch}
                          </Button>
                        )}
                        <Overflow label={b.name} actions={actions} />
                      </div>
                    </ContextRow>
                    {bandFor(b.name)}
                  </li>
                );
              })}
            </ul>
          )}
        </Section>
      )}
    </div>
  );
}

// Right-click opens the same actions the overflow menu holds.
function ContextRow({
  label,
  actions,
  children,
}: {
  label: string;
  actions: Action[][];
  children: ReactNode;
}) {
  const groups = actions.filter((group) => group.length);
  if (!groups.length) return <>{children}</>;
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{children}</ContextMenuTrigger>
      <ContextMenuContent aria-label={label}>
        {groups.map((group, index) => (
          <div key={index}>
            {index > 0 && <ContextMenuSeparator />}
            {group.map((action) => (
              <ContextMenuItem
                key={action.key}
                onSelect={action.onSelect}
                className={
                  action.danger ? 'text-danger [&_svg]:text-danger' : undefined
                }
              >
                <action.icon aria-hidden />
                {action.label}
              </ContextMenuItem>
            ))}
          </div>
        ))}
      </ContextMenuContent>
    </ContextMenu>
  );
}

export function BranchesTab({
  repo,
  width,
  compare,
  onOutcome,
}: {
  repo: RepositorySummary;
  width: number;
  compare?: {
    base: BranchRef | null;
    source: BranchRef | null;
    merge?: boolean;
  };
  onOutcome: (outcome: SwitchOutcome) => void;
}) {
  const { navigate } = useNavigation();
  const overview = useBranchOverview(repo.id, repo.statusAt);
  const { data: settings } = useSettings();
  const prefs = useRepoPreferences(repo.id);
  const padded = 'px-6 min-[1100px]:px-10';
  const open = (
    base: BranchRef | null,
    source: BranchRef | null,
    merge = false,
  ) =>
    navigate({
      name: 'repository',
      id: repo.id,
      tab: 'branches',
      compare: { base, source, merge },
    });

  let content: ReactNode;
  if (overview.isPending) content = <Loading label="Reading branches…" />;
  else if (overview.isError)
    content = (
      <EmptyState
        art={<OfflineArt />}
        title="Couldn't read the branches"
        action={
          <Button
            pending={overview.isFetching}
            onClick={() => void overview.refetch()}
          >
            Try again
          </Button>
        }
      >
        {ipcErrorMessage(overview.error, 'Git did not answer.')}
      </EmptyState>
    );
  else if (compare) {
    const method: BranchMergeMethod =
      prefs.data && prefs.data.mergeMethod !== 'global'
        ? prefs.data.mergeMethod
        : (settings?.branchMergeMethod ?? 'default');
    content = (
      <CompareWorkspace
        key={`${compare.base?.kind}:${compare.base?.name}|${compare.source?.kind}:${compare.source?.name}`}
        repo={repo}
        width={width}
        list={overview.data}
        base={compare.base}
        source={compare.source}
        settings={settings}
        auto={effectiveAuto(settings, prefs.data)}
        method={method}
        protectedNames={overview.data.protected}
        startMerge={!!compare.merge}
        onPick={(base, source) => open(base, source)}
        onBack={() =>
          navigate({ name: 'repository', id: repo.id, tab: 'branches' })
        }
      />
    );
  } else
    content = (
      <div className="mx-auto max-w-(--content-max)">
        <Overview
          repo={repo}
          list={overview.data}
          onCompare={open}
          onOutcome={onOutcome}
        />
      </div>
    );
  return (
    <div className={cn('min-h-0 flex-1 overflow-auto pb-10', padded)}>
      {content}
    </div>
  );
}
