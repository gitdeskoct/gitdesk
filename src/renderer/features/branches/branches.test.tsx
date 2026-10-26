import { render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import {
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import type { BranchOverview } from '../../../shared/branches';
import type { AuthStatus, DesktopApi } from '../../../shared/ipc';
import type { Comparison } from '../../../shared/pulls';
import type { RepositorySummary } from '../../../shared/repos';
import { DEFAULT_SETTINGS, type Settings } from '../../../shared/settings';
import {
  DEFAULT_REPO_PREFERENCES,
  type LocalBranch,
  type RepoPreferences,
} from '../../../shared/workspace';
import { Providers } from '../../app/providers';
import { AppShell } from '../shell/app-shell';

vi.mock('../repository/highlight', async (original) => ({
  ...(await original<typeof import('../repository/highlight')>()),
  tokenizeLines: async () => null,
}));

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
  Element.prototype.hasPointerCapture ??= () => false;
  Element.prototype.releasePointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

const status: AuthStatus = { status: 'signed-out' };
const never = () => new Promise<never>(() => {});
const ID = '11111111-1111-4111-8111-111111111111';
const MAIN = 'a'.repeat(40);
const FEATURE = 'b'.repeat(40);
const WIP = 'c'.repeat(40);
const BASE = 'd'.repeat(40);

const repo: RepositorySummary = {
  id: ID,
  name: 'desktop-git',
  description: null,
  displayPath: '~/Projects/desktop-git',
  pinned: false,
  addedAt: Date.now() - 60_000,
  lastOpenedAt: Date.now() - 60_000,
  availability: 'available',
  status: {
    branch: 'main',
    detached: false,
    headOid: MAIN,
    upstream: 'origin/main',
    ahead: 0,
    behind: 0,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
    operation: null,
    hasRemotes: true,
    lastCommit: null,
    fetchedAt: Date.now() - 60_000,
  },
  statusAt: Date.now() - 1000,
  inspectedAt: Date.now() - 1000,
  inspecting: false,
  error: null,
  remoteId: null,
  autoLink: null,
};

const branch = (
  over: Partial<LocalBranch> & { name: string; oid: string },
): LocalBranch => ({
  upstream: null,
  ahead: null,
  behind: null,
  gone: false,
  current: false,
  otherWorktree: false,
  at: Date.now() - 60_000,
  subject: `Work on ${over.name}`,
  ...over,
});

const overview = (): BranchOverview => ({
  current: 'main',
  detached: false,
  headOid: MAIN,
  local: [
    branch({
      name: 'main',
      oid: MAIN,
      current: true,
      upstream: 'origin/main',
      ahead: 0,
      behind: 0,
    }),
    branch({
      name: 'feature',
      oid: FEATURE,
      upstream: 'origin/feature',
      ahead: 2,
      behind: 1,
    }),
    branch({ name: 'wip', oid: WIP }),
  ],
  remote: [
    {
      name: 'origin/main',
      remote: 'origin',
      branch: 'main',
      oid: MAIN,
      at: Date.now(),
      subject: 'Main',
      hasLocal: true,
    },
    {
      name: 'origin/feature',
      remote: 'origin',
      branch: 'feature',
      oid: 'e'.repeat(40),
      at: Date.now(),
      subject: 'Feature',
      hasLocal: true,
    },
  ],
  truncated: false,
  target: { name: 'main', oid: MAIN, source: 'remote-head' },
  merged: ['main'],
  protected: ['main'],
});

const comparison: Comparison = {
  sourceOid: FEATURE,
  targetOid: MAIN,
  mergeBaseOid: BASE,
  commits: [
    {
      oid: FEATURE,
      parents: [BASE],
      author: 'Test',
      email: 't@example.com',
      at: Date.now(),
      subject: 'Add search indexing',
      refs: [],
    },
  ],
  commitsTruncated: false,
  files: [
    {
      path: 'src/search.ts',
      oldPath: null,
      status: 'modified',
      added: 3,
      removed: 1,
      binary: false,
    },
  ],
  filesTruncated: false,
  added: 3,
  removed: 1,
};

let settings: Settings;
let prefs: RepoPreferences;
let branches: Record<string, ReturnType<typeof vi.fn>>;

function install() {
  branches = {
    overview: vi.fn(async () => overview()),
    listMergeability: vi.fn(async ({ sourceOids }: { sourceOids: string[] }) =>
      sourceOids.map((sourceOid) => ({
        targetOid: MAIN,
        sourceOid,
        mergeability: sourceOid === WIP ? 'conflicts' : 'mergeable',
        reason: null,
        conflicts: sourceOid === WIP ? ['src/a.ts'] : [],
        checkedAt: Date.now(),
      })),
    ),
    mergeability: vi.fn(async () => ({
      targetOid: MAIN,
      sourceOid: FEATURE,
      mergeability: 'mergeable',
      reason: null,
      conflicts: [],
      checkedAt: Date.now(),
    })),
    compare: vi.fn(async () => ({
      status: 'ok',
      base: { name: 'main', oid: MAIN, kind: 'local' },
      source: { name: 'feature', oid: FEATURE, kind: 'local' },
      comparison,
      behind: 1,
      capturedAt: Date.now(),
    })),
    fileDiff: vi.fn(async () => ({
      status: 'text',
      path: 'src/search.ts',
      oldPath: null,
      added: 1,
      removed: 1,
      truncated: false,
      newFile: false,
      deleted: false,
      modeChange: null,
      token: null,
      hunks: [
        {
          header: '@@ -1,1 +1,1 @@',
          oldStart: 1,
          newStart: 1,
          lines: [
            {
              kind: 'del',
              old: 1,
              new: null,
              text: 'const index = createIndex();',
            },
            {
              kind: 'add',
              old: null,
              new: 1,
              text: 'const index = createSearchIndex();',
            },
          ],
        },
      ],
    })),
    create: vi.fn(async ({ name }: { name: string }) => ({
      status: 'done',
      branch: name,
      switched: true,
      upstream: null,
    })),
    remove: vi.fn(async ({ force }: { force: boolean }) =>
      force
        ? { status: 'done', branch: 'wip', switched: false, upstream: null }
        : {
            status: 'not-merged',
            total: 1,
            upstream: null,
            commits: [
              {
                oid: WIP,
                parents: [],
                author: 'Test',
                email: 't@example.com',
                at: Date.now(),
                subject: 'Half done',
                refs: [],
              },
            ],
          },
    ),
    deleteRemote: vi.fn(async () => ({
      status: 'deleted',
      remote: 'origin',
      branch: 'feature',
    })),
    merge: vi.fn(never),
    checkRemote: vi.fn(never),
  };
  window.desktop = {
    platform: 'win32',
    app: {
      getInfo: vi.fn(never),
      onNotice: vi.fn(() => () => {}),
      onOpenRepository: vi.fn(() => () => {}),
    },
    window: { command: vi.fn() },
    auth: {
      getStatus: vi.fn(async () => status),
      onStatusChanged: vi.fn(() => () => {}),
    },
    settings: {
      get: vi.fn(async () => settings),
      update: vi.fn(async (p) => ({ ...settings, ...p })),
    },
    git: { getIdentity: vi.fn(never) },
    repos: {
      list: vi.fn(async () => [repo]),
      activity: vi.fn(async () => []),
      remoteOverview: vi.fn(never),
      remoteList: vi.fn(never),
      history: vi.fn(never),
      changes: vi.fn(async () => ({ files: [], truncated: false })),
      open: vi.fn(async () => repo),
      refresh: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => {}),
      onProgress: vi.fn(() => () => {}),
    },
    workspace: {
      watch: vi.fn(async () => undefined),
      unwatch: vi.fn(async () => undefined),
      preferences: vi.fn(async () => prefs),
      remotes: vi.fn(async () => [
        {
          name: 'origin',
          fetchUrl: 'https://example.com/a.git',
          pushUrl: null,
          hadCredentials: false,
          protocol: 'https',
        },
      ]),
      editors: vi.fn(async () => []),
      branches: vi.fn(async () => overview()),
      switchBranch: vi.fn(never),
    },
    sync: { overview: vi.fn(never) },
    pulls: {
      conflicts: vi.fn(async () => ({
        operation: null,
        pullId: null,
        upstream: null,
        branchMerge: null,
        files: [],
        resolved: [],
        external: null,
      })),
    },
    branches,
  } as unknown as DesktopApi;
}

async function openBranches() {
  render(
    <Providers>
      <AppShell status={status} />
    </Providers>,
  );
  await userEvent.click(
    await screen.findByRole('button', { name: 'Open desktop-git' }),
  );
  await userEvent.click(await screen.findByRole('tab', { name: 'Branches' }));
  return screen.findByRole('list', { name: 'Local branches' });
}

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS, workspaceLayout: 'centered' };
  prefs = { ...DEFAULT_REPO_PREFERENCES, protectedBranches: ['main'] };
  install();
});
afterEach(() => vi.restoreAllMocks());

describe('branch overview', () => {
  it('shows each relationship in words and checks unmerged branches automatically', async () => {
    const list = await openBranches();
    const feature = within(list)
      .getByRole('button', { name: 'feature' })
      .closest('li')!;
    expect(
      within(feature).getByText('Diverged · ↑ 2 · ↓ 1'),
    ).toBeInTheDocument();
    const wip = within(list)
      .getByRole('button', { name: 'wip' })
      .closest('li')!;
    expect(within(wip).getByText('No upstream')).toBeInTheDocument();
    expect(
      await within(wip).findByText('Conflicts with main in 1 file'),
    ).toBeInTheDocument();
    expect(
      within(feature).getByText('Merges cleanly into main'),
    ).toBeInTheDocument();
    const main = within(list)
      .getByRole('button', { name: 'main' })
      .closest('li')!;
    expect(within(main).getByText('Protected')).toBeInTheDocument();
    expect(branches.listMergeability).toHaveBeenCalledWith({
      id: ID,
      targetOid: MAIN,
      sourceOids: [FEATURE, WIP],
    });
    expect(screen.getByText('Unmerged into main')).toBeInTheDocument();
  });

  it("doesn't check the list when automatic checks are off for this repository", async () => {
    prefs = { ...prefs, autoMergeability: 'off' };
    await openBranches();
    expect(branches.listMergeability).not.toHaveBeenCalled();
  });

  it('creates a branch from the band with the settings as defaults', async () => {
    await openBranches();
    await userEvent.click(screen.getByRole('button', { name: 'New branch' }));
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Name' }),
      'feature/search',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Create branch' }),
    );
    expect(branches.create).toHaveBeenCalledWith({
      id: ID,
      name: 'feature/search',
      start: { kind: 'head' },
      switchTo: true,
      track: 'git',
    });
  });

  it('shows the filter empty state with one action', async () => {
    await openBranches();
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Filter branches' }),
      'nothing-like-this',
    );
    expect(await screen.findByText('No branch matches')).toBeInTheDocument();
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Clear filter' })[0]!,
    );
    expect(
      await screen.findByRole('button', { name: 'wip' }),
    ).toBeInTheDocument();
  });
});

describe('deleting', () => {
  it('lists the commits Git kept and deletes anyway only once the name is typed', async () => {
    const list = await openBranches();
    const wip = within(list)
      .getByRole('button', { name: 'wip' })
      .closest('li')!;
    await userEvent.click(
      within(wip).getByRole('button', { name: 'More for wip' }),
    );
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Delete on this computer…' }),
    );
    await userEvent.click(within(wip).getByRole('button', { name: 'Delete' }));
    expect(
      await within(wip).findByText('Half done', { exact: false }),
    ).toBeInTheDocument();
    const anyway = within(wip).getByRole('button', { name: 'Delete anyway' });
    expect(anyway).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(anyway);
    expect(branches.remove).toHaveBeenCalledTimes(1);
    await userEvent.type(
      within(wip).getByRole('textbox', { name: /Type wip/ }),
      'wip',
    );
    await userEvent.click(anyway);
    expect(branches.remove).toHaveBeenLastCalledWith({
      id: ID,
      name: 'wip',
      force: true,
      typedName: 'wip',
    });
  });

  it('never offers rename or delete for a protected branch', async () => {
    const list = await openBranches();
    const main = within(list)
      .getByRole('button', { name: 'main' })
      .closest('li')!;
    await userEvent.click(
      within(main).getByRole('button', { name: 'More for main' }),
    );
    const menu = await screen.findByRole('menu');
    expect(within(menu).queryByRole('menuitem', { name: /Rename/ })).toBeNull();
    expect(within(menu).queryByRole('menuitem', { name: /Delete/ })).toBeNull();
  });

  it('deletes on the remote only with the name typed, pinned to the commit seen', async () => {
    const list = await openBranches();
    const feature = within(list)
      .getByRole('button', { name: 'feature' })
      .closest('li')!;
    await userEvent.click(
      within(feature).getByRole('button', { name: 'More for feature' }),
    );
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Delete on origin…' }),
    );
    await userEvent.type(
      within(feature).getByRole('textbox', { name: /Type feature/ }),
      'feature',
    );
    await userEvent.click(
      within(feature).getByRole('button', { name: 'Delete on origin' }),
    );
    expect(branches.deleteRemote).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ID,
        remote: 'origin',
        branch: 'feature',
        expectedOid: 'e'.repeat(40),
        typedName: 'feature',
      }),
    );
  });
});

describe('compare and merge', () => {
  it('opens a comparison, checks it automatically and merges the pinned commits', async () => {
    const list = await openBranches();
    await userEvent.click(
      within(list).getByRole('button', { name: 'feature' }),
    );
    expect(await screen.findByText('Add search indexing')).toBeInTheDocument();
    expect(
      await screen.findByText(/Git found no conflicts/),
    ).toBeInTheDocument();
    expect(branches.mergeability).toHaveBeenCalledWith({
      id: ID,
      targetOid: MAIN,
      sourceOid: FEATURE,
    });
    // The diff is Git's, between the two captured commits; word highlights split its text.
    await waitFor(() =>
      expect(branches.fileDiff).toHaveBeenCalledWith(
        expect.objectContaining({
          id: ID,
          baseOid: MAIN,
          sourceOid: FEATURE,
          path: 'src/search.ts',
        }),
      ),
    );
    expect(
      await screen.findByRole('toolbar', { name: 'Diff' }),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Merge into main…' }),
    );
    const merge = screen.getByRole('button', { name: 'Merge' });
    // main is protected: the merge waits for its own tick.
    expect(merge).toHaveAttribute('aria-disabled', 'true');
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Merge into protected main' }),
    );
    await userEvent.click(merge);
    await waitFor(() =>
      expect(branches.merge).toHaveBeenCalledWith(
        expect.objectContaining({
          id: ID,
          target: 'main',
          source: { kind: 'local', name: 'feature' },
          targetOid: MAIN,
          sourceOid: FEATURE,
          method: 'default',
          push: false,
          confirmProtected: true,
        }),
      ),
    );
  });

  it('waits for Check now when automatic checks are off', async () => {
    prefs = { ...prefs, autoMergeability: 'off' };
    const list = await openBranches();
    await userEvent.click(
      within(list).getByRole('button', { name: 'feature' }),
    );
    expect(
      await screen.findByText(/Automatic checks are off/),
    ).toBeInTheDocument();
    expect(branches.mergeability).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole('button', { name: 'Check now' }));
    await waitFor(() => expect(branches.mergeability).toHaveBeenCalled());
  });

  // The merge moves main onto the source, so the comparison turns into "nothing to compare" and
  // the merge panel unmounts before the refetch ends; the result must still be shown.
  it('shows the merge result after the comparison it came from goes away', async () => {
    prefs = { ...prefs, protectedBranches: [] };
    let merged = false;
    branches.overview = vi.fn(async () => {
      const view = overview();
      if (merged) view.local[0]!.oid = FEATURE;
      return { ...view, protected: [] };
    });
    branches.compare = vi.fn(async () =>
      merged
        ? {
            status: 'problem',
            problem: 'same-commit',
            base: 'main',
            source: 'feature',
          }
        : {
            status: 'ok',
            base: { name: 'main', oid: MAIN, kind: 'local' },
            source: { name: 'feature', oid: FEATURE, kind: 'local' },
            comparison,
            behind: 0,
            capturedAt: Date.now(),
          },
    );
    branches.merge = vi.fn(async () => {
      merged = true;
      repo.statusAt = Date.now();
      return {
        status: 'merged',
        fastForward: true,
        push: 'skipped',
        pushMessage: null,
        operation: {
          id: 'op',
          pullId: null,
          kind: 'branch-merge',
          state: 'completed',
          strategy: 'default',
          sourceOid: FEATURE,
          targetOid: MAIN,
          resultOid: FEATURE,
          message: null,
          updatedAt: Date.now(),
        },
      };
    });
    const list = await openBranches();
    await userEvent.click(
      within(list).getByRole('button', { name: 'feature' }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Merge into main…' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: /^Merge$/ }),
    );
    expect(await screen.findByText(/Git fast-forwarded/)).toBeInTheDocument();
  });
});
