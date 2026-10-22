import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatus, DesktopApi } from '../../shared/ipc';
import type { RemoteOverview, RepositorySummary } from '../../shared/repos';
import { DEFAULT_SETTINGS } from '../../shared/settings';
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

const status: AuthStatus = { status: 'signed-out' };
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

function install(list: () => Promise<RepositorySummary[]>) {
  repos = {
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
    settings: { get: vi.fn(async () => DEFAULT_SETTINGS), update: vi.fn() },
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
  } as unknown as DesktopApi;
}

const renderApp = () =>
  render(
    <Providers>
      <AppShell status={status} />
    </Providers>,
  );

describe('workspace', () => {
  beforeEach(() => install(async () => [repo()]));

  it('opens a repository without crashing the window', async () => {
    renderApp();
    await userEvent.click(
      await screen.findByRole('button', { name: 'Open desktop-git' }),
    );
    expect(
      await screen.findByRole('heading', { level: 1, name: 'desktop-git' }),
    ).toBeInTheDocument();
    expect(repos.open).toHaveBeenCalledWith(repo().id);
    expect(
      screen.getByRole('heading', { name: 'Changes' }),
    ).toBeInTheDocument();
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
