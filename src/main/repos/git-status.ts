import type { ChangedFile, ConflictKind, RepoStatus } from '../../shared/repos';

export type ParsedStatus = Omit<
  RepoStatus,
  'operation' | 'hasRemotes' | 'lastCommit'
> & { files: ChangedFile[]; truncated: boolean };

// Paths and branch names come from the repository, so they are capped and kept as plain text.
// Paths keep their full length: staging and diffs act on them, and a clipped path names nothing.
const MAX_FILES = 500;
const MAX_TEXT = 255;
const MAX_PATH = 4096;
const clip = (text: string) => text.slice(0, MAX_TEXT);

// Space-separated fields before the path in each porcelain v2 record type.
const FIELDS_BEFORE_PATH = { '1': 8, '2': 9, u: 10, '?': 1 } as const;

const CONFLICT_KINDS: Record<string, ConflictKind> = {
  UU: 'both-modified',
  AA: 'both-added',
  DD: 'both-deleted',
  AU: 'added-by-us',
  UA: 'added-by-them',
  DU: 'deleted-by-us',
  UD: 'deleted-by-them',
};

// 000000 means the path is absent on that side: an add or delete, not a mode change.
function modeChange(from: string, to: string): string | null {
  if (!/^[0-7]{6}$/.test(from) || !/^[0-7]{6}$/.test(to)) return null;
  if (from === to || from === '000000' || to === '000000') return null;
  return `${from} → ${to}`;
}

// `git diff --numstat -z`, per path: "added\tremoved\tpath\0", or "added\tremoved\t\0old\0new\0" for
// a rename. Binary files report "-" for both counts.
export function parseNumstatAll(
  output: string,
): Map<string, { added: number; removed: number; binary: boolean }> {
  const counts = new Map<
    string,
    { added: number; removed: number; binary: boolean }
  >();
  const fields = output.split('\0');
  for (let i = 0; i < fields.length; i++) {
    const match = /^\n?(\d+|-)\t(\d+|-)\t(.*)$/s.exec(fields[i]!);
    if (!match) continue;
    let path = match[3]!;
    if (!path) {
      i += 2;
      path = fields[i] ?? '';
    }
    if (!path) continue;
    counts.set(path, {
      added: match[1] === '-' ? 0 : Number(match[1]),
      removed: match[2] === '-' ? 0 : Number(match[2]),
      binary: match[1] === '-',
    });
  }
  return counts;
}

function pathOf(record: string, fields: number): string {
  let index = 0;
  for (let i = 0; i < fields; i++) {
    index = record.indexOf(' ', index) + 1;
    if (index === 0) return '';
  }
  return record.slice(index);
}

// Parses `git status --porcelain=v2 --branch -z`. With -z every record ends in NUL, and a
// rename or copy record ("2 ...") is followed by one more NUL-terminated field: the old path.
export function parseStatus(output: string): ParsedStatus {
  const status: ParsedStatus = {
    branch: null,
    detached: false,
    headOid: null,
    upstream: null,
    ahead: null,
    behind: null,
    staged: 0,
    unstaged: 0,
    untracked: 0,
    conflicts: 0,
    files: [],
    truncated: false,
  };
  const seen = new Set<string>();
  const add = (
    path: string,
    kind: ChangedFile['kind'],
    code: string,
    extra: Partial<ChangedFile> = {},
  ) => {
    if (path.length > MAX_PATH) return;
    // The cap counts paths, so a file with staged and unstaged edits keeps both of its rows.
    if (!seen.has(path) && seen.size >= MAX_FILES) {
      status.truncated = true;
      return;
    }
    seen.add(path);
    status.files.push({
      origPath: null,
      submodule: false,
      ...extra,
      path,
      kind,
      code,
    });
  };

  const records = output.split('\0');
  for (let i = 0; i < records.length; i++) {
    const record = records[i]!;
    if (!record) continue;

    if (record.startsWith('# ')) {
      const [key, ...rest] = record.slice(2).split(' ');
      const value = rest.join(' ');
      if (key === 'branch.oid')
        status.headOid = value === '(initial)' ? null : value.slice(0, 64);
      else if (key === 'branch.head') {
        status.detached = value === '(detached)';
        status.branch =
          value === '(detached)' || value === '(unknown)' ? null : clip(value);
      } else if (key === 'branch.upstream') status.upstream = clip(value);
      else if (key === 'branch.ab') {
        const match = /^\+(\d+) -(\d+)$/.exec(value);
        if (match) {
          status.ahead = Number(match[1]);
          status.behind = Number(match[2]);
        }
      }
      continue;
    }

    const type = record[0] as keyof typeof FIELDS_BEFORE_PATH | '!';
    if (type === '!') continue;
    if (type === '?') {
      status.untracked++;
      add(pathOf(record, FIELDS_BEFORE_PATH['?']), 'untracked', '?');
      continue;
    }
    if (type === 'u') {
      status.conflicts++;
      add(pathOf(record, FIELDS_BEFORE_PATH.u), 'conflict', 'U', {
        conflict: CONFLICT_KINDS[record.slice(2, 4)] ?? 'both-modified',
        submodule: record[5] === 'S',
      });
      continue;
    }
    if (type === '1' || type === '2') {
      const [x, y] = [record[2], record[3]];
      // "1 XY sub mH mI mW hH hI path": the modes are the 4th to 6th fields.
      const [, , sub = 'N...', mH = '', mI = '', mW = ''] = record.split(' ');
      const path = pathOf(record, FIELDS_BEFORE_PATH[type]);
      // The original path of a rename or copy is the next NUL-terminated field.
      const origPath = type === '2' ? (records[++i] ?? null) : null;
      const submodule = sub[0] === 'S';
      const submoduleState = submodule
        ? {
            commit: sub[1] === 'C',
            tracked: sub[2] === 'M',
            untracked: sub[3] === 'U',
          }
        : undefined;
      if (x && x !== '.') {
        status.staged++;
        add(path, 'staged', x, {
          origPath,
          submodule,
          submoduleState,
          modeChange: modeChange(mH, mI),
        });
      }
      if (y && y !== '.') {
        status.unstaged++;
        // A worktree-side rename (after `git add -N`) also names its old path.
        add(path, 'modified', y, {
          origPath: x === 'R' || x === 'C' ? null : origPath,
          submodule,
          submoduleState,
          modeChange: modeChange(mI, mW),
        });
      }
    }
  }
  return status;
}

export type StatusPath = {
  path: string;
  // Porcelain v2 letters, '.' for unchanged. Untracked is '?', a conflict is 'U' on both sides.
  x: string;
  y: string;
  submodule: boolean;
};

// Every path in `git status --porcelain=v2 -z`, without parseStatus's display cap: the Files tab
// marks folders by what is below them, so a cut-off list would leave folders unmarked.
export function parseStatusPaths(output: string, max = 200_000): StatusPath[] {
  const paths: StatusPath[] = [];
  const records = output.split('\0');
  for (let i = 0; i < records.length && paths.length < max; i++) {
    const record = records[i]!;
    const type = record[0];
    if (type === '?')
      paths.push({ path: pathOf(record, 1), x: '?', y: '?', submodule: false });
    else if (type === 'u')
      paths.push({
        path: pathOf(record, FIELDS_BEFORE_PATH.u),
        x: 'U',
        y: 'U',
        submodule: false,
      });
    else if ((type === '1' || type === '2') && record[1] === ' ') {
      paths.push({
        path: pathOf(record, FIELDS_BEFORE_PATH[type]),
        x: record[2] ?? '.',
        y: record[3] ?? '.',
        submodule: record.slice(5, 6) === 'S',
      });
      if (type === '2') i++;
    }
  }
  return paths.filter((p) => p.path && p.path.length <= MAX_PATH);
}

// `git log -1 --format=%H%x00%ct%x00%s`
export function parseLastCommit(output: string): RepoStatus['lastCommit'] {
  const [oid, seconds, ...subject] = output.replace(/\n$/, '').split('\0');
  if (!oid || !/^[0-9a-f]{7,64}$/.test(oid) || !seconds) return null;
  const at = Number(seconds) * 1000;
  if (!Number.isFinite(at)) return null;
  return { oid, at, subject: clip(subject.join(' ')) };
}
