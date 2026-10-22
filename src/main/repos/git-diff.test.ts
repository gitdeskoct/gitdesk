import { describe, expect, it } from 'vitest';
import { repoPathSchema } from '../../shared/workspace';
import { aggregate, analyticsBuckets, parseLogNumstat } from './git-analytics';
import { parseDiff, parseNumstat, untrackedDiff } from './git-diff';
import { ignoredPath } from './tree-watcher';

describe('parseDiff', () => {
  it('numbers context, removed and added lines per hunk', () => {
    const diff = parseDiff(
      [
        'diff --git a/a.ts b/a.ts',
        'index 1111111..2222222 100644',
        '--- a/a.ts',
        '+++ b/a.ts',
        '@@ -10,3 +10,3 @@ function f()',
        ' keep',
        '-old',
        '+new',
        ' keep',
        '\\ No newline at end of file',
      ].join('\n'),
      100,
    );
    expect(diff.added).toBe(1);
    expect(diff.removed).toBe(1);
    expect(diff.hunks[0]!.lines.map((l) => [l.kind, l.old, l.new])).toEqual([
      ['context', 10, 10],
      ['del', 11, null],
      ['add', null, 11],
      ['context', 12, 12],
    ]);
  });

  it('reads renames, mode changes, binary files and the line cap', () => {
    const renamed = parseDiff(
      'diff --git a/x b/y\nold mode 100644\nnew mode 100755\nsimilarity index 100%\nrename from x\nrename to y\n',
      10,
    );
    expect(renamed.oldPath).toBe('x');
    expect(renamed.modeChange).toBe('100644 → 100755');
    expect(renamed.hunks).toEqual([]);
    expect(
      parseDiff('Binary files a/b.png and b/b.png differ\n', 10).binary,
    ).toBe(true);
    const capped = parseDiff('@@ -1,0 +1,3 @@\n+a\n+b\n+c\n', 2);
    expect(capped.truncated).toBe(true);
    expect(capped.hunks[0]!.lines).toHaveLength(2);
  });

  it('labels conflict markers in a combined diff', () => {
    const diff = parseDiff(
      [
        'diff --cc conflict.ts',
        '@@@ -1,1 -1,1 +1,5 @@@',
        '++<<<<<<< HEAD',
        ' +ours',
        '++=======',
        '+ theirs',
        '++>>>>>>> branch',
      ].join('\n'),
      100,
    );
    expect(diff.hunks[0]!.lines.map((l) => l.kind)).toEqual([
      'conflict',
      'add',
      'conflict',
      'add',
      'conflict',
    ]);
  });
});

describe('numstat and untracked files', () => {
  it('sums text changes and flags binary files', () => {
    expect(parseNumstat('3\t1\ta.ts\0')).toEqual({
      added: 3,
      removed: 1,
      binary: false,
    });
    expect(parseNumstat('-\t-\tb.png\0').binary).toBe(true);
  });

  it('turns a new file into one added hunk without its trailing newline', () => {
    const diff = untrackedDiff('one\r\ntwo\n', 10);
    expect(diff.added).toBe(2);
    expect(diff.hunks[0]!.lines.map((l) => l.text)).toEqual(['one', 'two']);
  });
});

describe('analytics', () => {
  const oid = (n: number) => String(n).padStart(40, '0');

  it('parses log numstat records, renames and binary files', () => {
    const output =
      `\x1e${oid(1)}\0${1_700_000_000}\0Ana\0ana@example.com\0\n1\t1\t\0old.ts\0new.ts\0-\t-\tlogo.png\0` +
      `\x1e${oid(2)}\0${1_699_000_000}\0Bo\0bo@example.com\0\n2\t0\ta.ts\0`;
    const entries = parseLogNumstat(output);
    expect(entries).toHaveLength(2);
    expect(entries[0]!.files).toEqual([
      { path: 'new.ts', added: 1, removed: 1 },
      { path: 'logo.png', added: null, removed: null },
    ]);
  });

  it('buckets by week or month and leaves huge changes out of line counts', () => {
    const now = new Date(2026, 9, 21, 12).getTime();
    expect(analyticsBuckets('12w', now).starts).toHaveLength(12);
    expect(analyticsBuckets('1y', now)).toMatchObject({ bucket: 'month' });
    const stats = aggregate(
      [
        {
          oid: oid(1),
          at: now - 3_600_000,
          author: 'Ana',
          email: 'ana@example.com',
          files: [
            { path: 'a.ts', added: 5, removed: 2 },
            { path: 'package-lock.json', added: 9000, removed: 10 },
          ],
        },
        {
          oid: oid(2),
          at: now - 86_400_000 * 400,
          author: 'Old',
          email: 'old@example.com',
          files: [],
        },
      ],
      {
        range: '4w',
        now,
        branch: 'main',
        headOid: oid(1),
        totalCommits: 2,
        truncated: false,
      },
    );
    expect(stats.commits).toBe(1);
    expect(stats.added).toBe(5);
    expect(stats.removed).toBe(2);
    expect(stats.skippedLarge).toEqual(['package-lock.json']);
    expect(stats.filesTouched).toBe(2);
    expect(stats.heat.flat().reduce((a, b) => a + b, 0)).toBe(1);
  });
});

describe('workspace paths', () => {
  it('accepts repository-relative paths and refuses escapes', () => {
    expect(repoPathSchema.safeParse('src/a b.ts').success).toBe(true);
    expect(repoPathSchema.safeParse('-dash.txt').success).toBe(true);
    for (const bad of [
      '../x',
      'a/../../x',
      '/etc/passwd',
      'C:\\Windows',
      'a\0b',
      '',
    ])
      expect(repoPathSchema.safeParse(bad).success).toBe(false);
  });

  it('skips noisy folders in the working-tree watcher', () => {
    expect(ignoredPath('/r', '/r/node_modules/x/index.js')).toBe(true);
    expect(ignoredPath('/r', '/r/.git/index')).toBe(true);
    expect(ignoredPath('/r', '/r/src/app.ts')).toBe(false);
    expect(ignoredPath('/r', '/r')).toBe(false);
  });
});
