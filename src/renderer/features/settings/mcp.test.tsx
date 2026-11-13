import { render, screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import type { AuthStatus, DesktopApi } from '../../../shared/ipc';
import type {
  McpApi,
  McpLocalStatus,
  McpRemoteStatus,
} from '../../../shared/mcp';
import { DEFAULT_SETTINGS, type Settings } from '../../../shared/settings';
import { Providers } from '../../app/providers';
import { idleMcp, offMcpStatus } from '../../test/mcp-stub';
import { idleUpdates } from '../../test/updates-stub';
import { Page } from '../shell/page';
import { McpSection } from './mcp-section';

beforeAll(() => {
  globalThis.ResizeObserver ??= class {
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

const signedIn: AuthStatus = {
  status: 'authenticated',
  persistence: 'secure',
  account: {
    id: 'a1',
    displayName: 'Ada',
    email: 'ada@example.com',
    avatarUrl: null,
  },
};
const REPO = '11111111-1111-4111-8111-111111111111';
const on: McpLocalStatus = {
  ...offMcpStatus,
  enabled: true,
  listening: true,
  repositories: [],
  clients: ['Desk Agent'],
};
const remote: McpRemoteStatus = {
  endpoint: 'https://api.example/mcp',
  more: false,
  grants: [
    {
      id: 'user:grant1',
      clientName: 'Cloud Agent',
      clientDomain: null,
      redirectHost: '127.0.0.1',
      scopes: ['repo:read', 'pr:read', 'offline_access'],
      createdAt: Date.UTC(2026, 10, 1),
      expiresAt: null,
      lastUsedAt: null,
    },
  ],
  calls: [
    {
      id: 'c1',
      client: 'Cloud Agent',
      tool: 'close_pull_request',
      repositoryName: null,
      outcome: 'refused',
      reason: 'MISSING_SCOPE',
      at: Date.now() - 60_000,
    },
  ],
};

function mount(options: {
  status?: AuthStatus;
  settings?: Partial<Settings>;
  local?: McpLocalStatus;
  mcp?: Partial<McpApi>;
  page?: boolean;
}) {
  const settings = { ...DEFAULT_SETTINGS, ...options.settings };
  const status = options.status ?? { status: 'signed-out' };
  const update = vi.fn(async (patch: Partial<Settings>) => ({
    ...settings,
    ...patch,
  }));
  const mcp = {
    ...idleMcp(options.local ?? offMcpStatus),
    remoteStatus: async () => remote,
    ...options.mcp,
  };
  window.desktop = {
    platform: 'linux',
    mcp,
    updates: idleUpdates(),
    auth: {
      getStatus: async () => status,
      signIn: vi.fn(async () => status),
      onStatusChanged: () => () => {},
    },
    settings: { get: async () => settings, update },
    repos: {
      list: async () => [
        { id: REPO, name: 'api-tools', displayPath: '~/code/api-tools' },
      ],
      onChanged: () => () => {},
      onProgress: () => () => {},
    },
    app: { onNotice: () => () => {}, onOpenRepository: () => () => {} },
  } as unknown as DesktopApi;
  render(
    <Providers>
      {options.page ? (
        <Page crumbs={[{ label: 'Home' }]}>body</Page>
      ) : (
        <McpSection status={status} />
      )}
    </Providers>,
  );
  return { update, mcp };
}

describe('Settings › MCP', () => {
  it('starts with everything off and offers sign-in for the account half', async () => {
    const { update } = mount({});
    const toggle = await screen.findByRole('switch', {
      name: 'Let agents on this computer connect',
    });
    expect(toggle).not.toBeChecked();
    expect(screen.queryByText('Agent setup')).not.toBeInTheDocument();
    expect(
      await screen.findByText('Agents connected to your account'),
    ).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Sign in' })).toBeVisible();
    await userEvent.click(toggle);
    expect(update).toHaveBeenCalledWith({ mcpLocal: true });
  });

  it('shares a repository, copies the setup and names who is connected', async () => {
    const setRepositories = vi.fn(async () => ({
      ...on,
      repositories: [REPO],
    }));
    const copyConfig = vi.fn(async () => {});
    mount({
      settings: { mcpLocal: true },
      local: on,
      mcp: { setRepositories, copyConfig },
    });
    expect(await screen.findByText(/Connected now: Desk Agent/)).toBeVisible();
    const row = (await screen.findByText('api-tools')).closest('label')!;
    await userEvent.click(within(row).getByRole('checkbox'));
    expect(setRepositories).toHaveBeenCalledWith([REPO]);
    expect(await within(row).findByRole('checkbox')).toBeChecked();

    await userEvent.click(screen.getByRole('button', { name: 'Copy setup' }));
    expect(copyConfig).toHaveBeenCalled();
    expect(await screen.findByText('Setup copied')).toBeVisible();

    expect(
      screen.getByRole('switch', { name: 'Let agents ask to make changes' }),
    ).not.toBeChecked();
  });

  it('points to the setting when gitdesk is local-only, even when signed in', async () => {
    mount({ status: signedIn, settings: { localOnly: true } });
    expect(
      await screen.findByText(/set to work without an account/),
    ).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Sign in' })).toBeNull();
    expect(screen.getByRole('button', { name: 'Open settings' })).toBeVisible();
  });

  it('quotes the command it shows, so a path with spaces still works', async () => {
    mount({
      settings: { mcpLocal: true },
      local: { ...on, command: '/opt/My Apps/gitdesk', args: ['--mcp'] },
    });
    expect(
      await screen.findByText("'/opt/My Apps/gitdesk' --mcp"),
    ).toBeInTheDocument();
  });

  it('shows the local connection loading and failing like the rest of Settings', async () => {
    mount({
      settings: { mcpLocal: true },
      mcp: {
        localStatus: async () => {
          throw new Error(
            "Error invoking remote method 'mcp:local-status': Error: Boom.",
          );
        },
      },
    });
    expect(await screen.findByText('Boom.')).toBeVisible();
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });

  it('says so when the local connection could not be opened', async () => {
    mount({
      settings: { mcpLocal: true },
      local: { ...on, listening: false, error: "gitdesk couldn't open it." },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "gitdesk couldn't open it.",
    );
  });

  it('lists the account’s agents with what they can do, and revokes one', async () => {
    let release = () => {};
    const revokeGrant = vi.fn(
      () => new Promise<void>((resolve) => (release = resolve)),
    );
    mount({ status: signedIn, mcp: { revokeGrant } });
    expect((await screen.findAllByText('Cloud Agent'))[0]).toBeVisible();
    expect(
      screen.getByText(
        /Can read repositories, read pull requests\. Name not verified; access goes to 127\.0\.0\.1\. Not used yet\./,
      ),
    ).toBeVisible();
    expect(screen.getByText('https://api.example/mcp')).toBeVisible();
    expect(
      screen.getByText(/Refused: Not permitted for this agent/),
    ).toBeVisible();

    const button = screen.getByRole('button', { name: 'Revoke' });
    await userEvent.click(button);
    expect(revokeGrant).toHaveBeenCalledWith('user:grant1');
    // The spinner is mounted and the button keeps its place while the server answers.
    expect(
      await screen.findByRole('button', { name: 'Revoking…' }),
    ).toHaveAttribute('aria-busy', 'true');
    release();
  });

  it('shows a load failure with a way to try again', async () => {
    mount({
      status: signedIn,
      mcp: {
        remoteStatus: async () => {
          throw new Error(
            "Error invoking remote method 'mcp:remote-status': Error: Can't reach the gitdesk server.",
          );
        },
      },
    });
    expect(await screen.findByRole('alert')).toHaveTextContent(
      "Can't reach the gitdesk server.",
    );
    expect(screen.getByRole('button', { name: 'Try again' })).toBeVisible();
  });
});

describe('approval band', () => {
  it('asks on any page and sends the answer', async () => {
    const decide = vi.fn(async () => on);
    mount({
      page: true,
      local: {
        ...on,
        writes: true,
        approvals: [
          {
            id: '99999999-9999-4999-8999-999999999999',
            tool: 'commit',
            client: 'Desk Agent',
            repositoryId: REPO,
            repositoryName: 'api-tools',
            summary: 'Commit 1 staged file to main: Fix the parser',
            details: ['src/parser.ts'],
            total: 1,
            requestedAt: Date.now(),
            expiresAt: Date.now() + 120_000,
          },
        ],
      },
      mcp: { decide },
    });
    // The name is shown as the agent's claim, and only the words are a live region.
    const words = (await screen.findByText(/as it calls itself/)).closest(
      '[role="status"]',
    )!;
    expect(words).toHaveTextContent(
      'Desk Agent (as it calls itself) wants to change api-tools: Commit 1 staged file to main: Fix the parser.',
    );
    expect(within(words as HTMLElement).queryByRole('button')).toBeNull();
    expect(screen.getByText('src/parser.ts')).toBeVisible();
    await userEvent.click(screen.getByRole('button', { name: 'Allow' }));
    expect(decide).toHaveBeenCalledWith({
      id: '99999999-9999-4999-8999-999999999999',
      allow: true,
    });
  });

  it('counts every item, not only the ones it lists', async () => {
    mount({
      page: true,
      local: {
        ...on,
        writes: true,
        approvals: [
          {
            id: '99999999-9999-4999-8999-999999999999',
            tool: 'stage_paths',
            client: 'Desk Agent',
            repositoryId: REPO,
            repositoryName: 'api-tools',
            summary: 'Stage 30 files',
            details: Array.from({ length: 20 }, (_, i) => `f${i}.txt`),
            total: 30,
            requestedAt: Date.now(),
            expiresAt: Date.now() + 120_000,
          },
        ],
      },
    });
    expect(await screen.findByText(/and 25 more/)).toBeVisible();
  });

  it('is absent when nothing is waiting', async () => {
    mount({ page: true, local: on });
    expect(await screen.findByText('body')).toBeVisible();
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull();
  });
});
