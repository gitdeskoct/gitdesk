import { describe, expect, it } from 'vitest';
import { parseLastCommit, parseStatus } from './git-status';

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
    const status = parseStatus(z('# branch.oid (initial)', '# branch.head main'));
    expect(status.headOid).toBeNull();
    expect(status.ahead).toBeNull();
    expect(status.behind).toBeNull();
  });

  it('reports a detached HEAD without a branch name', () => {
    const status = parseStatus(z(`# branch.oid ${OID}`, '# branch.head (detached)'));
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
    expect(status).toMatchObject({ staged: 2, unstaged: 2, untracked: 1, conflicts: 1 });
    expect(status.files).toEqual([
      { path: 'src/staged.ts', kind: 'staged' },
      { path: 'src/edited file.ts', kind: 'modified' },
      { path: 'src/both.ts', kind: 'staged' },
      { path: 'src/both.ts', kind: 'modified' },
      { path: 'conflict.ts', kind: 'conflict' },
      { path: 'notes/new file.md', kind: 'untracked' },
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
    expect(status.files.map((f) => f.path)).toEqual(['new-name.ts', 'after.txt']);
  });

  it('caps the file list and says so', () => {
    const many = Array.from({ length: 600 }, (_, i) => `? file-${i}.txt`);
    const status = parseStatus(z(...many));
    expect(status.untracked).toBe(600);
    expect(status.files).toHaveLength(500);
    expect(status.truncated).toBe(true);
  });
});

describe('parseLastCommit', () => {
  it('splits hash, time and subject', () => {
    expect(parseLastCommit(`${OID}\u00001700000000\u0000Fix: a <b> & "c"\n`)).toEqual({
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
