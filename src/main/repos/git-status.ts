import type { ChangedFile, RepoStatus } from '../../shared/repos';

export type ParsedStatus = Omit<
  RepoStatus,
  'operation' | 'hasRemotes' | 'lastCommit'
> & { files: ChangedFile[]; truncated: boolean };

// Paths and branch names come from the repository, so they are capped and kept as plain text.
const MAX_FILES = 500;
const MAX_TEXT = 255;
const clip = (text: string) => text.slice(0, MAX_TEXT);

// Space-separated fields before the path in each porcelain v2 record type.
const FIELDS_BEFORE_PATH = { '1': 8, '2': 9, u: 10, '?': 1 } as const;

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
  const add = (path: string, kind: ChangedFile['kind']) => {
    if (status.files.length < MAX_FILES)
      status.files.push({ path: clip(path), kind });
    else status.truncated = true;
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
      add(pathOf(record, FIELDS_BEFORE_PATH['?']), 'untracked');
      continue;
    }
    if (type === 'u') {
      status.conflicts++;
      add(pathOf(record, FIELDS_BEFORE_PATH.u), 'conflict');
      continue;
    }
    if (type === '1' || type === '2') {
      const [x, y] = [record[2], record[3]];
      const path = pathOf(record, FIELDS_BEFORE_PATH[type]);
      if (x && x !== '.') {
        status.staged++;
        add(path, 'staged');
      }
      if (y && y !== '.') {
        status.unstaged++;
        add(path, 'modified');
      }
      if (type === '2') i++; // skip the original path of the rename or copy
    }
  }
  return status;
}

// `git log -1 --format=%H%x00%ct%x00%s`
export function parseLastCommit(output: string): RepoStatus['lastCommit'] {
  const [oid, seconds, ...subject] = output.replace(/\n$/, '').split('\0');
  if (!oid || !/^[0-9a-f]{7,64}$/.test(oid) || !seconds) return null;
  const at = Number(seconds) * 1000;
  if (!Number.isFinite(at)) return null;
  return { oid, at, subject: clip(subject.join(' ')) };
}
