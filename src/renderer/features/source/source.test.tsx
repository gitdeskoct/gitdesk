import {
  fireEvent,
  render,
  screen,
  waitFor,
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
import type { AuthStatus, DesktopApi } from '../../../shared/ipc';
import type { RepositorySummary } from '../../../shared/repos';
import { DEFAULT_SETTINGS, type Settings } from '../../../shared/settings';
import type {
  SourceEntry,
  SourceFile,
  SourceListInput,
} from '../../../shared/source';
import { DEFAULT_REPO_PREFERENCES } from '../../../shared/workspace';
import { Providers } from '../../app/providers';
import { AppShell } from '../shell/app-shell';
import { SourceExplorer } from './source-explorer';

// Shiki is exercised in highlight.test.tsx; here code renders as plain text.
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
  Element.prototype.setPointerCapture ??= () => {};
  Element.prototype.scrollIntoView ??= () => {};
});

const ID = '11111111-1111-4111-8111-111111111111';
const REMOTE = '22222222-2222-4222-8222-222222222222';
const OID = 'a'.repeat(40);
const never = () => new Promise<never>(() => {});
let settings: Settings;
let status: AuthStatus;

const entry = (
  path: string,
  type: SourceEntry['type'] = 'file',
  extra: Partial<SourceEntry> = {},
): SourceEntry => ({
  name: path.split('/').pop()!,
  path,
  type,
  size: type === 'file' ? 10 : null,
  oid: null,
  status: null,
  ignored: false,
  changes: false,
  ...extra,
});

const TREE: Record<string, SourceEntry[]> = {
  '': [
    entry('src', 'dir', { changes: true }),
    entry('README.md'),
    entry('app.exe'),
    entry('big.log'),
  ],
  src: [
    entry('src/main.ts', 'file', {
      status: { code: 'M', kind: 'modified', staged: false, unstaged: true },
    }),
  ],
};
const FILES: Record<string, SourceFile> = {
  'README.md': { kind: 'text', text: '# app\n', size: 6, oid: null, eol: 'lf' },
  'src/main.ts': {
    kind: 'text',
    text: 'export const a = 1;\nexport const b = 2;\n',
    size: 40,
    oid: null,
    eol: 'lf',
  },
  'app.exe': { kind: 'binary', size: 2048, reason: 'binary' },
  'big.log': {
    kind: 'too-large',
    size: 3 * 1024 * 1024,
    limit: 1024 * 1024,
    canForce: true,
  },
};

const repo = (): RepositorySummary => ({
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
    headOid: OID,
    upstream: null,
    ahead: null,
    behind: null,
    staged: 0,
    unstaged: 1,
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
});

let source: Record<string, ReturnType<typeof vi.fn>>;

function install() {
  source = {
    list: vi.fn(async (input: SourceListInput) => ({
      entries: TREE[input.path] ?? [],
      total: (TREE[input.path] ?? []).length,
      nextOffset: null,
    })),
    read: vi.fn(async ({ path, force }: { path: string; force: boolean }) =>
      force && path === 'big.log'
        ? { kind: 'text', text: 'line\n', size: 5, oid: null, eol: 'lf' }
        : (FILES[path] ?? { kind: 'missing' }),
    ),
    resolve: vi.fn(async () => ({ oid: OID })),
    paths: vi.fn(async ({ query }: { query: string }) => ({
      matches: ['src/main.ts'].filter((p) => p.includes(query)),
      total: query === 'main' ? 1 : 0,
      truncated: false,
    })),
    lastChange: vi.fn(async () => null),
    reveal: vi.fn(async () => undefined),
    stats: vi.fn(never),
    remoteBranches: vi.fn(async () => ({
      ok: true,
      defaultBranch: 'main',
      branches: [{ name: 'main', oid: OID }],
    })),
    remoteList: vi.fn(async ({ path }: { path: string }) => ({
      ok: true,
      commit: OID,
      entries: (TREE[path] ?? []).map((e) => ({
        ...e,
        status: null,
        oid: 'b'.repeat(40),
      })),
      nextCursor: null,
    })),
    remoteRead: vi.fn(async () => ({ ok: true, file: FILES['README.md'] })),
    remoteSave: vi.fn(never),
    onChanged: vi.fn(() => () => {}),
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
      signIn: vi.fn(never),
    },
    settings: {
      get: vi.fn(async () => settings),
      update: vi.fn(async (p) => ({ ...settings, ...p })),
    },
    git: { getIdentity: vi.fn(never) },
    repos: {
      list: vi.fn(async () => [repo()]),
      activity: vi.fn(async () => []),
      remoteOverview: vi.fn(never),
      remoteList: vi.fn(never),
      history: vi.fn(never),
      changes: vi.fn(async () => ({ files: [], truncated: false, total: 0 })),
      open: vi.fn(async () => repo()),
      refresh: vi.fn(async () => undefined),
      onChanged: vi.fn(() => () => {}),
      onProgress: vi.fn(() => () => {}),
    },
    workspace: {
      watch: vi.fn(async () => undefined),
      unwatch: vi.fn(async () => undefined),
      preferences: vi.fn(async () => DEFAULT_REPO_PREFERENCES),
      setPreferences: vi.fn(async (p) => ({
        ...DEFAULT_REPO_PREFERENCES,
        ...p,
      })),
      remotes: vi.fn(async () => []),
      editors: vi.fn(async () => []),
      branches: vi.fn(async () => ({
        current: 'main',
        detached: false,
        headOid: OID,
        local: [],
        remote: [],
        truncated: false,
      })),
      copyFilePath: vi.fn(async () => undefined),
      openInEditor: vi.fn(async () => undefined),
    },
    source,
  } as unknown as DesktopApi;
}

const openFiles = async () => {
  render(
    <Providers>
      <AppShell status={status} />
    </Providers>,
  );
  await userEvent.click(
    await screen.findByRole('button', { name: 'Open desktop-git' }),
  );
  await userEvent.click(await screen.findByRole('tab', { name: 'Files' }));
  return screen.findByRole('tree', { name: 'Files in desktop-git' });
};

beforeEach(() => {
  settings = {
    ...DEFAULT_SETTINGS,
    workspaceLayout: 'centered',
    sourceLayout: 'centered',
  };
  status = { status: 'signed-out' };
  install();
});
afterEach(() => vi.restoreAllMocks());

describe('Files tab', () => {
  it('lists the working tree, folders first, and opens a file from the keyboard', async () => {
    const tree = await openFiles();
    const rows = await within(tree).findAllByRole('treeitem');
    expect(rows[0]).toHaveAccessibleName(/^src/);
    expect(source.list).toHaveBeenCalledWith(
      expect.objectContaining({
        id: ID,
        path: '',
        snapshot: { kind: 'worktree' },
        showIgnored: false,
      }),
    );
    const src = within(tree).getByRole('treeitem', { name: /^src/ });
    expect(src).toHaveAttribute('aria-expanded', 'false');
    src.focus();
    await userEvent.keyboard('{ArrowRight}');
    expect(
      await within(tree).findByRole('treeitem', { name: /main\.ts/ }),
    ).toHaveAttribute('aria-level', '2');
    expect(src).toHaveAttribute('aria-expanded', 'true');
    await userEvent.keyboard('{ArrowDown}{Enter}');
    expect(
      await screen.findByRole('region', { name: 'Contents of src/main.ts' }),
    ).toHaveTextContent('export const b = 2;');
    expect(
      screen.getByText(
        /TypeScript · Working tree · Modified, not staged · 2 lines/,
      ),
    ).toBeInTheDocument();
  });

  it('starts with one action to read a file, and says what a binary file is', async () => {
    await openFiles();
    expect(
      await screen.findByRole('heading', { name: 'Pick a file to read' }),
    ).toBeInTheDocument();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open README.md' }),
    );
    expect(
      await screen.findByRole('region', { name: 'Contents of README.md' }),
    ).toHaveTextContent('# app');
    await userEvent.click(screen.getByRole('treeitem', { name: /app\.exe/ }));
    expect(
      await screen.findByRole('heading', { name: 'app.exe is binary' }),
    ).toBeInTheDocument();
    expect(
      screen.getAllByRole('button', { name: /Show in Explorer/ }).length,
    ).toBeGreaterThan(0);
  });

  it('asks before a large file and shows it on request', async () => {
    const tree = await openFiles();
    await userEvent.click(
      within(tree).getByRole('treeitem', { name: /big\.log/ }),
    );
    await userEvent.click(
      await screen.findByRole('button', { name: 'Show anyway' }),
    );
    await waitFor(() =>
      expect(source.read).toHaveBeenCalledWith(
        expect.objectContaining({ path: 'big.log', force: true }),
      ),
    );
    expect(
      await screen.findByRole('region', { name: 'Contents of big.log' }),
    ).toHaveTextContent('line');
  });

  it('filters every path Git knows and says when nothing matches', async () => {
    await openFiles();
    const filter = screen.getByRole('searchbox', { name: 'Filter files' });
    await userEvent.type(filter, 'main');
    expect(
      await screen.findByRole('button', { name: /src\/main\.ts/ }),
    ).toBeInTheDocument();
    expect(
      screen.getByText('Paths in this repository. Ignored files are left out.'),
    ).toBeInTheDocument();
    await userEvent.clear(filter);
    await userEvent.type(filter, 'zzz');
    expect(
      await screen.findByRole('heading', { name: 'No paths match “zzz”' }),
    ).toBeInTheDocument();
    await userEvent.click(screen.getByRole('button', { name: /Clear filter/ }));
    expect(filter).toHaveValue('');
  });

  it('switches to the staged snapshot and asks for ignored files only when shown', async () => {
    await openFiles();
    await userEvent.click(
      screen.getByRole('checkbox', { name: 'Show ignored files' }),
    );
    await waitFor(() =>
      expect(source.list).toHaveBeenCalledWith(
        expect.objectContaining({ showIgnored: true }),
      ),
    );
    await userEvent.click(
      screen.getByRole('button', { name: /Showing Working tree/ }),
    );
    await userEvent.click(
      await screen.findByRole('menuitem', { name: /Staged/ }),
    );
    await waitFor(() =>
      expect(source.list).toHaveBeenCalledWith(
        expect.objectContaining({ snapshot: { kind: 'index' } }),
      ),
    );
    expect(
      screen.queryByRole('checkbox', { name: 'Show ignored files' }),
    ).not.toBeInTheDocument();
  });

  it('shows a spinner on Refresh while it reads again', async () => {
    await openFiles();
    source.list!.mockImplementation(never);
    const refresh = screen.getAllByRole('button', { name: 'Refresh' }).at(-1)!;
    await userEvent.click(refresh);
    expect(refresh).toHaveAttribute('aria-busy', 'true');
    expect(refresh).not.toBeDisabled();
  });

  it('copies a path and reveals a file from the context menu', async () => {
    const tree = await openFiles();
    fireEvent.contextMenu(
      within(tree).getByRole('treeitem', { name: /README\.md/ }),
    );
    await userEvent.click(
      await screen.findByRole('menuitem', { name: /Show in Explorer/ }),
    );
    expect(source.reveal).toHaveBeenCalledWith({ id: ID, path: 'README.md' });
  });
});

describe('hosted files', () => {
  it('reads a pinned commit through the account and names the problem when it cannot', async () => {
    status = { status: 'authenticated' } as AuthStatus;
    render(
      <Providers>
        <SourceExplorer
          mode={{
            kind: 'remote',
            repoId: REMOTE,
            name: 'site',
            defaultBranch: 'main',
            localId: null,
          }}
        />
      </Providers>,
    );
    const tree = await screen.findByRole('tree', { name: 'Files in site' });
    expect(source.remoteList).toHaveBeenCalledWith({
      id: REMOTE,
      ref: 'HEAD',
      path: '',
      cursor: null,
    });
    await userEvent.click(
      within(tree).getByRole('treeitem', { name: /README\.md/ }),
    );
    expect(
      await screen.findByRole('region', { name: 'Contents of README.md' }),
    ).toHaveTextContent('# app');
    expect(source.remoteRead).toHaveBeenCalledWith(
      expect.objectContaining({
        id: REMOTE,
        oid: 'b'.repeat(40),
        path: 'README.md',
      }),
    );
    expect(
      screen.getByRole('button', { name: /Save a copy/ }),
    ).toBeInTheDocument();
  });

  it('explains hosting being off', async () => {
    source.remoteList!.mockResolvedValue({ ok: false, problem: 'hosting-off' });
    render(
      <Providers>
        <SourceExplorer
          mode={{
            kind: 'remote',
            repoId: REMOTE,
            name: 'site',
            defaultBranch: 'main',
            localId: null,
          }}
        />
      </Providers>,
    );
    expect(
      await screen.findByRole('heading', {
        name: 'Git hosting is off on the server',
      }),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Try again' }),
    ).toBeInTheDocument();
  });
});
