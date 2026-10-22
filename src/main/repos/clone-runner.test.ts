import { execFileSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { cloneInto, parseGitProgress } from './clone-runner';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

let dir: string;
let origin: string;

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
  process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
});

beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gitdesk-clone-'));
  const source = path.join(dir, 'source');
  mkdirSync(source);
  git(source, 'init', '-q', '-b', 'main');
  writeFileSync(path.join(source, 'README.md'), '# hi\n');
  git(source, 'add', '.');
  git(source, 'commit', '-q', '-m', 'First');
  origin = path.join(dir, 'origin.git');
  git(dir, 'clone', '-q', '--bare', source, origin);
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const leftovers = () =>
  readdirSync(dir).filter((name) => name.includes('gitdesk-clone'));
const clone = (overrides: Partial<Parameters<typeof cloneInto>[0]> = {}) =>
  cloneInto({
    url: origin,
    parent: dir,
    name: 'copy',
    signal: new AbortController().signal,
    onProgress: () => undefined,
    // Tests clone from a local bare repository; the app itself allows https only.
    protocols: ['file'],
    ...overrides,
  });

describe('cloneInto', () => {
  it('clones into the named folder and leaves no temporary folder', async () => {
    const stages: string[] = [];
    // A file:// URL goes through the pack protocol like a network clone; a bare path takes
    // Git's local shortcut and reports no progress.
    const target = await clone({
      url: pathToFileURL(origin).href,
      onProgress: (p) => stages.push(p.stage),
    });
    expect(target).toBe(path.join(dir, 'copy'));
    // Git's own progress lines reach the caller, so the bar moves for real.
    expect(stages.length).toBeGreaterThan(0);
    expect(git(target, 'log', '--format=%s')).toContain('First');
    expect(leftovers()).toEqual([]);
  });

  it('never touches a folder that already exists', async () => {
    const existing = path.join(dir, 'copy');
    mkdirSync(existing);
    writeFileSync(path.join(existing, 'keep.txt'), 'mine');
    await expect(clone()).rejects.toThrow('already exists');
    expect(readdirSync(existing)).toEqual(['keep.txt']);
  });

  it('removes only its temporary folder when cancelled', async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(clone({ signal: controller.signal })).rejects.toThrow(
      'cancelled',
    );
    expect(existsSync(path.join(dir, 'copy'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('cleans up after a failed clone', async () => {
    await expect(
      clone({ url: path.join(dir, 'missing.git') }),
    ).rejects.toThrow();
    expect(existsSync(path.join(dir, 'copy'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });

  it('refuses transports outside the allowed list', async () => {
    await expect(clone({ protocols: ['https'] })).rejects.toThrow();
    expect(existsSync(path.join(dir, 'copy'))).toBe(false);
    expect(leftovers()).toEqual([]);
  });
});

describe('parseGitProgress', () => {
  it('reads stage, percent, size and speed from the receiving line', () => {
    expect(
      parseGitProgress(
        'Receiving objects:  45% (450/1000), 1.50 MiB | 2.00 MiB/s',
      ),
    ).toEqual({
      stage: 'Receiving objects',
      percent: 45,
      receivedBytes: 1_572_864,
      bytesPerSecond: 2_097_152,
    });
  });

  it('reads stages that carry no size, including remote ones', () => {
    expect(
      parseGitProgress('remote: Counting objects: 100% (12/12), done.'),
    ).toMatchObject({
      stage: 'Counting objects',
      percent: 100,
      receivedBytes: null,
    });
    expect(parseGitProgress('Resolving deltas:  50% (2/4)')).toMatchObject({
      stage: 'Resolving deltas',
      bytesPerSecond: null,
    });
  });

  it('ignores lines that are not progress', () => {
    expect(parseGitProgress("Cloning into 'copy'...")).toBeNull();
    expect(parseGitProgress('')).toBeNull();
  });
});
