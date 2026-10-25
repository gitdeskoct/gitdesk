import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { isInside, resolveInside } from './paths';

let tmp: string;
let root: string;

beforeEach(() => {
  tmp = mkdtempSync(path.join(os.tmpdir(), 'gitdesk-paths-'));
  root = path.join(tmp, 'repo');
  mkdirSync(path.join(root, 'src'), { recursive: true });
  mkdirSync(path.join(root, '.git'));
  writeFileSync(path.join(root, 'src', 'a.ts'), 'a');
  writeFileSync(path.join(root, '.git', 'config'), 'secret');
  writeFileSync(path.join(tmp, 'outside.txt'), 'outside');
});
afterEach(() => rmSync(tmp, { recursive: true, force: true }));

// Symlinks need developer mode or admin on Windows; skip those checks where they can't be made.
const link = (target: string, at: string, type: 'file' | 'dir' = 'file') => {
  try {
    symlinkSync(target, at, type === 'dir' ? 'junction' : 'file');
    return true;
  } catch {
    return false;
  }
};

describe('resolveInside', () => {
  it('finds files and the root itself', async () => {
    const file = await resolveInside(root, 'src/a.ts');
    expect(file?.abs).toBe(path.resolve(root, 'src', 'a.ts'));
    expect(file?.stat?.isFile()).toBe(true);
    expect((await resolveInside(root, ''))?.stat?.isDirectory()).toBe(true);
    expect((await resolveInside(root, 'src/missing.ts'))?.stat).toBeNull();
  });

  it('refuses climbing out, absolute paths, NUL and anything in .git', async () => {
    for (const rel of [
      '../outside.txt',
      'src/../../outside.txt',
      path.join(tmp, 'outside.txt'),
      '/etc/passwd',
      'C:/Windows/win.ini',
      'src/a.ts\0',
      '.git/config',
      '.GIT/config',
      '.git./config',
      'GIT~1/config',
    ])
      expect(await resolveInside(root, rel)).toBeNull();
  });

  it('never follows a final symlink, and refuses a linked folder that leads out', async () => {
    if (!link(path.join(tmp, 'outside.txt'), path.join(root, 'leak.txt')))
      return;
    const leak = await resolveInside(root, 'leak.txt');
    expect(leak?.stat?.isSymbolicLink()).toBe(true);
    if (!link(tmp, path.join(root, 'up'), 'dir')) return;
    expect(await resolveInside(root, 'up/outside.txt')).toBeNull();
  });

  it('tells inside from a sibling that only shares a prefix', () => {
    expect(isInside('/a/repo', '/a/repo/x')).toBe(true);
    expect(isInside('/a/repo', '/a/repo')).toBe(true);
    expect(isInside(path.resolve('/a/repo'), path.resolve('/a/repo2'))).toBe(
      false,
    );
    expect(isInside(path.resolve('/a/repo'), path.resolve('/a'))).toBe(false);
  });
});
