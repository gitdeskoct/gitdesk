import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthStatus } from '../../shared/ipc';
import { DEFAULT_SETTINGS, type Settings } from '../../shared/settings';
import {
  ApiRequestError,
  NetworkError,
  type ApiClient,
} from '../auth/api-client';
import { openDatabase, type AppDatabase } from '../db/database';
import { createRepositoryStore } from '../repos/repository-store';
import {
  AUTO_GAP_MS,
  createRemoteService,
  MANUAL_GAP_MS,
  RETRY_GAP_MS,
} from './remote-service';

const account = {
  id: 'acct-1',
  displayName: 'Ada',
  email: 'a@x.dev',
  avatarUrl: null,
};
const repo = (id: string) => ({
  id,
  name: id,
  description: null,
  visibility: 'private' as const,
  defaultBranch: 'main',
  status: 'ready' as const,
  createdAt: 1,
  updatedAt: 2,
});

let dir: string;
let db: AppDatabase;
let time: number;
let status: AuthStatus;
let settings: Settings;
const dashboardOverview = vi.fn();
const createRepository = vi.fn();
const deleteRepository = vi.fn();

function setup() {
  const store = createRepositoryStore(db);
  return createRemoteService({
    db,
    store,
    api: {
      dashboardOverview,
      createRepository,
      deleteRepository,
    } as unknown as ApiClient,
    auth: {
      getStatus: () => status,
      authorized: (fn) => fn('token'),
    },
    settings: () => settings,
    now: () => time,
  });
}

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gitdesk-remote-'));
  db = openDatabase(path.join(dir, 'test.db'));
  time = 1_000_000;
  status = { status: 'authenticated', account, persistence: 'secure' };
  settings = { ...DEFAULT_SETTINGS };
  dashboardOverview.mockReset();
  createRepository.mockReset();
  deleteRepository.mockReset();
  dashboardOverview.mockResolvedValue({
    total: 3,
    recent: [repo('a')],
    recentActivity: [],
    serverTime: time,
  });
});
afterEach(() => {
  db.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('remote overview throttle', () => {
  it('fetches once, then serves the cache until the automatic gap passes', async () => {
    const remote = setup();
    expect(await remote.overview(false)).toMatchObject({
      state: 'live',
      total: 3,
    });
    time += AUTO_GAP_MS - 1;
    await remote.overview(false);
    expect(dashboardOverview).toHaveBeenCalledTimes(1);
    time += 1;
    await remote.overview(false);
    expect(dashboardOverview).toHaveBeenCalledTimes(2);
  });

  it('shares one request between concurrent callers', async () => {
    const remote = setup();
    await Promise.all([
      remote.overview(false),
      remote.overview(true),
      remote.overview(false),
    ]);
    expect(dashboardOverview).toHaveBeenCalledTimes(1);
  });

  it('spaces manual refreshes and reports when the next one is allowed', async () => {
    const remote = setup();
    await remote.overview(true);
    time += MANUAL_GAP_MS - 1;
    const early = await remote.overview(true);
    expect(dashboardOverview).toHaveBeenCalledTimes(1);
    expect(early.nextRefreshAt).toBe(1_000_000 + MANUAL_GAP_MS);
    time += 1;
    await remote.overview(true);
    expect(dashboardOverview).toHaveBeenCalledTimes(2);
  });

  it('never fetches on its own in manual mode', async () => {
    settings = { ...settings, remoteRefresh: 'manual' };
    const remote = setup();
    expect(await remote.overview(false)).toMatchObject({ state: 'never' });
    expect(dashboardOverview).not.toHaveBeenCalled();
  });

  it('keeps the last data visible, marked cached, when the network fails', async () => {
    const remote = setup();
    await remote.overview(false);
    dashboardOverview.mockRejectedValue(new NetworkError());
    time += AUTO_GAP_MS;
    const result = await remote.overview(false);
    expect(result).toMatchObject({
      state: 'cached',
      total: 3,
      error: 'offline',
    });
    expect(result.recent.map((r) => r.id)).toEqual(['a']);
    // A failed attempt waits the retry gap before trying again.
    time += RETRY_GAP_MS - 1;
    await remote.overview(false);
    expect(dashboardOverview).toHaveBeenCalledTimes(2);
  });

  it('reports rate limiting from the server', async () => {
    dashboardOverview.mockRejectedValue(
      new ApiRequestError('RATE_LIMITED', 429),
    );
    const remote = setup();
    expect(await remote.overview(false)).toMatchObject({
      error: 'rate-limited',
    });
  });

  it('does not call the server while offline or signed out', async () => {
    status = { status: 'offline', account };
    const remote = setup();
    expect(await remote.overview(true)).toMatchObject({
      state: 'never',
      error: 'offline',
    });
    status = { status: 'signed-out' };
    expect(await remote.overview(true)).toMatchObject({ state: 'signed-out' });
    expect(dashboardOverview).not.toHaveBeenCalled();
  });

  it("forgets the account's remote names on sign-out", async () => {
    const remote = setup();
    await remote.overview(false);
    status = { status: 'signed-out' };
    remote.handleAuth(status);
    status = { status: 'authenticated', account, persistence: 'secure' };
    settings = { ...settings, remoteRefresh: 'manual' };
    expect(await remote.overview(false)).toMatchObject({
      state: 'never',
      recent: [],
    });
  });

  it('never shows one account the cache of another', async () => {
    const remote = setup();
    await remote.overview(false);
    status = {
      status: 'authenticated',
      account: { ...account, id: 'acct-2' },
      persistence: 'secure',
    };
    settings = { ...settings, remoteRefresh: 'manual' };
    expect(await remote.overview(false)).toMatchObject({
      state: 'never',
      total: null,
    });
  });

  it('counts requests for the day', async () => {
    const remote = setup();
    await remote.overview(false);
    await remote.overview(true);
    time += MANUAL_GAP_MS;
    expect((await remote.overview(true)).requestsToday).toBe(2);
  });

  it('turns server errors on create into readable messages', async () => {
    createRepository.mockRejectedValue(new ApiRequestError('NAME_TAKEN', 409));
    const remote = setup();
    await expect(
      remote.create({ name: 'a', description: null }, 'key-1'),
    ).rejects.toThrow('already exists');
    createRepository.mockRejectedValue(
      new ApiRequestError('LIMIT_REACHED', 403),
    );
    await expect(
      remote.create({ name: 'a', description: null }, 'key-1'),
    ).rejects.toThrow('reached its limit');
  });

  it('sends the idempotency key with a create', async () => {
    createRepository.mockResolvedValue({ repository: repo('b') });
    await setup().create({ name: 'b', description: null }, 'key-7');
    expect(createRepository).toHaveBeenCalledWith(
      'token',
      { name: 'b', description: null },
      'key-7',
    );
  });

  it('does not invent a total when nothing was fetched yet', async () => {
    settings = { ...settings, remoteRefresh: 'manual' };
    createRepository.mockResolvedValue({ repository: repo('b') });
    const remote = setup();
    await remote.create({ name: 'b', description: null }, 'key-1');
    expect(await remote.overview(false)).toMatchObject({
      state: 'never',
      total: null,
    });
  });

  it('adds a created repository to an existing cache without moving its fetch time', async () => {
    const remote = setup();
    const before = await remote.overview(false);
    createRepository.mockResolvedValue({ repository: repo('b') });
    time += 5_000;
    await remote.create({ name: 'b', description: null }, 'key-1');
    const after = await remote.overview(false);
    expect(after).toMatchObject({ total: 4, fetchedAt: before.fetchedAt });
    expect(after.recent.map((r) => r.id)).toContain('b');
  });

  it('drops an overview that lands after sign-out', async () => {
    let finish!: (value: unknown) => void;
    dashboardOverview.mockReturnValue(
      new Promise((resolve) => (finish = resolve)),
    );
    const remote = setup();
    const pending = remote.overview(false);
    status = { status: 'signed-out' };
    remote.handleAuth(status);
    finish({
      total: 9,
      recent: [repo('z')],
      recentActivity: [],
      serverTime: time,
    });
    await pending;
    status = { status: 'authenticated', account, persistence: 'secure' };
    settings = { ...settings, remoteRefresh: 'manual' };
    expect(await remote.overview(false)).toMatchObject({
      state: 'never',
      total: null,
      recent: [],
    });
  });

  it('makes no remote calls while gitdesk is set to local-only', async () => {
    settings = { ...settings, localOnly: true };
    const remote = setup();
    expect(await remote.overview(true)).toMatchObject({ state: 'signed-out' });
    await expect(
      remote.create({ name: 'a', description: null }, 'key-1'),
    ).rejects.toThrow('without an account');
    expect(dashboardOverview).not.toHaveBeenCalled();
    expect(createRepository).not.toHaveBeenCalled();
  });

  it('keeps a remote whose deletion stopped partway, marked deleting', async () => {
    const remote = setup();
    await remote.overview(false);
    deleteRepository.mockResolvedValueOnce({
      repository: { ...repo('a'), status: 'deleting' },
    });
    expect(await remote.remove('a')).toMatchObject({ status: 'incomplete' });
    const after = await remote.overview(false);
    expect(after).toMatchObject({ total: 3 });
    expect(after.recent).toEqual([
      expect.objectContaining({ id: 'a', status: 'deleting' }),
    ]);

    deleteRepository.mockResolvedValueOnce(undefined);
    expect(await remote.remove('a')).toEqual({ status: 'deleted' });
    expect((await remote.overview(false)).recent).toEqual([]);
  });
});
