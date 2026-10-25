import { render, screen } from '@testing-library/react';
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
import type { RepositorySummary } from '../../../shared/repos';
import { DEFAULT_SETTINGS, type Settings } from '../../../shared/settings';
import type {
  SyncActivityPage,
  SyncOperation,
  SyncOverview,
} from '../../../shared/sync';
import { DEFAULT_REPO_PREFERENCES } from '../../../shared/workspace';
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

let status: AuthStatus = { status: 'signed-out' };
let settings: Settings = DEFAULT_SETTINGS;
const never = () => new Promise<never>(() => {});
const ID = '11111111-1111-4111-8111-111111111111';
const OP = '22222222-2222-4222-8222-222222222222';

function repo(
  over: Partial<NonNullable<RepositorySummary['status']>> = {},
): RepositorySummary {
  return {
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
      headOid: 'a'.repeat(40),
      upstream: 'origin/main',
      ahead: 2,
      behind: 1,
      staged: 0,
      unstaged: 0,
      untracked: 0,
      conflicts: 0,
      operation: null,
      hasRemotes: true,
      lastCommit: null,
      fetchedAt: Date.now() - 60_000,
      ...over,
    },
    statusAt: Date.now() - 1000,
    inspectedAt: Date.now() - 1000,
    inspecting: false,
    error: null,
    remoteId: null,
    autoLink: null,
  };
}

const op = (over: Partial<SyncOperation> = {}): SyncOperation => ({
  id: OP,
  repositoryId: ID,
  repositoryName: 'desktop-git',
  kind: 'push',
  state: 'completed',
  strategy: null,
  remote: 'origin',
  branch: 'main',
  oldOid: 'b'.repeat(40),
  newOid: 'c'.repeat(40),
  code: null,
  message: null,
  server: null,
  at: Date.now() - 5000,
  ...over,
});

const overview = (over: Partial<SyncOverview> = {}): SyncOverview => ({
  branch: 'main',
  upstream: 'origin/main',
  remote: 'origin',
  state: 'diverged',
  noCommits: false,
  ahead: 2,
  behind: 1,
  changed: 0,
  fetchedAt: Date.now() - 60_000,
  pushedAt: null,
  stale: false,
  pending: null,
  recent: [],
  ...over,
});

let sync: Record<string, ReturnType<typeof vi.fn>>;
let pulls: Record<string, ReturnType<typeof vi.fn>>;

function install(list: RepositorySummary[], view: SyncOverview) {
  sync = {
    overview: vi.fn(async () => view),
    compare: vi.fn(never),
    check: vi.fn(never),
    pull: vi.fn(never),
    publish: vi.fn(never),
    setUpstream: vi.fn(never),
    checkPush: vi.fn(never),
    cancel: vi.fn(async () => undefined),
    fileDiff: vi.fn(never),
    activity: vi.fn(
      async (): Promise<SyncActivityPage> => ({
        items: [],
        total: 0,
        weeks: [],
      }),
    ),
  };
  pulls = {
    conflicts: vi.fn(never),
    conflictSides: vi.fn(never),
    overview: vi.fn(never),
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
      list: vi.fn(async () => list),
      activity: vi.fn(async () => []),
      remoteOverview: vi.fn(never),
      remoteList: vi.fn(never),
      history: vi.fn(never),
      changes: vi.fn(async () => ({ files: [], truncated: false })),
      open: vi.fn(async () => list[0]),
      refresh: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => {}),
      onProgress: vi.fn(() => () => {}),
      moveUndoState: vi.fn(async () => null),
    },
    workspace: {
      watch: vi.fn(async () => undefined),
      unwatch: vi.fn(async () => undefined),
      preferences: vi.fn(async () => DEFAULT_REPO_PREFERENCES),
      remotes: vi.fn(async () => [
        {
          name: 'origin',
          fetchUrl: 'https://example.com/desktop-git.git',
          pushUrl: null,
          hadCredentials: false,
          protocol: 'https',
        },
      ]),
      editors: vi.fn(async () => []),
      branches: vi.fn(async () => ({
        current: 'main',
        detached: false,
        headOid: 'a'.repeat(40),
        local: [],
        remote: [],
        truncated: false,
      })),
      log: vi.fn(never),
    },
    pulls,
    sync,
  } as unknown as DesktopApi;
}

const openSync = async () => {
  render(
    <Providers>
      <AppShell status={status} />
    </Providers>,
  );
  await userEvent.click(
    await screen.findByRole('button', { name: 'Open desktop-git' }),
  );
  await userEvent.click(await screen.findByRole('tab', { name: 'Sync' }));
};

beforeEach(() => {
  status = { status: 'signed-out' };
  settings = { ...DEFAULT_SETTINGS, workspaceLayout: 'centered' };
});
afterEach(() => vi.restoreAllMocks());

describe('sync tab', () => {
  it('says why a fast-forward pull cannot work, and pulls with the chosen method', async () => {
    install([repo()], overview());
    await openSync();
    expect(
      await screen.findByRole('heading', {
        name: 'main has diverged from origin/main',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByText(/Fast-forward only can't pull this/),
    ).toBeInTheDocument();
    // The header has its own Push; the tab's is the last one.
    const push = screen.getAllByRole('button', { name: /^Push 2$/ }).at(-1)!;
    expect(push).toHaveAttribute('aria-disabled', 'true');

    await userEvent.click(screen.getByRole('radio', { name: /^Merge/ }));
    const pull = screen.getByRole('button', { name: 'Pull 1 with merge' });
    await userEvent.click(pull);
    expect(sync.pull).toHaveBeenCalledWith(
      expect.objectContaining({ id: ID, strategy: 'merge' }),
    );
    expect(
      await screen.findByRole('button', { name: 'Pulling' }),
    ).toHaveAttribute('aria-busy', 'true');
  });

  it('offers Check status for a push whose result is unknown', async () => {
    install(
      [repo()],
      overview({
        state: 'ahead',
        behind: 0,
        pending: op({ state: 'unknown', code: 'OPERATION_RESULT_UNKNOWN' }),
      }),
    );
    await openSync();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Check status' }),
    );
    expect(sync.checkPush).toHaveBeenCalledWith({ id: ID, operationId: OP });
  });

  it('publishes a branch without an upstream under the name you give it', async () => {
    install(
      [repo({ upstream: null, ahead: null, behind: null })],
      overview({
        state: 'no-upstream',
        upstream: null,
        ahead: null,
        behind: null,
      }),
    );
    await openSync();
    const name = await screen.findByRole('textbox', {
      name: 'Branch name on origin',
    });
    await userEvent.clear(name);
    await userEvent.type(name, 'feature/cache');
    await userEvent.click(screen.getByRole('button', { name: 'Publish main' }));
    expect(sync.publish).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ID,
        remote: 'origin',
        branch: 'feature/cache',
      }),
    );
  });

  it('opens the conflict screen for a pull waiting on conflicts, in its own words', async () => {
    install(
      [repo()],
      overview({
        pending: op({
          kind: 'pull',
          state: 'conflict_resolution',
          remote: 'origin/main',
        }),
      }),
    );
    pulls.conflicts = vi.fn(async () => ({
      operation: 'merge',
      pullId: null,
      upstream: { ours: 'main', theirs: 'origin/main', rebase: false },
      files: [{ path: 'src/sync.ts', kind: 'both-modified', binary: false }],
      resolved: [],
    }));
    await openSync();
    expect(
      await screen.findByRole('heading', {
        name: 'Resolve conflicts to finish the pull',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Continue pull' }),
    ).toHaveAttribute('aria-disabled', 'true');
  });

  it('never offers Continue when the conflicts could not be read', async () => {
    install(
      [repo()],
      overview({ pending: op({ kind: 'pull', state: 'conflict_resolution' }) }),
    );
    pulls.conflicts = vi.fn(async () => {
      throw new Error('Git did not answer');
    });
    await openSync();
    expect(
      await screen.findByText("Couldn't read the conflicts"),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole('button', { name: /Continue/ }),
    ).not.toBeInTheDocument();
  });

  it('shows a gone upstream in the header', async () => {
    install(
      [repo({ ahead: null, behind: null })],
      overview({ state: 'gone', ahead: null, behind: null }),
    );
    await openSync();
    expect(await screen.findByText('Upstream gone')).toBeInTheDocument();
    expect(
      await screen.findByRole('heading', {
        name: "origin/main isn't on the remote",
      }),
    ).toBeInTheDocument();
  });

  it('calls an empty clone new, not gone, and offers no publish yet', async () => {
    install(
      [repo({ ahead: null, behind: null, headOid: null })],
      overview({
        state: 'no-upstream',
        noCommits: true,
        ahead: null,
        behind: null,
      }),
    );
    await openSync();
    expect(
      await screen.findByRole('heading', { name: 'main has no commits yet' }),
    ).toBeInTheDocument();
    expect(screen.queryByText('Upstream gone')).not.toBeInTheDocument();
    expect(
      screen.queryByRole('heading', { name: 'Publish or track' }),
    ).not.toBeInTheDocument();
  });
});

describe('sync activity page', () => {
  const page = async () => {
    render(
      <Providers>
        <AppShell status={status} />
      </Providers>,
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Sync activity' }),
    );
  };

  it('starts empty with one next step', async () => {
    install([repo()], overview());
    await page();
    expect(await screen.findByText('No syncs yet')).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open a repository' }),
    ).toBeInTheDocument();
  });

  it('lists syncs with what the server said and answers the chart question', async () => {
    install([repo()], overview());
    const weeks = Array.from({ length: 8 }, (_, i) => ({
      start: Date.now() - (8 - i) * 7 * 86_400_000,
      confirmed: i === 7 ? 1 : 0,
      other: 0,
    }));
    sync.activity = vi.fn(async () => ({
      items: [
        op({ server: 'confirmed' }),
        op({ id: 'x', kind: 'fetch', state: 'failed', message: 'Offline' }),
      ],
      total: 2,
      weeks,
    }));
    await page();
    expect(
      await screen.findByRole('heading', {
        name: 'Did your pushes reach the server?',
      }),
    ).toBeInTheDocument();
    expect(screen.getByText('Confirmed by server')).toBeInTheDocument();
    expect(screen.getByText('Fetch failed origin')).toBeInTheDocument();
    expect(
      screen.getByText(/1 of 1 pushes in the last 8 weeks were confirmed/),
    ).toBeInTheDocument();
  });

  it("switches to the account's pushes from every device when signed in", async () => {
    status = {
      status: 'authenticated',
      account: {
        id: 'acct-1',
        displayName: 'Test',
        email: 't@example.com',
        avatarUrl: null,
      },
      persistence: 'secure',
    } as AuthStatus;
    install([repo()], overview());
    sync.accountStats = vi.fn(async () => ({
      weeks: Array.from({ length: 8 }, (_, i) => ({
        start: Date.UTC(2026, 8, 7) + i * 7 * 86_400_000,
        confirmed: i === 7 ? 1 : 0,
        unverified: 0,
      })),
    }));
    sync.accountActivity = vi.fn(async () => ({
      events: [
        {
          operationId: OP,
          repositoryId: 'r1',
          repositoryName: 'desktop-git',
          ref: 'refs/heads/main',
          oldOid: 'b'.repeat(40),
          newOid: 'c'.repeat(40),
          result: 'confirmed',
          tip: 'd'.repeat(40),
          createdAt: Date.now() - 60_000,
        },
      ],
      nextCursor: 'next',
    }));
    await page();
    await userEvent.click(
      await screen.findByRole('radio', { name: 'Your account' }),
    );
    expect(await screen.findByText('Pushed main')).toBeInTheDocument();
    expect(
      screen.getByText(/the branch has since moved to ddddddd/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load 20 more' }));
    expect(sync.accountActivity).toHaveBeenLastCalledWith({
      cursor: 'next',
      result: 'all',
    });
  });

  it('checks the list and the chart again together from the empty account', async () => {
    status = {
      status: 'authenticated',
      account: {
        id: 'acct-1',
        displayName: 'Test',
        email: 't@example.com',
        avatarUrl: null,
      },
      persistence: 'secure',
    } as AuthStatus;
    install([repo()], overview());
    let recorded = false;
    sync.accountStats = vi.fn(async () => ({
      weeks: Array.from({ length: 8 }, (_, i) => ({
        start: Date.UTC(2026, 8, 7) + i * 7 * 86_400_000,
        confirmed: 0,
        unverified: recorded && i === 7 ? 1 : 0,
      })),
    }));
    sync.accountActivity = vi.fn(async () => ({
      events: recorded
        ? [
            {
              operationId: OP,
              repositoryId: 'r1',
              repositoryName: 'desktop-git',
              ref: 'refs/heads/main',
              oldOid: null,
              newOid: 'c'.repeat(40),
              result: 'unverified' as const,
              tip: null,
              createdAt: Date.now() - 60_000,
            },
          ]
        : [],
      nextCursor: null,
    }));
    await page();
    await userEvent.click(
      await screen.findByRole('radio', { name: 'Your account' }),
    );
    recorded = true;
    await userEvent.click(
      await screen.findByRole('button', { name: 'Check again' }),
    );
    expect(await screen.findByText('Pushed main')).toBeInTheDocument();
    expect(
      await screen.findByText(
        /0 of 1 pushes in the last 8 weeks were confirmed/,
      ),
    ).toBeInTheDocument();
  });
});
