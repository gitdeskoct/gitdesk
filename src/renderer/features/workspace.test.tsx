import {
  cleanup as cleanupRender,
  render,
  screen,
  within,
} from '@testing-library/react';
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
import type { AuthStatus, DesktopApi } from '../../shared/ipc';
import type {
  RemoteOverview,
  RemoteRepository,
  RepositoryHistory,
  RepositorySummary,
} from '../../shared/repos';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import {
  DEFAULT_REPO_PREFERENCES,
  type RepositoryAnalytics,
} from '../../shared/workspace';
import { Providers } from '../app/providers';
import { AppShell } from './shell/app-shell';

// Radix menus measure and capture pointers; jsdom has none of that.
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

const signedOutStatus: AuthStatus = { status: 'signed-out' };
let status: AuthStatus = signedOutStatus;
let settings: Settings = DEFAULT_SETTINGS;
const never = () => new Promise<never>(() => {});

function repo(overrides: Partial<RepositorySummary> = {}): RepositorySummary {
  return {
    id: '11111111-1111-4111-8111-111111111111',
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
      ahead: 0,
      behind: 0,
      staged: 0,
      unstaged: 2,
      untracked: 0,
      conflicts: 0,
      operation: null,
      hasRemotes: true,
      lastCommit: {
        oid: 'a'.repeat(40),
        at: Date.now() - 120_000,
        subject: 'First',
      },
    },
    statusAt: Date.now() - 30_000,
    inspectedAt: Date.now() - 30_000,
    inspecting: false,
    error: null,
    remoteId: null,
    ...overrides,
  };
}

const signedOut: RemoteOverview = {
  state: 'signed-out',
  total: null,
  recent: [],
  activity: [],
  fetchedAt: null,
  error: null,
  nextRefreshAt: null,
  requestsToday: 0,
};

let repos: Record<string, ReturnType<typeof vi.fn>>;
let workspace: Record<string, ReturnType<typeof vi.fn>>;

const emptyAnalytics = (
  overrides: Partial<RepositoryAnalytics> = {},
): RepositoryAnalytics => ({
  branch: 'main',
  headOid: 'a'.repeat(40),
  range: '12w',
  since: Date.now() - 84 * 86_400_000,
  totalCommits: 0,
  commits: 0,
  activeDays: 0,
  added: 0,
  removed: 0,
  filesTouched: 0,
  bucket: 'week',
  buckets: [],
  heat: Array.from({ length: 7 }, () => Array.from({ length: 24 }, () => 0)),
  topFiles: [],
  authors: [],
  truncated: false,
  skippedLarge: [],
  ...overrides,
});

function install(list: () => Promise<RepositorySummary[]>) {
  repos = {
    history: vi.fn(async () => noHistory),
    remoteList: vi.fn(async () => ({ repositories: [], nextCursor: null })),
    list: vi.fn(list),
    activity: vi.fn(async () => []),
    remoteOverview: vi.fn(async () => signedOut),
    changes: vi.fn(async () => ({ files: [], truncated: false })),
    open: vi.fn(async (id: string) => ({ ...repo(), id })),
    pin: vi.fn(never),
    refresh: vi.fn(async () => undefined),
    onChanged: vi.fn(() => () => {}),
    onProgress: vi.fn(() => () => {}),
  };
  workspace = {
    watch: vi.fn(async () => undefined),
    unwatch: vi.fn(async () => undefined),
    preferences: vi.fn(async () => DEFAULT_REPO_PREFERENCES),
    remotes: vi.fn(async () => []),
    editors: vi.fn(async () => []),
    branches: vi.fn(async () => ({
      current: 'main',
      detached: false,
      headOid: 'a'.repeat(40),
      local: [],
      remote: [],
      truncated: false,
    })),
    analytics: vi.fn(async () => emptyAnalytics()),
    log: vi.fn(async () => ({ snapshot: null, commits: [], nextSkip: null })),
    diff: vi.fn(never),
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
    settings: { get: vi.fn(async () => settings), update: vi.fn() },
    git: {
      getIdentity: vi.fn(async () => ({
        available: true,
        name: 'Test',
        email: 'test@example.com',
        defaultBranch: 'main',
        autocrlf: null,
      })),
    },
    repos,
    workspace,
  } as unknown as DesktopApi;
}

const renderApp = () =>
  render(
    <Providers>
      <AppShell status={status} />
    </Providers>,
  );

const noHistory: RepositoryHistory = {
  branch: 'main',
  commitCount: 0,
  localBranches: 1,
  remoteBranches: 0,
  weeks: [],
  weeksTruncated: false,
  recent: [],
};

describe('workspace', () => {
  beforeEach(() => {
    status = signedOutStatus;
    settings = DEFAULT_SETTINGS;
    install(async () => [repo()]);
  });

  it('opens a repository without crashing the window', async () => {
    renderApp();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open desktop-git' }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'desktop-git' }),
    ).toBeInTheDocument();
    expect(repos.open).toHaveBeenCalledWith(repo().id);
    expect(screen.getByRole('tab', { name: /Changes/ })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Waits on the repository list, then the change list; under a full parallel run that can pass 3 s.
    expect(
      await screen.findByText('Working tree is clean', {}, { timeout: 10_000 }),
    ).toBeInTheDocument();
    expect(workspace.watch).toHaveBeenCalledWith(repo().id);
  });

  it('routes the sidebar Repositories item to the real page', async () => {
    renderApp();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Repositories' }),
    );
    expect(await screen.findByRole('table')).toBeInTheDocument();
  });

  it('shows a load error as an error, never as the first-run screen', async () => {
    install(async () => {
      throw new Error(
        "Error invoking remote method 'repos:list': Error: Disk is busy.",
      );
    });
    renderApp();
    expect(
      await screen.findByText("Couldn't load your repositories"),
    ).toBeInTheDocument();
    expect(
      screen.queryByText('Add your first repository'),
    ).not.toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument();
  });

  it('opens Repositories already filtered from a Home statistic', async () => {
    install(async () => [
      repo(),
      repo({
        id: '22222222-2222-4222-8222-222222222222',
        name: 'clean-one',
        status: { ...repo().status!, unstaged: 0 },
      }),
    ]);
    renderApp();
    await userEvent.click(
      await screen.findByRole('button', { name: /with changes/i }),
    );
    const table = await screen.findByRole('table');
    expect(within(table).getByText('desktop-git')).toBeInTheDocument();
    expect(within(table).queryByText('clean-one')).not.toBeInTheDocument();
    expect(screen.getByRole('radio', { name: /changed 1/i })).toBeChecked();
  });

  it('shows a pending menu action on the row after the menu closes', async () => {
    renderApp();
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'More actions for desktop-git',
      }),
    );
    await userEvent.click(
      await screen.findByRole('menuitem', { name: 'Pin to top' }),
    );
    expect(await screen.findByText('Pinning…')).toBeInTheDocument();
  });

  it('reports a partial bulk failure instead of stopping silently', async () => {
    install(async () => [
      repo(),
      repo({ id: '22222222-2222-4222-8222-222222222222', name: 'second' }),
    ]);
    repos.refresh = vi.fn(async (id: string) => {
      if (id === '22222222-2222-4222-8222-222222222222')
        throw new Error(
          "Error invoking remote method 'repos:refresh': Error: Git took too long to answer.",
        );
    });
    renderApp();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Repositories' }),
    );
    await userEvent.click(
      await screen.findByRole('checkbox', { name: 'Select all shown' }),
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Refresh status' }),
    );
    expect(await screen.findByText('1 of 2 checked')).toBeInTheDocument();
    // Radix also copies a toast's text into its screen-reader announcer, so it can appear twice.
    expect(
      screen.getAllByText(/second: Git took too long to answer/).length,
    ).toBeGreaterThan(0);
  });
});

describe('home sections', () => {
  beforeEach(() => {
    status = signedOutStatus;
    settings = DEFAULT_SETTINGS;
  });

  const many = Array.from({ length: 9 }, (_, i) =>
    repo({
      id: `00000000-0000-4000-8000-00000000000${i}`,
      name: `repo-${i}`,
      lastOpenedAt: Date.now() - i * 1000,
    }),
  );

  it('pages Needs attention six at a time', async () => {
    install(async () => many);
    renderApp();
    const pager = await screen.findByRole('navigation', {
      name: 'Needs attention pages',
    });
    expect(within(pager).getByText('1–6 of 9')).toBeInTheDocument();
    await userEvent.click(
      within(pager).getByRole('button', { name: 'Next page' }),
    );
    expect(within(pager).getByText('7–9 of 9')).toBeInTheDocument();
    expect(
      within(pager).getByRole('button', { name: 'Page 2' }),
    ).toHaveAttribute('aria-current', 'page');
  });

  it('leaves opens out of Recent activity unless the setting asks for them', async () => {
    install(async () => [repo()]);
    repos.activity = vi.fn(async () => [
      {
        id: 1,
        repositoryId: repo().id,
        repositoryName: 'desktop-git',
        type: 'opened',
        at: Date.now() - 5_000,
        detail: null,
      },
      {
        id: 2,
        repositoryId: repo().id,
        repositoryName: 'desktop-git',
        type: 'commit',
        at: Date.now() - 9_000,
        detail: 'Fix it',
      },
    ]);
    renderApp();
    expect(await screen.findByText(/New commit: Fix it/)).toBeInTheDocument();
    expect(screen.queryByText(/^Opened ·/)).not.toBeInTheDocument();
  });
});

const signedIn: AuthStatus = {
  status: 'authenticated',
  account: {
    id: 'acct-1',
    displayName: 'Test',
    email: 't@example.com',
    avatarUrl: null,
  },
  persistence: 'secure',
};

const remote = (
  overrides: Partial<RemoteRepository> = {},
): RemoteRepository => ({
  id: '33333333-3333-4333-8333-333333333333',
  name: 'linked-api',
  description: null,
  visibility: 'private',
  defaultBranch: 'main',
  status: 'ready',
  createdAt: Date.now() - 86_400_000,
  updatedAt: Date.now() - 3_600_000,
  ...overrides,
});

const remoteOnly = remote({
  id: '44444444-4444-4444-8444-444444444444',
  name: 'cloud-notes',
  status: 'failed',
});

// A linked local repository, a local-only one, and a remote with no folder here.
function installManaged() {
  status = signedIn;
  install(async () => [
    repo({ remoteId: remote().id, name: 'linked-api' }),
    repo({ id: '22222222-2222-4222-8222-222222222222', name: 'local-only' }),
  ]);
  repos.remoteOverview = vi.fn(async () => ({
    ...signedOut,
    state: 'live',
    total: 2,
    fetchedAt: Date.now(),
  }));
  repos.remoteList = vi.fn(async () => ({
    repositories: [remote(), remoteOnly],
    nextCursor: null,
  }));
  repos.remoteGet = vi.fn(async () => remote());
  repos.trash = vi.fn(async () => undefined);
}

const openRepositories = async () =>
  userEvent.click(await screen.findByRole('button', { name: 'Repositories' }));

const rowNames = () =>
  within(screen.getByRole('table'))
    .getAllByRole('row')
    .slice(1)
    .map(
      (row) =>
        row.querySelector('td:nth-child(2) button > span > span')?.textContent,
    );

describe('repository management', () => {
  beforeEach(() => {
    settings = DEFAULT_SETTINGS;
    installManaged();
  });
  afterEach(() => vi.restoreAllMocks());

  it('counts local, remote and linked repositories as overlapping sets and filters by them', async () => {
    renderApp();
    await openRepositories();
    const strip = await screen.findByRole('group', {
      name: 'Show repositories',
    });
    expect(
      await within(strip).findByRole('button', { name: /^3\s*All/ }),
    ).toHaveAttribute('aria-pressed', 'true');
    expect(
      within(strip).getByRole('button', { name: /^2\s*Local/ }),
    ).toBeInTheDocument();
    expect(
      within(strip).getByRole('button', { name: /^2\s*Remote/ }),
    ).toBeInTheDocument();
    expect(
      within(strip).getByRole('button', { name: /^1\s*Linked/ }),
    ).toBeInTheDocument();

    await userEvent.click(
      within(strip).getByRole('button', { name: /^2\s*Remote/ }),
    );
    expect(rowNames()).toEqual(
      expect.arrayContaining(['linked-api', 'cloud-notes']),
    );
    expect(rowNames()).not.toContain('local-only');

    await userEvent.click(
      within(strip).getByRole('button', { name: /^1\s*Linked/ }),
    );
    expect(rowNames()).toEqual(['linked-api']);
  });

  it('offers only the actions a remote-only repository can take', async () => {
    renderApp();
    await openRepositories();
    await userEvent.click(
      await screen.findByRole('button', {
        name: 'More actions for cloud-notes',
      }),
    );
    const menu = await screen.findByRole('menu');
    expect(
      within(menu).getByRole('menuitem', { name: 'Retry storage setup' }),
    ).toBeInTheDocument();
    expect(
      within(menu).getByRole('menuitem', {
        name: 'Delete remote repository…',
      }),
    ).toBeInTheDocument();
    expect(
      within(menu).queryByRole('menuitem', {
        name: /Explorer|Recycle Bin|path/,
      }),
    ).toBeNull();
  });

  it('says removing keeps the files, and only trashes a folder after its name is typed', async () => {
    renderApp();
    await openRepositories();
    const menuFor = async (name: string) => {
      await userEvent.click(
        await screen.findByRole('button', { name: `More actions for ${name}` }),
      );
      return screen.findByRole('menu');
    };

    await userEvent.click(
      within(await menuFor('local-only')).getByRole('menuitem', {
        name: 'Remove from gitdesk…',
      }),
    );
    expect(
      await screen.findByText(/The folder and its history stay on disk/),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Cancel' }));

    await userEvent.click(
      within(await menuFor('local-only')).getByRole('menuitem', {
        name: 'Move folder to Recycle Bin…',
      }),
    );
    const band = await screen.findByRole('group', {
      name: /Move local-only to the Recycle Bin/,
    });
    expect(
      within(band).getByText('~/Projects/desktop-git'),
    ).toBeInTheDocument();
    expect(
      within(band).getByText(/2 uncommitted changes go/),
    ).toBeInTheDocument();
    const confirm = within(band).getByRole('button', {
      name: 'Move to Recycle Bin',
    });
    await userEvent.type(within(band).getByRole('textbox'), 'local');
    await userEvent.click(confirm);
    expect(repos.trash).not.toHaveBeenCalled();
    await userEvent.type(within(band).getByRole('textbox'), '-only');
    await userEvent.click(confirm);
    expect(repos.trash).toHaveBeenCalledWith({
      id: '22222222-2222-4222-8222-222222222222',
      confirmName: 'local-only',
    });
  });

  it('charts commits from local history on Overview, and says so before the first commit', async () => {
    const monday = new Date();
    monday.setHours(0, 0, 0, 0);
    workspace.analytics = vi.fn(async () =>
      emptyAnalytics({
        totalCommits: 4,
        commits: 4,
        activeDays: 2,
        added: 12,
        removed: 3,
        filesTouched: 2,
        buckets: [
          {
            start: monday.getTime() - 7 * 86_400_000,
            commits: 1,
            added: 2,
            removed: 1,
          },
          { start: monday.getTime(), commits: 3, added: 10, removed: 2 },
        ],
        topFiles: [{ path: 'src/app.ts', commits: 3 }],
        authors: [{ name: 'Test', email: 'test@example.com', commits: 4 }],
      }),
    );
    renderApp();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open local-only' }),
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Overview' }));
    expect(
      await screen.findByRole('heading', {
        name: 'How often was main committed to?',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: /: 3 commits$/ }),
    ).toBeInTheDocument();
    expect(screen.getByText('src/app.ts')).toBeInTheDocument();
    expect(screen.getByText(/Busiest: 3 commits/)).toBeInTheDocument();

    cleanupRender();
    workspace.analytics = vi.fn(async () => emptyAnalytics({ headOid: null }));
    renderApp();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open local-only' }),
    );
    await userEvent.click(await screen.findByRole('tab', { name: 'Overview' }));
    expect(await screen.findByText('No commits yet')).toBeInTheDocument();
  });

  it('shows the list beside the selected repository in the split layout, and moves with the arrow keys', async () => {
    settings = { ...DEFAULT_SETTINGS, repositoriesLayout: 'split' };
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1200,
    } as DOMRect);
    renderApp();
    await openRepositories();
    const list = await screen.findByRole('listbox', { name: 'Repositories' });
    const options = await within(list).findAllByRole('option');
    expect(options[0]).toHaveAttribute('aria-selected', 'true');
    const inspector = screen.getByRole('region', {
      name: 'Selected repository',
    });
    const first = within(inspector).getByRole('heading', {
      level: 2,
    }).textContent;

    options[0]!.focus();
    await userEvent.keyboard('{ArrowDown}');
    expect(within(list).getAllByRole('option')[1]).toHaveAttribute(
      'aria-selected',
      'true',
    );
    expect(
      within(inspector).getByRole('heading', { level: 2 }).textContent,
    ).not.toBe(first);
  });

  it('pages the repository list twenty at a time, and selects only the page on screen', async () => {
    status = signedOutStatus;
    install(async () =>
      Array.from({ length: 25 }, (_, i) =>
        repo({
          id: `00000000-0000-4000-8000-0000000000${String(i).padStart(2, '0')}`,
          name: `repo-${String(i).padStart(2, '0')}`,
          lastOpenedAt: Date.now() - i * 1000,
        }),
      ),
    );
    renderApp();
    await openRepositories();
    const pager = await screen.findByRole('navigation', {
      name: 'Repository pages',
    });
    expect(within(pager).getByText('1–20 of 25')).toBeInTheDocument();
    expect(within(screen.getByRole('table')).getAllByRole('row')).toHaveLength(
      21,
    );

    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Select all shown' }),
    );
    expect(await screen.findByText('20 selected')).toBeInTheDocument();

    await userEvent.click(
      within(pager).getByRole('button', { name: 'Next page' }),
    );
    expect(within(pager).getByText('21–25 of 25')).toBeInTheDocument();
    expect(rowNames()).toEqual([
      'repo-20',
      'repo-21',
      'repo-22',
      'repo-23',
      'repo-24',
    ]);
  });
});
