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
import type { ChangedFile, RepositorySummary } from '../../../shared/repos';
import { DEFAULT_SETTINGS, type Settings } from '../../../shared/settings';
import {
  DEFAULT_REPO_PREFERENCES,
  type CommitRow,
} from '../../../shared/workspace';
import { Providers } from '../../app/providers';
import { AppShell } from '../shell/app-shell';

// Shiki is exercised in highlight.test.ts; here the diff renders as plain text.
vi.mock('./highlight', async (original) => ({
  ...(await original<typeof import('./highlight')>()),
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

const signedOut: AuthStatus = { status: 'signed-out' };
let status: AuthStatus = signedOut;
let settings: Settings = DEFAULT_SETTINGS;
const never = () => new Promise<never>(() => {});
const ID = '11111111-1111-4111-8111-111111111111';

const files: ChangedFile[] = [
  {
    path: 'src/staged.ts',
    kind: 'staged',
    code: 'M',
    origPath: null,
    submodule: false,
  },
  {
    path: 'src/edited.ts',
    kind: 'modified',
    code: 'M',
    origPath: null,
    submodule: false,
  },
  {
    path: 'notes.md',
    kind: 'untracked',
    code: '?',
    origPath: null,
    submodule: false,
  },
];

function repo(
  overrides: Partial<RepositorySummary['status']> = {},
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
      upstream: null,
      ahead: null,
      behind: null,
      staged: 1,
      unstaged: 1,
      untracked: 1,
      conflicts: 0,
      operation: null,
      hasRemotes: false,
      lastCommit: null,
      fetchedAt: null,
      ...overrides,
    },
    statusAt: Date.now() - 1000,
    inspectedAt: Date.now() - 1000,
    inspecting: false,
    error: null,
    remoteId: null,
    autoLink: null,
  };
}

let repos: Record<string, ReturnType<typeof vi.fn>>;
let workspace: Record<string, ReturnType<typeof vi.fn>>;

function install(list: RepositorySummary[] = [repo()]) {
  repos = {
    list: vi.fn(async () => list),
    activity: vi.fn(async () => []),
    remoteOverview: vi.fn(never),
    remoteList: vi.fn(never),
    history: vi.fn(never),
    changes: vi.fn(async () => ({ files, truncated: false })),
    open: vi.fn(async () => list[0]),
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
      local: [
        {
          name: 'main',
          oid: 'a'.repeat(40),
          upstream: null,
          ahead: null,
          behind: null,
          gone: false,
          current: true,
          otherWorktree: false,
          at: Date.now(),
          subject: 'First',
        },
        {
          name: 'feature',
          oid: 'b'.repeat(40),
          upstream: null,
          ahead: null,
          behind: null,
          gone: false,
          current: false,
          otherWorktree: false,
          at: Date.now(),
          subject: 'Feature',
        },
      ],
      remote: [],
      truncated: false,
    })),
    diff: vi.fn(async ({ path }: { path: string }) => ({
      status: 'text',
      path,
      oldPath: null,
      added: 1,
      removed: 1,
      truncated: false,
      newFile: false,
      deleted: false,
      modeChange: null,
      hunks: [
        {
          header: '@@ -1,1 +1,1 @@',
          oldStart: 1,
          newStart: 1,
          lines: [
            { kind: 'del', old: 1, new: null, text: 'const a = 1;' },
            { kind: 'add', old: null, new: 1, text: 'const a = 2;' },
          ],
        },
      ],
    })),
    stage: vi.fn(never),
    unstage: vi.fn(never),
    commit: vi.fn(async () => ({
      status: 'committed',
      oid: 'c'.repeat(40),
      branch: 'main',
    })),
    switchBranch: vi.fn(async () => ({
      status: 'blocked',
      reason: 'local-changes',
      files: ['src/edited.ts'],
    })),
    log: vi.fn(),
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
    repos,
    workspace,
  } as unknown as DesktopApi;
}

const openRepo = async () => {
  render(
    <Providers>
      <AppShell status={status} />
    </Providers>,
  );
  await userEvent.click(
    await screen.findByRole('button', { name: 'Open desktop-git' }),
  );
  await screen.findByRole('heading', { level: 1, name: 'desktop-git' });
};

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS, workspaceLayout: 'centered' };
  status = signedOut;
  install();
});
afterEach(() => vi.restoreAllMocks());

describe('staging parts of a file', () => {
  const TOKEN = 'f'.repeat(40);
  const openEdited = async () => {
    settings = { ...DEFAULT_SETTINGS, workspaceLayout: 'split' };
    install();
    const diff = workspace.diff!.getMockImplementation() as (input: {
      path: string;
    }) => Promise<object>;
    workspace.diff = vi.fn(async (input: { path: string }) => ({
      ...(await diff(input)),
      token: TOKEN,
    }));
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1000,
    } as DOMRect);
    await openRepo();
    await userEvent.click(
      await screen.findByRole('option', { name: /src\/edited\.ts/ }),
    );
    await screen.findByRole('table', { name: 'Diff of src/edited.ts' });
  };

  it('labels the comparison and stages chosen lines through Git with a spinner', async () => {
    await openEdited();
    expect(
      screen.getByText(/compared: Index to Working tree/),
    ).toBeInTheDocument();
    workspace.applySelection = vi.fn(never);
    await userEvent.click(
      screen.getByRole('button', {
        name: 'Select added line 1 for staging',
      }),
    );
    expect(screen.getByText(/changed line selected/)).toBeInTheDocument();
    const stage = screen.getByRole('button', { name: 'Stage lines' });
    await userEvent.click(stage);
    expect(workspace.applySelection).toHaveBeenCalledWith({
      id: ID,
      path: 'src/edited.ts',
      side: 'unstaged',
      action: 'stage',
      token: TOKEN,
      context: 3,
      hunks: [{ index: 0, lines: [1] }],
    });
    expect(stage).toHaveAttribute('aria-busy', 'true');
  });

  it('says so when the file changed while it was open, and when Git is busy', async () => {
    await openEdited();
    workspace.applySelection = vi.fn(async () => ({ status: 'stale' }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Stage change' })[0]!,
    );
    expect(
      await screen.findByText(/changed while you were reviewing it/),
    ).toBeInTheDocument();
    expect(screen.getByText(/Nothing was staged/)).toBeInTheDocument();

    workspace.applySelection = vi.fn(async () => ({
      status: 'rejected',
      reason: 'busy',
      message: 'Another Git process is using this repository.',
    }));
    await userEvent.click(
      screen.getAllByRole('button', { name: 'Stage change' })[0]!,
    );
    expect(
      await screen.findByText('Another Git process is using this repository.'),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument();
  });

  it('confirms a discard inline and names the saved copy', async () => {
    await openEdited();
    workspace.applySelection = vi.fn(async () => ({
      status: 'applied',
      saved: true,
    }));
    await userEvent.click(
      screen.getByRole('button', { name: 'Discard change…' }),
    );
    expect(
      screen.getByText(/A copy is saved in Discarded changes first/),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Discard change 1' }),
    );
    expect(workspace.applySelection).toHaveBeenCalledWith(
      expect.objectContaining({ action: 'discard', hunks: [{ index: 0 }] }),
    );
    expect(
      await screen.findByText('Discarded the selected changes'),
    ).toBeInTheDocument();
  });
});

describe('changes', () => {
  it('groups files the way Git keeps them apart and stages one with a spinner', async () => {
    await openRepo();
    expect(
      await screen.findByRole('listbox', { name: 'Staged' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('listbox', { name: 'Not staged' }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('listbox', { name: 'Untracked' }),
    ).toBeInTheDocument();
    const stage = screen.getByRole('button', { name: 'Stage src/edited.ts' });
    await userEvent.click(stage);
    expect(workspace.stage).toHaveBeenCalledWith({
      id: ID,
      paths: ['src/edited.ts'],
    });
    expect(stage).toHaveAttribute('aria-busy', 'true');
    expect(stage).not.toBeDisabled();
  });

  it('expands a diff inline with + and − marks that do not rely on color', async () => {
    await openRepo();
    await userEvent.click(
      await screen.findByRole('option', { name: /src\/edited\.ts/ }),
    );
    const diff = await screen.findByRole('table', {
      name: 'Diff of src/edited.ts',
    });
    expect(within(diff).getByText('Removed')).toBeInTheDocument();
    expect(within(diff).getByText('Added')).toBeInTheDocument();
    expect(workspace.diff).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ID,
        path: 'src/edited.ts',
        side: 'unstaged',
        context: 3,
      }),
    );
  });

  it('keeps Commit unavailable until there is a summary, then reports the local commit', async () => {
    await openRepo();
    const commit = await screen.findByRole('button', {
      name: 'Commit 1 file to main',
    });
    expect(commit).toHaveAttribute('aria-disabled', 'true');
    expect(screen.getByText('Write a summary to commit.')).toBeInTheDocument();
    await userEvent.type(
      screen.getByRole('textbox', { name: /Summary/ }),
      'Fix the parser',
    );
    await userEvent.click(commit);
    expect(workspace.commit).toHaveBeenCalledWith({
      id: ID,
      summary: 'Fix the parser',
      description: '',
    });
    expect(
      await screen.findByText(/It stays on this computer until you push/),
    ).toBeInTheDocument();
  });

  it('shows hook output when a hook stops the commit', async () => {
    workspace.commit = vi.fn(async () => ({
      status: 'rejected',
      reason: 'hook',
      output: 'lint failed: 2 problems',
    }));
    await openRepo();
    await userEvent.type(
      await screen.findByRole('textbox', { name: /Summary/ }),
      'Try',
    );
    await userEvent.click(
      screen.getByRole('button', { name: 'Commit 1 file to main' }),
    );
    expect(
      await screen.findByText(/A Git hook stopped the commit/),
    ).toBeInTheDocument();
    expect(screen.getByText('lint failed: 2 problems')).toBeInTheDocument();
  });

  it('shows the file list beside the diff in the split layout', async () => {
    settings = { ...DEFAULT_SETTINGS, workspaceLayout: 'split' };
    install();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1300,
    } as DOMRect);
    await openRepo();
    expect(
      await screen.findByText('Pick a file to see its diff'),
    ).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: 'Show first change' }),
    );
    expect(
      await screen.findByRole('table', { name: 'Diff of src/staged.ts' }),
    ).toBeInTheDocument();
  });

  it('stages one file with Space from the list, not its select box', async () => {
    await openRepo();
    const row = await screen.findByRole('option', { name: /src\/edited\.ts/ });
    row.focus();
    await userEvent.click(row);
    await userEvent.keyboard(' ');
    expect(workspace.stage).toHaveBeenCalledWith({
      id: ID,
      paths: ['src/edited.ts'],
    });
  });

  it('names the identity Git will commit with and where it comes from', async () => {
    workspace.commitIdentity = vi.fn(async () => ({
      name: 'Repo Person',
      email: 'repo@example.com',
      scope: 'local',
    }));
    await openRepo();
    expect(await screen.findByText('Repo Person')).toBeInTheDocument();
    expect(screen.getByText(/repository setting/)).toBeInTheDocument();
  });

  it('folds the commit message away in the split layout and remembers it', async () => {
    localStorage.removeItem('gitdesk.commit-form-open');
    settings = { ...DEFAULT_SETTINGS, workspaceLayout: 'split' };
    install();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      width: 1300,
    } as DOMRect);
    await openRepo();
    await userEvent.click(await screen.findByRole('button', { name: 'Hide' }));
    expect(
      screen.queryByRole('textbox', { name: /Summary/ }),
    ).not.toBeInTheDocument();
    expect(localStorage.getItem('gitdesk.commit-form-open')).toBe('false');
    // Committing with no summary opens the fields instead of failing out of sight.
    await userEvent.click(
      screen.getByRole('button', { name: /Commit 1 file/ }),
    );
    expect(workspace.commit).not.toHaveBeenCalled();
    expect(
      await screen.findByRole('textbox', { name: /Summary/ }),
    ).toHaveFocus();
    localStorage.removeItem('gitdesk.commit-form-open');
  });
});

describe('branches and history', () => {
  it('names the files that block a switch and never forces it', async () => {
    await openRepo();
    await userEvent.click(screen.getByRole('tab', { name: 'Branches' }));
    const row = (await screen.findByText('feature')).closest('li')!;
    await userEvent.click(within(row).getByRole('button', { name: 'Switch' }));
    expect(workspace.switchBranch).toHaveBeenCalledWith({
      id: ID,
      name: 'feature',
      kind: 'local',
    });
    expect(
      await screen.findByText(/gitdesk never discards them to switch/),
    ).toBeInTheDocument();
    expect(screen.getAllByText('src/edited.ts').length).toBeGreaterThan(0);
  });

  it('loads history 50 at a time from one snapshot', async () => {
    const page = (start: number, count: number): CommitRow[] =>
      Array.from({ length: count }, (_, i) => ({
        oid: String(start + i).padStart(40, '0'),
        parents: [],
        author: 'Test',
        email: 'test@example.com',
        at: Date.now() - (start + i) * 60_000,
        subject: `Commit ${start + i}`,
        refs: [],
      }));
    workspace.log = vi.fn(async ({ skip }: { skip: number }) =>
      skip === 0
        ? { snapshot: 'a'.repeat(40), commits: page(0, 50), nextSkip: 50 }
        : { snapshot: 'a'.repeat(40), commits: page(50, 3), nextSkip: null },
    );
    workspace.commitDetail = vi.fn(never);
    await openRepo();
    await userEvent.click(screen.getByRole('tab', { name: 'History' }));
    expect(await screen.findByText('Commit 0')).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: 'Load 50 more' }));
    expect(await screen.findByText('Commit 52')).toBeInTheDocument();
    expect(workspace.log).toHaveBeenLastCalledWith({
      id: ID,
      oid: 'a'.repeat(40),
      skip: 50,
    });
    expect(screen.getByText("That's the first commit.")).toBeInTheDocument();
  });
});

describe('push and the hosted Git URL', () => {
  const HOSTED = 'https://acct.artifacts.cloudflare.net/git/gitdesk/abc.git';
  const REMOTE_ID = '22222222-2222-4222-8222-222222222222';

  it('pushes the current branch with a cancel while it runs', async () => {
    install([
      repo({ hasRemotes: true, upstream: 'origin/main', ahead: 2, behind: 0 }),
    ]);
    workspace.push = vi.fn(never);
    workspace.cancelPush = vi.fn(async () => undefined);
    await openRepo();
    await userEvent.click(screen.getByRole('button', { name: /Push 2/ }));
    expect(workspace.push).toHaveBeenCalledWith({
      id: ID,
      jobId: expect.any(String),
    });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Cancel push' }),
    );
    expect(workspace.cancelPush).toHaveBeenCalledWith(
      (workspace.push.mock.calls[0]![0] as { jobId: string }).jobId,
    );
  });

  it('offers the account link from the Remotes tab when the repository has none', async () => {
    await openRepo();
    await userEvent.click(screen.getByRole('tab', { name: 'Remotes' }));
    const section = (
      await screen.findByText('Not linked to your account')
    ).closest('section')!;
    expect(
      within(section).getByRole('button', { name: 'Sign in' }),
    ).toBeInTheDocument();
  });

  it('shows the Git URL and adds it as a remote with a spinner, never a token', async () => {
    status = {
      status: 'authenticated',
      account: {
        id: 'acct-1',
        displayName: 'Test',
        email: 't@example.com',
        avatarUrl: null,
      },
      persistence: 'secure',
    };
    const linked = { ...repo(), remoteId: REMOTE_ID };
    install([linked]);
    repos.remoteGet = vi.fn(async () => ({
      id: REMOTE_ID,
      name: 'desktop-git',
      description: null,
      visibility: 'private',
      defaultBranch: 'main',
      status: 'ready',
      gitUrl: HOSTED,
      createdAt: 1,
      updatedAt: 2,
    }));
    repos.addHostedRemote = vi.fn(never);
    repos.copyGitCommand = vi.fn(async () => ({ expiresAt: Date.now() }));
    await openRepo();
    await userEvent.click(screen.getByRole('tab', { name: 'Remotes' }));

    expect(await screen.findByText(HOSTED)).toBeInTheDocument();
    const add = screen.getByRole('button', { name: 'Add as a Git remote' });
    await userEvent.click(add);
    expect(repos.addHostedRemote).toHaveBeenCalledWith(ID);
    expect(add).toHaveAttribute('aria-busy', 'true');
    expect(add).not.toBeDisabled();

    await userEvent.click(
      screen.getByRole('button', { name: 'Copy terminal command' }),
    );
    expect(repos.copyGitCommand).toHaveBeenCalledWith(ID);
    expect(await screen.findByText('Push command copied')).toBeInTheDocument();
    expect(document.body.textContent).not.toContain('Bearer');
  });
});
