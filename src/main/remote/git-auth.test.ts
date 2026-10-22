import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { gitAt, gitAuthEnv } from '../repos/git-inspector';
import { createGitAuth, sameUrl } from './git-auth';

const HOSTED = 'https://acct.artifacts.cloudflare.net/git/gitdesk/abc.git';
const REMOTE_ID = '66666666-6666-4666-8666-666666666666';

function setup(now = { value: 1_000_000 }) {
  const gitCredentials = vi.fn(
    async (_id: string, scope: 'read' | 'write', lifetime: number) => ({
      remote: HOSTED,
      token: `token-${scope}-${gitCredentials.mock.calls.length}`,
      scope,
      expiresAt: now.value + lifetime * 1000,
    }),
  );
  const hostedUrl = vi.fn(async () => HOSTED);
  const auth = createGitAuth({
    remote: { hostedUrl, gitCredentials },
    now: () => now.value,
  });
  return { auth, gitCredentials, hostedUrl, now };
}

describe('git auth', () => {
  it('gives nothing to unlinked repositories or other URLs', async () => {
    const { auth, gitCredentials } = setup();
    expect(await auth.envFor(null, HOSTED, 'read')).toBeNull();
    expect(
      await auth.envFor(REMOTE_ID, 'https://github.com/x/y.git', 'read'),
    ).toBeNull();
    expect(gitCredentials).not.toHaveBeenCalled();
  });

  it('reuses a token until a minute before it expires, and upgrades read to write', async () => {
    const { auth, gitCredentials, now } = setup();
    const first = await auth.envFor(REMOTE_ID, HOSTED, 'read');
    expect(first?.GIT_CONFIG_VALUE_0).toBe(
      'Authorization: Bearer token-read-1',
    );
    await auth.envFor(REMOTE_ID, `${HOSTED}/`, 'read');
    expect(gitCredentials).toHaveBeenCalledTimes(1);
    expect(gitCredentials).toHaveBeenLastCalledWith(REMOTE_ID, 'read', 900);

    // A read token never pushes.
    const write = await auth.envFor(REMOTE_ID, HOSTED, 'write');
    expect(write?.GIT_CONFIG_VALUE_0).toBe(
      'Authorization: Bearer token-write-2',
    );
    // A write token also reads.
    await auth.envFor(REMOTE_ID, HOSTED, 'read');
    expect(gitCredentials).toHaveBeenCalledTimes(2);

    now.value += 900_000 - 59_000;
    await auth.envFor(REMOTE_ID, HOSTED, 'read');
    expect(gitCredentials).toHaveBeenCalledTimes(3);
  });

  it('drops held tokens when told to', async () => {
    const { auth, gitCredentials } = setup();
    await auth.envFor(REMOTE_ID, HOSTED, 'read');
    auth.forget(REMOTE_ID);
    await auth.envFor(REMOTE_ID, HOSTED, 'read');
    auth.forget();
    await auth.envFor(REMOTE_ID, HOSTED, 'read');
    expect(gitCredentials).toHaveBeenCalledTimes(3);
  });

  it('treats a server it cannot reach as no hosted URL, not as an error', async () => {
    const { auth } = setup();
    const offline = createGitAuth({
      remote: {
        hostedUrl: vi.fn(async () => {
          throw new Error('offline');
        }),
        gitCredentials: vi.fn(),
      },
    });
    expect(await offline.envFor(REMOTE_ID, HOSTED, 'read')).toBeNull();
    expect(await auth.envFor(REMOTE_ID, HOSTED, 'read')).not.toBeNull();
  });

  it('matches URLs the way Git and the server may spell them', () => {
    expect(sameUrl(HOSTED, HOSTED.replace('acct.', 'ACCT.'))).toBe(true);
    expect(sameUrl(HOSTED, `${HOSTED}/`)).toBe(true);
    expect(sameUrl(HOSTED, HOSTED.replace('abc', 'abd'))).toBe(false);
    expect(sameUrl(HOSTED, 'not a url')).toBe(false);
  });
});

describe('gitAuthEnv', () => {
  let dir = '';
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it('scopes the header to one URL, turns redirects off for it, and passes the env guard', async () => {
    dir = mkdtempSync(path.join(os.tmpdir(), 'gitdesk-auth-'));
    execFileSync('git', ['init', '-q', dir]);
    const git = gitAt(dir, { auth: gitAuthEnv(HOSTED, 'secret-token') });
    const header = (url: string) =>
      git
        .raw(['config', '--get-urlmatch', 'http.extraheader', url])
        .catch(() => '');
    expect((await header(HOSTED)).trim()).toBe(
      'Authorization: Bearer secret-token',
    );
    expect((await header('https://github.com/x/y.git')).trim()).toBe('');
    expect(
      (
        await git.raw([
          'config',
          '--get-urlmatch',
          'http.followredirects',
          HOSTED,
        ])
      ).trim(),
    ).toBe('false');
    // Nothing reached the repository's own config.
    expect(
      (await gitAt(dir).raw(['config', '--local', '--list'])).includes(
        'secret-token',
      ),
    ).toBe(false);
  });
});
