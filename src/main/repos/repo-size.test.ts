import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import {
  measureRepository,
  parseCountObjects,
  parseTreeSizes,
} from './repo-size';

const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', args, { cwd, encoding: 'utf8' });

beforeAll(() => {
  process.env.GIT_AUTHOR_NAME = 'Test';
  process.env.GIT_AUTHOR_EMAIL = 'test@example.com';
  process.env.GIT_COMMITTER_NAME = 'Test';
  process.env.GIT_COMMITTER_EMAIL = 'test@example.com';
});

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(path.join(os.tmpdir(), 'gitdesk-size-'));
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('parsers', () => {
  it('reads object counts from count-objects -v', () => {
    const output =
      'count: 12\nsize: 48\nin-pack: 3400\npacks: 2\nsize-pack: 9000\nprune-packable: 0\ngarbage: 0\n';
    expect(parseCountObjects(output)).toEqual({
      loose: 12,
      packed: 3400,
      packs: 2,
    });
    expect(parseCountObjects('')).toEqual({ loose: 0, packed: 0, packs: 0 });
  });

  it('reads blob sizes from ls-tree -l -z and skips submodules', () => {
    const oid = 'a'.repeat(40);
    const output =
      `100644 blob ${oid}    1200\tsrc/app.ts\0` +
      `100644 blob ${oid}      42\tname with spaces.md\0` +
      `160000 commit ${oid}       -\tvendor/lib\0`;
    expect(parseTreeSizes(output)).toEqual([
      { path: 'src/app.ts', bytes: 1200 },
      { path: 'name with spaces.md', bytes: 42 },
    ]);
  });
});

describe('measureRepository', () => {
  it('splits the folder into Git history, tracked files and everything else', async () => {
    const root = path.join(dir, 'repo');
    mkdirSync(root);
    git(root, 'init', '-q', '-b', 'main');
    writeFileSync(path.join(root, 'big.bin'), Buffer.alloc(20_000, 1));
    writeFileSync(path.join(root, 'small.txt'), 'hello\n');
    git(root, 'add', '.');
    git(root, 'commit', '-q', '-m', 'First');
    mkdirSync(path.join(root, 'build'));
    writeFileSync(path.join(root, 'build', 'out.js'), Buffer.alloc(5_000, 2));

    const size = await measureRepository(root, () => 1_000);
    expect(size.tracked).toBe(20_006);
    expect(size.trackedFiles).toBe(2);
    expect(size.workingFiles).toBe(3);
    expect(size.other).toBe(5_000);
    expect(size.git).toBeGreaterThan(0);
    expect(size.total).toBe(size.git + size.tracked + size.other);
    expect(size.largest[0]).toEqual({ path: 'big.bin', bytes: 20_000 });
    expect(size.measuredAt).toBe(1_000);
    expect(size.truncated).toBe(false);
  });

  it('measures a repository with no commits yet', async () => {
    const root = path.join(dir, 'empty');
    mkdirSync(root);
    git(root, 'init', '-q');
    writeFileSync(path.join(root, 'draft.txt'), 'x'.repeat(10));
    const size = await measureRepository(root);
    expect(size.tracked).toBe(0);
    expect(size.trackedFiles).toBe(0);
    expect(size.other).toBe(10);
    expect(size.largest).toEqual([]);
  });
});
