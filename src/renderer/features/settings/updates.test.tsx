import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatus, DesktopApi } from '../../../shared/ipc';
import { DEFAULT_SETTINGS } from '../../../shared/settings';
import type { UpdateRelease, UpdateStatus } from '../../../shared/updates';
import { Providers } from '../../app/providers';
import { idleUpdates } from '../../test/updates-stub';
import { TitleBar } from '../shell/title-bar';
import { noteBlocks } from './release-notes';
import { UpdatesSection } from './updates-section';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const release: UpdateRelease = {
  version: '1.1.0',
  date: '2026-11-03T10:00:00.000Z',
  notes:
    '<h2>What’s new</h2><ul><li>Updates</li></ul><p><img src="https://evil.example/x.png" onerror="alert(1)">Plain <a href="https://evil.example">link</a></p><script>alert(1)</script>',
  sizeBytes: 96_400_000,
};
const base = {
  installKind: 'nsis' as const,
  currentVersion: '1.0.0',
  lastCheck: { at: Date.now() - 120_000, ok: true },
  releasePage:
    'https://github.com/BotCoder254/gitdesk-releases/releases/tag/v1.1.0',
};

let install: ReturnType<typeof vi.fn>;
let download: ReturnType<typeof vi.fn>;
let check: ReturnType<typeof vi.fn>;

function mount(status: UpdateStatus, ui: 'section' | 'titlebar' = 'section') {
  const bridge = idleUpdates(status);
  install = vi.fn(async () => status);
  download = vi.fn(() => new Promise<UpdateStatus>(() => {}));
  check = vi.fn(() => new Promise<UpdateStatus>(() => {}));
  window.desktop = {
    platform: 'win32',
    updates: { ...bridge, install, download, check },
    auth: {
      getStatus: async (): Promise<AuthStatus> => ({ status: 'signed-out' }),
      onStatusChanged: () => () => {},
    },
    settings: {
      get: async () => DEFAULT_SETTINGS,
      update: async () => DEFAULT_SETTINGS,
    },
    repos: { onChanged: () => () => {} },
    app: { onNotice: () => () => {}, onOpenRepository: () => () => {} },
  } as unknown as DesktopApi;
  return render(
    <Providers>
      {ui === 'section' ? <UpdatesSection /> : <TitleBar inShell />}
    </Providers>,
  );
}

beforeEach(() => vi.clearAllMocks());

describe('release notes', () => {
  it('keeps only text: no links, images or scripts', () => {
    const blocks = noteBlocks(release.notes!);
    expect(blocks).toEqual([
      { kind: 'heading', text: 'What’s new' },
      { kind: 'list', items: ['Updates'] },
      { kind: 'text', text: 'Plain link' },
    ]);
  });

  it('keeps plain-text notes', () => {
    expect(noteBlocks('Fixes a crash')).toEqual([
      { kind: 'text', text: 'Fixes a crash' },
    ]);
  });
});

describe('Settings › Updates', () => {
  it('up to date: one primary action, and checking shows its spinner', async () => {
    mount({ ...base, phase: 'up-to-date' });
    expect(
      await screen.findByText('gitdesk 1.0.0 is up to date'),
    ).toBeInTheDocument();
    const button = screen.getByRole('button', { name: 'Check for updates' });
    await userEvent.click(button);
    expect(check).toHaveBeenCalled();
    expect(button).toHaveAttribute('aria-busy', 'true');
    expect(button.querySelector('[data-spinner]')).not.toBeNull();
  });

  it('available: shows the release beside Download, and renders notes as text only', async () => {
    const { container } = mount({ ...base, phase: 'available', release });
    expect(
      await screen.findByRole('heading', { name: 'gitdesk 1.1.0' }),
    ).toBeInTheDocument();
    expect(container.querySelector('img, script, a[href]')).toBeNull();
    const download_ = screen.getByRole('button', { name: 'Download update' });
    await userEvent.click(download_);
    expect(download).toHaveBeenCalled();
    expect(download_.querySelector('[data-spinner]')).not.toBeNull();
  });

  it('downloaded: Restart to update asks main to install now', async () => {
    mount({ ...base, phase: 'downloaded', release });
    await userEvent.click(
      await screen.findByRole('button', { name: 'Restart to update' }),
    );
    expect(install).toHaveBeenCalledWith('now');
  });

  it('busy: offers to restart anyway or when the work is done', async () => {
    mount({ ...base, phase: 'busy', release, waiting: false });
    const band = await screen.findByText(/still running/);
    expect(band).toBeInTheDocument();
    await userEvent.click(
      screen.getByRole('button', { name: /Restart when it's done/ }),
    );
    expect(install).toHaveBeenCalledWith('when-idle');
  });

  it('a .deb install warns about the administrator password', async () => {
    mount({ ...base, installKind: 'deb', phase: 'downloaded', release });
    expect(
      await screen.findByRole('button', { name: 'Restart and install' }),
    ).toBeInTheDocument();
    expect(screen.getByText(/administrator password/)).toBeInTheDocument();
  });

  it('an archive or Nix install points to the release page instead', async () => {
    mount({ ...base, installKind: 'archive', phase: 'idle' });
    expect(
      await screen.findByText("This copy can't update itself"),
    ).toBeInTheDocument();
    expect(
      screen.getByRole('button', { name: 'Open release page' }),
    ).toBeInTheDocument();
    expect(screen.queryByRole('switch')).toBeNull();
  });
});

describe('title bar indicator', () => {
  it('stays hidden while there is nothing to act on', async () => {
    mount({ ...base, phase: 'up-to-date' }, 'titlebar');
    await screen.findByText('gitdesk');
    expect(screen.queryByRole('button', { name: /update/i })).toBeNull();
  });

  it('shows download progress, then Restart to update', async () => {
    mount(
      {
        ...base,
        phase: 'downloading',
        release,
        percent: 46.2,
        transferred: 1,
        total: 2,
        bytesPerSecond: 1,
      },
      'titlebar',
    );
    const progress = await screen.findByRole('button', {
      name: /Downloading gitdesk 1.1.0, 46 percent/,
    });
    expect(within(progress).getByText('46%')).toBeInTheDocument();
  });

  it('restarts straight from the title bar', async () => {
    mount({ ...base, phase: 'downloaded', release }, 'titlebar');
    await userEvent.click(
      await screen.findByRole('button', { name: 'Restart to update' }),
    );
    expect(install).toHaveBeenCalledWith('now');
  });
});
