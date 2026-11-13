import { mkdtemp, readFile, rm, stat } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { PassThrough } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LOCAL_READ_TOOLS, type McpLocalStatus } from '../../shared/mcp';
import type { RepositorySummary } from '../../shared/repos';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import { openDatabase, type AppDatabase } from '../db/database';
import { mcpSocketPath, mcpTokenPath, privateTempDir } from './endpoint';
import { cleanName, clientNameOf } from './local-server';
import { looksSecret, type LocalServices } from './local-tools';
import { createMcpService } from './mcp-service';
import { isMcpInvocation, runMcpProxy } from './proxy';

const SHARED = '11111111-1111-4111-8111-111111111111';
const PRIVATE = '22222222-2222-4222-8222-222222222222';

const repo = (id: string, name: string): RepositorySummary => ({
  id,
  name,
  description: null,
  displayPath: `~/code/${name}`,
  pinned: false,
  addedAt: 1,
  lastOpenedAt: null,
  availability: 'available',
  status: null,
  statusAt: null,
  inspectedAt: null,
  inspecting: false,
  error: null,
  remoteId: null,
  autoLink: null,
});

let dir: string;
let db: AppDatabase;
let settings: Settings;
let emitted: McpLocalStatus[];
let notified: string[];
let copied: string[];
let services: {
  [K in keyof LocalServices]: Record<string, ReturnType<typeof vi.fn>>;
};
let service: ReturnType<typeof createMcpService>;
let head: {
  current: string | null;
  detached: boolean;
  headOid: string | null;
  local: { name: string; current: boolean; upstream: string | null }[];
  remote: never[];
};

beforeEach(async () => {
  head = {
    current: 'main',
    detached: false,
    headOid: 'b'.repeat(40),
    local: [{ name: 'main', current: true, upstream: 'origin/main' }],
    remote: [],
  };
  dir = await mkdtemp(path.join(os.tmpdir(), 'gd-mcp-'));
  db = openDatabase(path.join(dir, 'gitdesk.db'));
  settings = { ...DEFAULT_SETTINGS, mcpLocal: true };
  emitted = [];
  notified = [];
  copied = [];
  services = {
    repos: {
      list: vi.fn(async () => [
        repo(SHARED, 'shared'),
        repo(PRIVATE, 'private'),
      ]),
      changes: vi.fn(async () => ({
        files: [
          { path: 'a.txt', kind: 'modified', code: 'M' },
          { path: 'b.txt', kind: 'staged', code: 'M' },
        ],
        truncated: false,
        total: 2,
      })),
    },
    workspace: {
      diff: vi.fn(async () => ({
        status: 'empty',
        path: 'a.txt',
        modeChange: null,
      })),
      branches: vi.fn(async () => head),
      log: vi.fn(),
      commitDetail: vi.fn(),
      remotes: vi.fn(async () => []),
      stage: vi.fn(async () => ({ status: 'done' })),
      unstage: vi.fn(),
      commit: vi.fn(async () => ({
        status: 'committed',
        oid: 'a'.repeat(40),
        branch: 'main',
      })),
      switchBranch: vi.fn(),
      fetch: vi.fn(),
      push: vi.fn(),
    },
    branches: { compare: vi.fn(), mergeability: vi.fn(), create: vi.fn() },
    pulls: {
      list: vi.fn(),
      get: vi.fn(),
      comments: vi.fn(),
      reviews: vi.fn(),
      addComment: vi.fn(),
    },
    source: {
      list: vi.fn(),
      read: vi.fn(async () => ({
        kind: 'text',
        text: 'hello',
        size: 5,
        oid: null,
        eol: 'lf',
      })),
      resolve: vi.fn(),
    },
  };
  service = createMcpService({
    db,
    userData: dir,
    settings: () => settings,
    services: services as unknown as LocalServices,
    launch: { command: '/opt/gitdesk/gitdesk', args: ['--mcp'], env: {} },
    account: {
      signedIn: () => false,
      call: async () => {
        throw new Error('not signed in');
      },
      api: {} as never,
    },
    copyText: (text) => copied.push(text),
    notify: (notice) => notified.push(notice.title),
    emit: (status) => emitted.push(status),
    log: { warn: () => undefined },
  });
  await service.start();
  await service.setRepositories([SHARED]);
});

afterEach(async () => {
  await service.dispose();
  db.close();
  await rm(dir, { recursive: true, force: true });
});

// An agent as it really connects: through `gitdesk --mcp`, over its stdin and stdout.
function agent(name = 'Test Agent') {
  const stdin = new PassThrough();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const done = runMcpProxy(dir, { stdin, stdout, stderr });
  const waiting = new Map<number, (message: any) => void>();
  let buffer = '';
  stdout.on('data', (chunk: Buffer) => {
    buffer += chunk.toString('utf8');
    for (let end = buffer.indexOf('\n'); end >= 0; end = buffer.indexOf('\n')) {
      const message = JSON.parse(buffer.slice(0, end));
      buffer = buffer.slice(end + 1);
      waiting.get(message.id)?.(message);
      waiting.delete(message.id);
    }
  });
  let id = 0;
  const request = (method: string, params: unknown = {}) =>
    new Promise<any>((resolve) => {
      id += 1;
      waiting.set(id, resolve);
      stdin.write(
        `${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`,
      );
    });
  const open = async () => {
    await request('initialize', {
      protocolVersion: '2025-06-18',
      capabilities: {},
      clientInfo: { name, version: '1' },
    });
    stdin.write(
      `${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`,
    );
  };
  const call = async (tool: string, args: Record<string, unknown> = {}) => {
    const { result } = await request('tools/call', {
      name: tool,
      arguments: args,
    });
    const first = result.content[0].text as string;
    return {
      isError: result.isError === true,
      text: first,
      data: result.isError ? null : JSON.parse(first),
    };
  };
  const tools = async () =>
    ((await request('tools/list')).result.tools as { name: string }[]).map(
      (tool) => tool.name,
    );
  return { open, call, tools, request, close: () => stdin.end(), done, stderr };
}

const until = async (check: () => boolean) => {
  for (let i = 0; i < 200 && !check(); i++)
    await new Promise((r) => setTimeout(r, 10));
  expect(check()).toBe(true);
};

describe('local MCP connection', () => {
  it.skipIf(process.platform === 'win32')(
    'keeps its socket and token to this user',
    async () => {
      expect((await stat(mcpSocketPath(dir))).mode & 0o077).toBe(0);
      expect((await stat(mcpTokenPath(dir))).mode & 0o077).toBe(0);
      expect((await readFile(mcpTokenPath(dir), 'utf8')).length).toBe(64);
    },
  );

  it('drops a connection that does not open with the token', async () => {
    const socket = net.connect(mcpSocketPath(dir));
    const closed = new Promise((resolve) => socket.once('close', resolve));
    socket.write(`${JSON.stringify({ gitdesk: 1, token: 'f'.repeat(64) })}\n`);
    socket.write(
      `${JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list' })}\n`,
    );
    let answered = false;
    socket.on('data', () => (answered = true));
    await closed;
    expect(answered).toBe(false);
    expect((await service.status()).clients).toEqual([]);
  });

  it('answers every request with a reason when gitdesk is not listening', async () => {
    settings = { ...settings, mcpLocal: false };
    await service.applySettings();
    const bot = agent();
    const reply = await bot.request('tools/list');
    expect(reply.error.message).toContain('Settings › MCP');
    bot.close();
    expect(await bot.done).toBe(1);
  });

  it('names the connected agent and forgets it when it leaves', async () => {
    const bot = agent('Desk Agent');
    await bot.open();
    await until(() => emitted.at(-1)?.clients[0] === 'Desk Agent');
    bot.close();
    await bot.done;
    await until(() => emitted.at(-1)?.clients.length === 0);
  });

  it('recognises the flag an agent starts gitdesk with', () => {
    expect(isMcpInvocation(['/opt/gitdesk/gitdesk', '--mcp'])).toBe(true);
    expect(isMcpInvocation(['/opt/gitdesk/gitdesk'])).toBe(false);
  });
});

describe('local MCP tools', () => {
  it('shows only shared repositories and says nothing of the rest', async () => {
    const bot = agent();
    await bot.open();
    const list = await bot.call('list_repositories');
    expect(list.data.repositories.map((r: { name: string }) => r.name)).toEqual(
      ['shared'],
    );

    const hidden = await bot.call('get_status', { repositoryId: PRIVATE });
    const missing = await bot.call('get_status', {
      repositoryId: '33333333-3333-4333-8333-333333333333',
    });
    expect(hidden.isError).toBe(true);
    expect(hidden.text).toBe(missing.text);
    expect(services.repos.changes).not.toHaveBeenCalled();
    expect(
      service.calls().map((c) => `${c.tool}:${c.outcome}:${c.reason}`),
    ).toEqual([
      'get_status:refused:NOT_ALLOWED',
      'get_status:refused:NOT_ALLOWED',
    ]);

    const status = await bot.call('get_status', { repositoryId: SHARED });
    expect(status.data.files).toHaveLength(2);
    bot.close();
  });

  it('refuses paths outside the repository and files that look like credentials', async () => {
    const bot = agent();
    await bot.open();
    for (const file of [
      '../outside.txt',
      '/etc/passwd',
      '.git/config',
      'a/../../b',
    ]) {
      const reply = await bot.request('tools/call', {
        name: 'read_file',
        arguments: { repositoryId: SHARED, path: file },
      });
      expect(JSON.stringify(reply)).not.toContain('hello');
    }
    for (const file of [
      '.env',
      'config/.env.production',
      'deploy/id_rsa',
      'certs/server.pem',
      'secrets.json',
    ]) {
      const reply = await bot.call('read_file', {
        repositoryId: SHARED,
        path: file,
      });
      expect(reply.isError).toBe(true);
      expect(reply.text).toContain('credentials');
    }
    expect(services.source.read).not.toHaveBeenCalled();
    expect(
      (
        await bot.call('read_file', {
          repositoryId: SHARED,
          path: 'src/env.ts',
        })
      ).data.text,
    ).toBe('hello');
    expect(looksSecret('docs/environment.md')).toBe(false);
    bot.close();
  });

  it('offers no way to change anything while changes are off', async () => {
    const bot = agent();
    await bot.open();
    const names = await bot.tools();
    expect(names).toContain('read_file');
    expect([...names].sort()).toEqual([...LOCAL_READ_TOOLS].sort());
    // Nothing that merges, discards, resets or runs a program exists at any setting.
    expect(
      names.filter((name) =>
        /merge$|discard|reset|rebase|delete|shell|exec|command/.test(name),
      ),
    ).toEqual([]);
    bot.close();
  });

  it('makes a change only after Allow, and records what happened', async () => {
    settings = { ...settings, mcpLocalWrites: true };
    await service.applySettings();
    const bot = agent('Desk Agent');
    await bot.open();
    expect(await bot.tools()).toContain('commit');

    const denied = bot.call('commit', {
      repositoryId: SHARED,
      summary: 'Fix the parser',
    });
    await until(() => (emitted.at(-1)?.approvals.length ?? 0) === 1);
    const asked = emitted.at(-1)!.approvals[0]!;
    // What is staged right now, and where it goes: what Allow will actually commit.
    expect(asked).toMatchObject({
      client: 'Desk Agent',
      repositoryName: 'shared',
      tool: 'commit',
      summary: 'Commit 1 staged file to main: Fix the parser',
      details: ['b.txt'],
      total: 1,
    });
    expect(notified).toEqual([
      'Desk Agent (as it calls itself) wants to change shared',
    ]);
    expect(services.workspace.commit).not.toHaveBeenCalled();
    await service.decide({ id: asked.id, allow: false });
    expect((await denied).text).toContain('chose not to allow');
    expect(services.workspace.commit).not.toHaveBeenCalled();

    const allowed = bot.call('commit', {
      repositoryId: SHARED,
      summary: 'Fix the parser',
    });
    await until(() => (emitted.at(-1)?.approvals.length ?? 0) === 1);
    await service.decide({ id: emitted.at(-1)!.approvals[0]!.id, allow: true });
    expect((await allowed).data.status).toBe('committed');
    expect(services.workspace.commit).toHaveBeenCalledWith({
      id: SHARED,
      summary: 'Fix the parser',
      description: '',
    });

    const hidden = await bot.call('commit', {
      repositoryId: PRIVATE,
      summary: 'x',
    });
    expect(hidden.isError).toBe(true);
    expect(emitted.at(-1)!.approvals).toEqual([]);

    expect(
      service
        .calls()
        .map((c) => `${c.tool}:${c.outcome}:${c.reason}`)
        .sort(),
    ).toEqual([
      'commit:ok:null',
      'commit:refused:DENIED',
      'commit:refused:NOT_ALLOWED',
    ]);
    // Only names and outcomes are kept.
    expect(
      JSON.stringify(db.prepare('SELECT * FROM mcp_calls').all()),
    ).not.toContain('Fix the parser');
    bot.close();
  });

  it('records a change Git refused as failed, not done', async () => {
    settings = { ...settings, mcpLocalWrites: true };
    await service.applySettings();
    services.workspace.push!.mockResolvedValue({
      status: 'failed',
      reason: 'no-remote',
      message: 'This repository has no remote to push to.',
    });
    const bot = agent();
    await bot.open();
    const pushing = bot.call('push', { repositoryId: SHARED });
    await until(() => (emitted.at(-1)?.approvals.length ?? 0) === 1);
    await service.decide({ id: emitted.at(-1)!.approvals[0]!.id, allow: true });
    expect((await pushing).data.reason).toBe('no-remote');
    expect(service.calls()[0]).toMatchObject({
      tool: 'push',
      outcome: 'failed',
      reason: 'REFUSED_BY_GIT',
    });
    bot.close();
  });

  it('refuses a waiting change when changes are turned off', async () => {
    settings = { ...settings, mcpLocalWrites: true };
    await service.applySettings();
    const bot = agent();
    await bot.open();
    const waiting = bot.call('stage_paths', {
      repositoryId: SHARED,
      paths: ['a.txt'],
    });
    await until(() => (emitted.at(-1)?.approvals.length ?? 0) === 1);
    settings = { ...settings, mcpLocalWrites: false };
    await service.applySettings();
    expect((await waiting).isError).toBe(true);
    expect(services.workspace.stage).not.toHaveBeenCalled();
    const later = await bot.call('stage_paths', {
      repositoryId: SHARED,
      paths: ['a.txt'],
    });
    expect(later.text).toContain('turned off');
    bot.close();
  });

  it('answers a waiting change before closing when MCP is turned off', async () => {
    settings = { ...settings, mcpLocalWrites: true };
    await service.applySettings();
    const bot = agent();
    await bot.open();
    const waiting = bot.call('commit', { repositoryId: SHARED, summary: 'x' });
    await until(() => (emitted.at(-1)?.approvals.length ?? 0) === 1);
    settings = { ...settings, mcpLocal: false };
    const closing = service.applySettings();
    expect((await waiting).text).toContain('chose not to allow');
    // Still connected for a moment, but already refused.
    expect((await bot.call('list_repositories')).text).toContain('turned off');
    await closing;
    expect(await bot.done).toBe(0);
    expect(services.workspace.commit).not.toHaveBeenCalled();
  });

  it('times a change out when nobody answers', async () => {
    settings = { ...settings, mcpLocalWrites: true };
    await service.applySettings();
    const bot = agent();
    await bot.open();
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    try {
      const waiting = bot.call('push', { repositoryId: SHARED });
      await vi.waitFor(() => expect(emitted.at(-1)?.approvals.length).toBe(1));
      vi.advanceTimersByTime(2 * 60_000 + 1);
      vi.useRealTimers();
      expect((await waiting).text).toContain('Nobody answered');
    } finally {
      vi.useRealTimers();
    }
    expect(services.workspace.push).not.toHaveBeenCalled();
    bot.close();
  });
});

describe('local MCP approvals', () => {
  it('withdraws the question when the agent disconnects', async () => {
    settings = { ...settings, mcpLocalWrites: true };
    await service.applySettings();
    const bot = agent();
    await bot.open();
    void bot.call('push', { repositoryId: SHARED });
    await until(() => (emitted.at(-1)?.approvals.length ?? 0) === 1);
    const id = emitted.at(-1)!.approvals[0]!.id;
    bot.close();
    await bot.done;
    await until(() => emitted.at(-1)?.approvals.length === 0);
    // A late Allow finds nothing to run.
    await service.decide({ id, allow: true });
    expect(services.workspace.push).not.toHaveBeenCalled();
  });

  it('names the branch and upstream a push goes to, and refuses if they moved', async () => {
    settings = { ...settings, mcpLocalWrites: true };
    await service.applySettings();
    const bot = agent();
    await bot.open();
    const pushing = bot.call('push', { repositoryId: SHARED });
    await until(() => (emitted.at(-1)?.approvals.length ?? 0) === 1);
    expect(emitted.at(-1)!.approvals[0]).toMatchObject({
      summary: 'Push main to origin/main',
      details: ['main at bbbbbbb'],
    });
    // Someone switched branch while the question was open.
    head = { ...head, current: 'other', headOid: 'c'.repeat(40) };
    await service.decide({ id: emitted.at(-1)!.approvals[0]!.id, allow: true });
    const answer = await pushing;
    expect(answer.isError).toBe(true);
    expect(answer.text).toContain('changed after the person was asked');
    expect(services.workspace.push).not.toHaveBeenCalled();
    expect(service.calls()[0]).toMatchObject({
      tool: 'push',
      outcome: 'refused',
      reason: 'STATE_CHANGED',
    });
    bot.close();
  });

  it('refuses invalid input before asking anyone', async () => {
    settings = { ...settings, mcpLocalWrites: true };
    await service.applySettings();
    const bot = agent();
    await bot.open();
    const reply = await bot.call('commit', {
      repositoryId: SHARED,
      summary: 'two\nlines',
    });
    expect(reply.isError).toBe(true);
    expect(reply.text).toContain('one line');
    expect(emitted.every((status) => status.approvals.length === 0)).toBe(true);
    expect(notified).toEqual([]);
    bot.close();
  });

  it('counts every file it was asked to stage, not just those listed', async () => {
    settings = { ...settings, mcpLocalWrites: true };
    await service.applySettings();
    const bot = agent();
    await bot.open();
    const paths = Array.from({ length: 30 }, (_, i) => `f${i}.txt`);
    void bot.call('stage_paths', { repositoryId: SHARED, paths });
    await until(() => (emitted.at(-1)?.approvals.length ?? 0) === 1);
    const asked = emitted.at(-1)!.approvals[0]!;
    expect(asked.details).toHaveLength(20);
    expect(asked.total).toBe(30);
    expect(asked.summary).toBe('Stage 30 files');
    bot.close();
  });

  it('keeps one agent from filling the queue for everyone', async () => {
    settings = { ...settings, mcpLocalWrites: true };
    await service.applySettings();
    const busy = agent('Busy');
    await busy.open();
    for (let i = 0; i < 5; i++)
      void busy.call('push', { repositoryId: SHARED });
    await until(() => (emitted.at(-1)?.approvals.length ?? 0) === 5);
    expect((await busy.call('push', { repositoryId: SHARED })).text).toContain(
      'still waiting',
    );
    const other = agent('Other');
    await other.open();
    void other.call('push', { repositoryId: SHARED });
    await until(() => (emitted.at(-1)?.approvals.length ?? 0) === 6);
    busy.close();
    other.close();
  });

  it('records attempts to read credentials, and knows more of their names', async () => {
    const bot = agent();
    await bot.open();
    for (const file of [
      '.envrc',
      '.git-credentials',
      '.pgpass',
      'infra/terraform.tfstate',
      '.kube/config',
      '.docker/config.json',
      'kubeconfig',
    ]) {
      expect(looksSecret(file)).toBe(true);
      expect(
        (await bot.call('read_file', { repositoryId: SHARED, path: file }))
          .isError,
      ).toBe(true);
    }
    expect(service.calls()[0]).toMatchObject({
      tool: 'read_file',
      outcome: 'refused',
      reason: 'SECRET_FILE',
    });
    bot.close();
  });

  it('checks the old name of a renamed file before showing its diff', async () => {
    services.repos.changes!.mockResolvedValue({
      files: [
        { path: 'notes.txt', origPath: '.env', kind: 'staged', code: 'R' },
      ],
      truncated: false,
      total: 1,
    });
    const bot = agent();
    await bot.open();
    const reply = await bot.call('get_diff', {
      repositoryId: SHARED,
      path: 'notes.txt',
      side: 'staged',
    });
    expect(reply.isError).toBe(true);
    expect(services.workspace.diff).not.toHaveBeenCalled();
    bot.close();
  });
});

describe('agent names and socket place', () => {
  it('reads the name from initialize and from the stateless protocol’s _meta', () => {
    expect(
      clientNameOf({
        method: 'initialize',
        params: { clientInfo: { name: 'desk-agent', title: 'Desk Agent' } },
      }),
    ).toBe('Desk Agent');
    // Clients on protocol 2026-07-28 (Claude Code 2.1, for one) send no initialize at all.
    expect(
      clientNameOf({
        method: 'server/discover',
        params: {
          _meta: {
            'io.modelcontextprotocol/clientInfo': {
              name: 'claude-code',
              title: 'Claude Code',
            },
          },
        },
      }),
    ).toBe('Claude Code');
    expect(
      clientNameOf({
        method: 'tools/list',
        params: {
          _meta: { 'io.modelcontextprotocol/clientInfo': { name: 'bare' } },
        },
      }),
    ).toBe('bare');
    expect(clientNameOf({ method: 'tools/list', params: {} })).toBeNull();
    expect(clientNameOf({ result: {} })).toBeNull();
  });

  it('names an agent that never sends initialize', async () => {
    const bot = agent();
    await bot.request('tools/list', {
      _meta: {
        'io.modelcontextprotocol/protocolVersion': '2026-07-28',
        'io.modelcontextprotocol/clientInfo': {
          name: 'claude-code',
          title: 'Claude Code',
          version: '2',
        },
      },
    });
    await until(() => emitted.at(-1)?.clients[0] === 'Claude Code');
    bot.close();
  });

  it('takes out characters that make one name look like another', () => {
    expect(cleanName('Cla\u202Eude\u200B  Code\n')).toBe('Claude Code');
    expect(cleanName('\u200B')).toBeNull();
    expect(cleanName(42)).toBeNull();
  });

  it('puts a long profile’s socket in this user’s runtime folder, not shared temp', () => {
    const long = `/home/u/${'x'.repeat(120)}`;
    expect(
      mcpSocketPath(long, 'linux', { XDG_RUNTIME_DIR: '/run/user/1000' }),
    ).toMatch(/^\/run\/user\/1000\/gitdesk-mcp-[0-9a-f]{16}\.sock$/);
    const fallback = mcpSocketPath(long, 'linux', {});
    expect(path.dirname(fallback)).toBe(privateTempDir());
    expect(path.dirname(fallback)).not.toBe(os.tmpdir());
  });
});

describe('MCP settings', () => {
  it('copies setup that starts gitdesk with --mcp', async () => {
    await service.copyConfig();
    expect(JSON.parse(copied[0]!)).toEqual({
      mcpServers: {
        gitdesk: { command: '/opt/gitdesk/gitdesk', args: ['--mcp'] },
      },
    });
  });

  it('drops ids gitdesk does not know from the shared list', async () => {
    const status = await service.setRepositories([
      SHARED,
      '44444444-4444-4444-8444-444444444444',
    ]);
    expect(status.repositories).toEqual([SHARED]);
  });

  it('asks for a sign-in before anything about the account', async () => {
    await expect(service.remoteStatus()).rejects.toThrow('Sign in');
    await expect(service.revokeGrant('abc')).rejects.toThrow('Sign in');
  });
});
