import { describe, expect, it } from 'vitest';
import { parseLastCommit, parseNumstatAll, parseStatus } from './git-status';

const z = (...records: string[]) => records.join('\0') + '\0';
const OID = 'a'.repeat(40);

describe('parseStatus', () => {
  it('reads branch headers, upstream and ahead/behind', () => {
    const status = parseStatus(
      z(
        `# branch.oid ${OID}`,
        '# branch.head feature/read aloud',
        '# branch.upstream origin/feature/read aloud',
        '# branch.ab +2 -3',
      ),
    );
    expect(status).toMatchObject({
      headOid: OID,
      branch: 'feature/read aloud',
      detached: false,
      upstream: 'origin/feature/read aloud',
      ahead: 2,
      behind: 3,
      staged: 0,
      unstaged: 0,
    });
  });

  it('leaves ahead and behind unknown without an upstream', () => {
    const status = parseStatus(
      z('# branch.oid (initial)', '# branch.head main'),
    );
    expect(status.headOid).toBeNull();
    expect(status.ahead).toBeNull();
    expect(status.behind).toBeNull();
  });

  it('reports a detached HEAD without a branch name', () => {
    const status = parseStatus(
      z(`# branch.oid ${OID}`, '# branch.head (detached)'),
    );
    expect(status.detached).toBe(true);
    expect(status.branch).toBeNull();
  });

  it('counts staged, unstaged, untracked and conflicted entries separately', () => {
    const status = parseStatus(
      z(
        '# branch.head main',
        `1 M. N... 100644 100644 100644 ${OID} ${OID} src/staged.ts`,
        `1 .M N... 100644 100644 100644 ${OID} ${OID} src/edited file.ts`,
        `1 MM N... 100644 100644 100644 ${OID} ${OID} src/both.ts`,
        `u UU N... 100644 100644 100644 100644 ${OID} ${OID} ${OID} conflict.ts`,
        '? notes/new file.md',
        '! ignored.log',
      ),
    );
    expect(status).toMatchObject({
      staged: 2,
      unstaged: 2,
      untracked: 1,
      conflicts: 1,
    });
    expect(status.files).toMatchObject([
      { path: 'src/staged.ts', kind: 'staged', code: 'M' },
      { path: 'src/edited file.ts', kind: 'modified', code: 'M' },
      { path: 'src/both.ts', kind: 'staged', code: 'M' },
      { path: 'src/both.ts', kind: 'modified', code: 'M' },
      { path: 'conflict.ts', kind: 'conflict', code: 'U' },
      { path: 'notes/new file.md', kind: 'untracked', code: '?' },
    ]);
  });

  // Regression guard: with -z the old path of a rename is its own NUL field, not a new record.
  it('skips the original path that follows a rename record', () => {
    const status = parseStatus(
      z(
        `2 R. N... 100644 100644 100644 ${OID} ${OID} R100 new-name.ts`,
        '1 looks-like-a-record.ts',
        '? after.txt',
      ),
    );
    expect(status.staged).toBe(1);
    expect(status.untracked).toBe(1);
    expect(status.files.map((f) => f.path)).toEqual([
      'new-name.ts',
      'after.txt',
    ]);
    expect(status.files[0]?.origPath).toBe('1 looks-like-a-record.ts');
  });

  it('keeps full-length paths, unusual names and submodule entries', () => {
    const long = `${'deep/'.repeat(80)}file.ts`;
    const status = parseStatus(
      z(
        `1 .M N... 100644 100644 100644 ${OID} ${OID} ${long}`,
        `1 .M SC.. 160000 160000 160000 ${OID} ${OID} vendor/lib`,
        '? -leading dash ünïcode.txt',
      ),
    );
    expect(status.files[0]?.path).toBe(long);
    expect(status.files[1]).toMatchObject({
      path: 'vendor/lib',
      submodule: true,
    });
    expect(status.files[2]?.path).toBe('-leading dash ünïcode.txt');
  });

  it('caps the file list and says so', () => {
    const many = Array.from({ length: 600 }, (_, i) => `? file-${i}.txt`);
    const status = parseStatus(z(...many));
    expect(status.untracked).toBe(600);
    expect(status.files).toHaveLength(500);
    expect(status.truncated).toBe(true);
    expect(status.total).toBe(600);
  });

  it('takes a larger cap for the Changes list and counts every path', () => {
    const many = Array.from({ length: 6000 }, (_, i) => `? gen/${i}.js`);
    const status = parseStatus(z(...many), 5000);
    expect(status.files).toHaveLength(5000);
    expect(status.total).toBe(6000);
    expect(parseStatus(z('? one.txt'), 5000)).toMatchObject({
      truncated: false,
      total: 1,
    });
  });
});

describe('status details for the Changes list', () => {
  const H = 'b'.repeat(40);
  it('names conflict kinds, submodule state and mode changes per side', () => {
    const status = parseStatus(
      z(
        `u AU N... 000000 100644 100644 100644 ${H} ${H} ${H} added.txt`,
        `u UD N... 100644 100644 000000 100644 ${H} ${H} ${H} gone.txt`,
        `1 .M SCMU 160000 160000 160000 ${H} ${H} vendor/lib`,
        `1 M. N... 100644 100755 100755 ${H} ${H} run.sh`,
        `1 .M N... 100644 100644 100755 ${H} ${H} tool.sh`,
      ),
    );
    expect(status.files).toEqual([
      expect.objectContaining({
        path: 'added.txt',
        kind: 'conflict',
        conflict: 'added-by-us',
      }),
      expect.objectContaining({
        path: 'gone.txt',
        conflict: 'deleted-by-them',
      }),
      expect.objectContaining({
        path: 'vendor/lib',
        kind: 'modified',
        submodule: true,
        submoduleState: { commit: true, tracked: true, untracked: true },
      }),
      expect.objectContaining({
        path: 'run.sh',
        kind: 'staged',
        modeChange: '100644 → 100755',
      }),
      expect.objectContaining({
        path: 'tool.sh',
        kind: 'modified',
        modeChange: '100644 → 100755',
      }),
    ]);
  });

  it('caps by path, so both sides of one file stay', () => {
    const records = Array.from(
      { length: 501 },
      (_, i) => `1 MM N... 100644 100644 100644 ${H} ${H} f${i}.txt`,
    );
    const status = parseStatus(z(...records));
    expect(status.files).toHaveLength(1000);
    expect(status.truncated).toBe(true);
  });

  it('reads numstat counts, renames and binary files by path', () => {
    const counts = parseNumstatAll(
      '3\t1\ta.ts\u0000-\t-\tlogo.png\u00002\t0\t\u0000old.ts\u0000new.ts\u0000',
    );
    expect(counts.get('a.ts')).toEqual({ added: 3, removed: 1, binary: false });
    expect(counts.get('logo.png')).toEqual({
      added: 0,
      removed: 0,
      binary: true,
    });
    expect(counts.get('new.ts')).toEqual({
      added: 2,
      removed: 0,
      binary: false,
    });
  });
});

describe('parseLastCommit', () => {
  it('splits hash, time and subject', () => {
    expect(
      parseLastCommit(`${OID}\u00001700000000\u0000Fix: a <b> & "c"\n`),
    ).toEqual({
      oid: OID,
      at: 1_700_000_000_000,
      subject: 'Fix: a <b> & "c"',
    });
  });

  it('rejects anything that is not a commit line', () => {
    expect(parseLastCommit('')).toBeNull();
    expect(parseLastCommit('fatal: bad\u00001\u0000x')).toBeNull();
  });
});
