import { render, screen, within } from '@testing-library/react';
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
import type { AuthStatus, DesktopApi } from '../../../shared/ipc';
import type {
  Comparison,
  PullDetail,
  PullRequest,
} from '../../../shared/pulls';
import type { RepositorySummary } from '../../../shared/repos';
import { DEFAULT_SETTINGS, type Settings } from '../../../shared/settings';
import { DEFAULT_REPO_PREFERENCES } from '../../../shared/workspace';
import { Providers } from '../../app/providers';
import { AppShell } from '../shell/app-shell';
import { idleUpdates } from '../../test/updates-stub';

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
let settings: Settings = DEFAULT_SETTINGS;
const never = () => new Promise<never>(() => {});
const ID = '11111111-1111-4111-8111-111111111111';
const PR = '22222222-2222-4222-8222-222222222222';
const SRC = 'a'.repeat(40);
const TGT = 'b'.repeat(40);
const BASE = 'c'.repeat(40);

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
    headOid: TGT,
    upstream: null,
    ahead: null,
    behind: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
    operation: null,
    hasRemotes: false,
    lastCommit: null,
    fetchedAt: null,
  },
  statusAt: Date.now() - 1000,
  inspectedAt: Date.now() - 1000,
  inspecting: false,
  error: null,
  remoteId: null,
  autoLink: null,
};

const comparison: Comparison = {
  sourceOid: SRC,
  targetOid: TGT,
  mergeBaseOid: BASE,
  commits: [
    {
      oid: SRC,
      parents: [BASE],
      author: 'Test',
      email: 't@example.com',
      at: Date.now(),
      subject: 'Improve search',
      refs: [],
    },
  ],
  commitsTruncated: false,
  files: [
    {
      path: 'src/search.ts',
      oldPath: null,
      status: 'modified',
      added: 1,
      removed: 1,
      binary: false,
    },
  ],
  filesTruncated: false,
  added: 1,
  removed: 1,
};

const pull = (overrides: Partial<PullRequest> = {}): PullRequest => ({
  id: PR,
  number: 1,
  store: 'local',
  repositoryId: ID,
  title: 'Improve search',
  description: 'Search across repositories.',
  sourceRef: 'feature',
  targetRef: 'main',
  status: 'open',
  isDraft: false,
  author: { accountId: null, name: 'Test', avatarUrl: null },
  createdAt: Date.now() - 3_600_000,
  updatedAt: Date.now() - 60_000,
  closedAt: null,
  mergedAt: null,
  mergeCommitOid: null,
  latest: {
    version: 1,
    sourceOid: SRC,
    targetOid: TGT,
    mergeBaseOid: BASE,
    mergeability: 'mergeable',
    reason: null,
    conflicts: [],
    checkedAt: Date.now() - 60_000,
  },
  comments: 0,
  unresolved: 0,
  review: null,
  ...overrides,
});

const detail = (overrides: Partial<PullDetail> = {}): PullDetail => ({
  pull: pull(),
  comparison,
  problem: null,
  changedSinceReview: false,
  mergeOperation: null,
  ...overrides,
});

let pulls: Record<string, ReturnType<typeof vi.fn>>;

function install(list: PullRequest[]) {
  pulls = {
    list: vi.fn(async () => ({
      store: 'local',
      pulls: list,
      nextCursor: null,
      counts: { open: list.length, merged: 0, closed: 0 },
    })),
    get: vi.fn(async () => detail()),
    compare: vi.fn(async () => ({ status: 'ok', comparison })),
    create: vi.fn(async () => pull()),
    comments: vi.fn(async () => []),
    reviews: vi.fn(async () => []),
    activity: vi.fn(async () => ({ events: [], nextCursor: null })),
    viewed: vi.fn(async () => []),
    setViewed: vi.fn(async () => []),
    conflicts: vi.fn(async () => ({
      operation: null,
      pullId: null,
      files: [],
      resolved: [],
    })),
    merge: vi.fn(never),
    addComment: vi.fn(never),
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
      hunks: [
        {
          header: '@@ -1,3 +1,3 @@',
          oldStart: 1,
          newStart: 1,
          lines: [
            {
              kind: 'context',
              old: 1,
              new: 1,
              text: 'export function search(q) {',
            },
            { kind: 'del', old: 2, new: null, text: '  return q.trim();' },
            { kind: 'add', old: null, new: 2, text: '  return normalize(q);' },
            { kind: 'context', old: 3, new: 3, text: '}' },
          ],
        },
      ],
    })),
    stats: vi.fn(never),
  };
  window.desktop = {
    updates: idleUpdates(),
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
      changes: vi.fn(async () => ({ files: [], truncated: false, total: 0 })),
      open: vi.fn(async () => repo),
      refresh: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => {}),
      onProgress: vi.fn(() => () => {}),
    },
    workspace: {
      watch: vi.fn(async () => undefined),
      unwatch: vi.fn(async () => undefined),
      preferences: vi.fn(async () => DEFAULT_REPO_PREFERENCES),
      remotes: vi.fn(async () => []),
      editors: vi.fn(async () => []),
      branches: vi.fn(async () => ({
        current: 'main',
        detached: false,
        headOid: TGT,
        local: ['main', 'feature'].map((name) => ({
          name,
          oid: name === 'main' ? TGT : SRC,
          upstream: null,
          ahead: null,
          behind: null,
          gone: false,
          current: name === 'main',
          otherWorktree: false,
          at: Date.now(),
          subject: name,
        })),
        remote: [],
        truncated: false,
      })),
    },
    pulls,
  } as unknown as DesktopApi;
}

async function openPullsTab() {
  render(
    <Providers>
      <AppShell status={status} />
    </Providers>,
  );
  await userEvent.click(
    await screen.findByRole('button', { name: 'Open desktop-git' }),
  );
  await userEvent.click(
    await screen.findByRole('tab', { name: /Pull requests/ }),
  );
}

beforeEach(() => {
  settings = {
    ...DEFAULT_SETTINGS,
    pullRequestsLayout: 'centered',
    workspaceLayout: 'centered',
  };
});
afterEach(() => vi.restoreAllMocks());

describe('pull requests', () => {
  it('starts with an empty state, previews the comparison, and creates one', async () => {
    install([]);
    await openPullsTab();
    expect(await screen.findByText('No pull requests yet')).toBeInTheDocument();
    await userEvent.click(
      screen.getAllByRole('button', { name: 'New pull request' })[0]!,
    );
    expect(
      await screen.findByText(/1 commit, 1 file, \+1 −1/),
    ).toBeInTheDocument();
    expect(pulls.compare).toHaveBeenCalledWith({
      repoId: ID,
      source: 'feature',
      target: 'main',
    });
    await userEvent.click(
      screen.getByRole('button', { name: 'Create pull request' }),
    );
    expect(pulls.create).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: ID,
        title: 'Improve search',
        source: 'feature',
        target: 'main',
        draft: false,
      }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'Improve search' }),
    ).toBeInTheDocument();
  });

  it('asks before merging and keeps the button focusable while it runs', async () => {
    install([pull()]);
    await openPullsTab();
    await userEvent.click(
      await screen.findByRole('button', { name: /Improve search/ }),
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Merge' }));
    await userEvent.click(
      await screen.findByRole('button', { name: 'Merge pull request' }),
    );
    const band = screen.getByRole('alert');
    const merge = within(band).getByRole('button', { name: 'Merge' });
    await userEvent.click(merge);
    expect(pulls.merge).toHaveBeenCalledWith(
      expect.objectContaining({
        repoId: ID,
        id: PR,
        strategy: 'default',
        sourceOid: SRC,
        targetOid: TGT,
        push: false,
      }),
    );
    expect(merge).toHaveAttribute('aria-busy', 'true');
    expect(merge).not.toBeDisabled();
  });

  it('comments on a line of the diff from its line number', async () => {
    install([pull()]);
    await openPullsTab();
    await userEvent.click(
      await screen.findByRole('button', { name: /Improve search/ }),
    );
    await userEvent.click(
      await screen.findByRole('tab', { name: /Files changed/ }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Comment on line 2' }),
    );
    await userEvent.type(
      screen.getByRole('textbox', { name: 'Comment on line 2' }),
      'Is normalize safe?',
    );
    await userEvent.click(screen.getByRole('button', { name: 'Add comment' }));
    expect(pulls.addComment).toHaveBeenCalledWith({
      repoId: ID,
      id: PR,
      body: 'Is normalize safe?',
      parentId: null,
      line: { path: 'src/search.ts', side: 'new', line: 2 },
    });
  });

  it('resolves conflicts file by file and keeps Continue unavailable until Git has none left', async () => {
    install([pull()]);
    pulls.conflicts = vi.fn(async () => ({
      operation: 'merge',
      pullId: PR,
      files: [{ path: 'src/search.ts', kind: 'both-modified', binary: false }],
      resolved: [],
    }));
    pulls.conflictSides = vi.fn(async () => ({
      path: 'src/search.ts',
      binary: false,
      tooLarge: false,
      base: 'base line\n',
      target: 'target line\n',
      source: 'source line\n',
      merged:
        '<<<<<<< HEAD\ntarget line\n=======\nsource line\n>>>>>>> feature\n',
      markers: 3,
    }));
    pulls.resolveConflict = vi.fn(never);
    await openPullsTab();
    await userEvent.click(
      await screen.findByRole('button', { name: /Improve search/ }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Resolve conflicts' }),
    );
    expect(
      await screen.findByRole('heading', { name: 'Resolve merge conflicts' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Continue merge' }),
    ).toHaveAttribute('aria-disabled', 'true');
    expect(
      screen.getByRole('button', { name: 'Mark resolved' }),
    ).toHaveAttribute('aria-disabled', 'true');
    // The common ancestor is one click away, and taking a side says it keeps a copy first.
    expect(screen.queryByText('base line')).not.toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Base, the common ancestor' }),
    );
    expect(await screen.findByText('base line')).toBeInTheDocument();
    expect(
      screen.getByText(/A copy of it is saved in Discarded changes first/),
    ).toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Use source version' }),
    );
    expect(pulls.resolveConflict).toHaveBeenCalledWith({
      repoId: ID,
      path: 'src/search.ts',
      take: 'source',
    });
  });
});
