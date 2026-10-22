import type { DiffHunk, DiffLine } from '../../shared/workspace';

export type ParsedDiff = {
  hunks: DiffHunk[];
  added: number;
  removed: number;
  binary: boolean;
  truncated: boolean;
  newFile: boolean;
  deleted: boolean;
  oldPath: string | null;
  modeChange: string | null;
};

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;
// Combined diffs of an unmerged file: one -range per parent, then the +range.
const COMBINED = /^(@@@+) (?:-\d+(?:,\d+)? )+\+(\d+)(?:,\d+)? @@@+(.*)$/;
const COMBINED_OLD = /-(\d+)/;
const MARKER = /^(<{7}|={7}|>{7}|\|{7})(\s|$)/;
const MAX_LINE = 2000;

// Parses `git diff --no-color` for one file. Line text is clipped, never interpreted: it is
// repository content and reaches the renderer as plain text only.
export function parseDiff(output: string, maxLines: number): ParsedDiff {
  const diff: ParsedDiff = {
    hunks: [],
    added: 0,
    removed: 0,
    binary: false,
    truncated: false,
    newFile: false,
    deleted: false,
    oldPath: null,
    modeChange: null,
  };
  let hunk: DiffHunk | null = null;
  let parents = 1;
  let oldLine = 0;
  let newLine = 0;
  let shown = 0;
  let oldMode: string | null = null;

  for (const raw of output.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;
    if (!hunk) {
      if (line.startsWith('Binary files ') || line === 'GIT binary patch')
        diff.binary = true;
      else if (line.startsWith('new file mode')) diff.newFile = true;
      else if (line.startsWith('deleted file mode')) diff.deleted = true;
      else if (line.startsWith('rename from ') || line.startsWith('copy from '))
        diff.oldPath = line.replace(/^(rename|copy) from /, '');
      else if (line.startsWith('old mode ')) oldMode = line.slice(9);
      else if (line.startsWith('new mode ') && oldMode)
        diff.modeChange = `${oldMode} → ${line.slice(9)}`;
    }
    const plain = HUNK.exec(line);
    const combined = plain ? null : COMBINED.exec(line);
    if (plain || combined) {
      parents = combined ? combined[1]!.length - 1 : 1;
      oldLine = Number(
        plain ? plain[1] : (COMBINED_OLD.exec(line)?.[1] ?? '0'),
      );
      newLine = Number(plain ? plain[2] : combined![2]);
      hunk = {
        header: line.slice(0, MAX_LINE),
        oldStart: oldLine,
        newStart: newLine,
        lines: [],
      };
      diff.hunks.push(hunk);
      continue;
    }
    if (!hunk || line.startsWith('\\')) continue;
    if (line.startsWith('diff --git') || line.startsWith('diff --cc')) {
      hunk = null;
      continue;
    }
    const prefix = line.slice(0, parents);
    const text = line.slice(parents).slice(0, MAX_LINE);
    let entry: DiffLine;
    if (prefix.includes('+')) {
      diff.added++;
      entry = {
        kind: MARKER.test(text) ? 'conflict' : 'add',
        old: null,
        new: newLine++,
        text,
      };
    } else if (prefix.includes('-')) {
      diff.removed++;
      entry = { kind: 'del', old: oldLine++, new: null, text };
    } else if (prefix.trim() === '' && line.length >= parents) {
      entry = {
        kind: MARKER.test(text) ? 'conflict' : 'context',
        old: oldLine++,
        new: newLine++,
        text,
      };
    } else continue;
    if (shown >= maxLines) {
      diff.truncated = true;
      continue;
    }
    shown++;
    hunk.lines.push(entry);
  }
  // An empty trailing hunk can be left by the cap; drop it so the view never shows a bare header.
  diff.hunks = diff.hunks.filter((h) => h.lines.length > 0);
  return diff;
}

// `git diff --numstat -z` for one path: "added\tremoved\tpath\0", or "-\t-\t..." for binary.
export function parseNumstat(output: string): {
  added: number;
  removed: number;
  binary: boolean;
} {
  let added = 0;
  let removed = 0;
  let binary = false;
  for (const record of output.split('\0')) {
    const match = /^\n?(\d+|-)\t(\d+|-)\t/.exec(record);
    if (!match) continue;
    if (match[1] === '-') binary = true;
    else {
      added += Number(match[1]);
      removed += Number(match[2]);
    }
  }
  return { added, removed, binary };
}

// An untracked file has no diff in Git, so its text becomes one all-added hunk.
export function untrackedDiff(
  text: string,
  maxLines: number,
): Pick<ParsedDiff, 'hunks' | 'added' | 'truncated'> {
  const lines = text.split('\n');
  if (lines.at(-1) === '') lines.pop();
  return {
    added: lines.length,
    truncated: lines.length > maxLines,
    hunks: lines.length
      ? [
          {
            header: `@@ -0,0 +1,${lines.length} @@`,
            oldStart: 0,
            newStart: 1,
            lines: lines.slice(0, maxLines).map((raw, index) => ({
              kind: 'add' as const,
              old: null,
              new: index + 1,
              text: (raw.endsWith('\r') ? raw.slice(0, -1) : raw).slice(
                0,
                MAX_LINE,
              ),
            })),
          },
        ]
      : [],
  };
}
