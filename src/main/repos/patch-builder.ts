// Builds the patch for part of one file's diff, so Git's own `git apply` does the staging. Patches
// are handled as latin1 strings: one char per byte, so the bytes Git wrote come back unchanged.

export type PatchLine = { op: ' ' | '+' | '-'; text: string; noEol: boolean };
export type PatchHunk = {
  oldStart: number;
  newStart: number;
  // Whatever follows the second @@, such as the function name.
  tail: string;
  lines: PatchLine[];
};
export type ParsedPatch = {
  // Git's own text, used as it is when everything is selected.
  text: string;
  header: string[];
  hunks: PatchHunk[];
  newFile: boolean;
  deleted: boolean;
  renamed: boolean;
};
export type Selection = { index: number; lines?: number[] }[];

const HUNK = /^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@(.*)$/;

// One file's `git diff` output. Line indexes match parseDiff's, which skips the same lines.
export function parsePatch(text: string): ParsedPatch | null {
  const patch: ParsedPatch = {
    text,
    header: [],
    hunks: [],
    newFile: false,
    deleted: false,
    renamed: false,
  };
  let hunk: PatchHunk | null = null;
  const rows = text.split('\n');
  if (rows.at(-1) === '') rows.pop();
  for (const row of rows) {
    const start = HUNK.exec(row.replace(/\r$/, ''));
    if (start) {
      hunk = {
        oldStart: Number(start[1]),
        newStart: Number(start[2]),
        tail: start[3] ?? '',
        lines: [],
      };
      patch.hunks.push(hunk);
      continue;
    }
    if (!hunk) {
      if (row.startsWith('diff --git') && patch.header.length) return null;
      patch.header.push(row);
      if (row.startsWith('new file mode')) patch.newFile = true;
      else if (row.startsWith('deleted file mode')) patch.deleted = true;
      else if (row.startsWith('rename from') || row.startsWith('copy from'))
        patch.renamed = true;
      continue;
    }
    if (row.startsWith('\\')) {
      const last = hunk.lines.at(-1);
      if (last) last.noEol = true;
      continue;
    }
    const op = row[0];
    if (op === ' ' || op === '+' || op === '-')
      hunk.lines.push({ op, text: row.slice(1), noEol: false });
    else if (row.startsWith('diff ')) return null;
  }
  return patch.header.length ? patch : null;
}

export type BuildResult =
  | { patch: string }
  | { refused: 'empty' | 'new-file' | 'deleted' | 'renamed' };

const changed = (line: PatchLine) => line.op !== ' ';

// `reverse` is for patches applied with -R (unstage from the index, discard from the working
// tree): their post-image must be what is there now, so unselected additions stay as context and
// unselected removals drop out. Forward patches (stage) keep the pre-image instead.
export function buildPatch(
  patch: ParsedPatch,
  selection: Selection,
  reverse: boolean,
): BuildResult {
  const wanted = new Map<number, Set<number> | null>();
  for (const pick of selection)
    wanted.set(pick.index, pick.lines ? new Set(pick.lines) : null);

  const whole = patch.hunks.every((hunk, index) => {
    if (!wanted.has(index)) return !hunk.lines.some(changed);
    const lines = wanted.get(index);
    return !lines || hunk.lines.every((l, i) => !changed(l) || lines.has(i));
  });
  // Everything selected: Git's own patch, mode changes and renames included.
  if (whole) {
    if (!patch.hunks.some((h) => h.lines.some(changed)))
      return { refused: 'empty' };
    return { patch: patch.text };
  }
  if (patch.renamed) return { refused: 'renamed' };
  if (patch.newFile && reverse) return { refused: 'new-file' };
  if (patch.deleted && reverse) return { refused: 'deleted' };

  const hunks: PatchHunk[] = [];
  let shift = 0;
  patch.hunks.forEach((hunk, index) => {
    if (!wanted.has(index)) return;
    const lines = wanted.get(index);
    const out: PatchLine[] = [];
    hunk.lines.forEach((line, i) => {
      const keep = line.op === ' ' || !lines || lines.has(i);
      if (keep) out.push(line);
      else if ((line.op === '-') !== reverse) out.push({ ...line, op: ' ' });
    });
    if (!out.some(changed)) return;
    const removed = out.filter((l) => l.op === '-').length;
    const added = out.filter((l) => l.op === '+').length;
    // Forward patches keep Git's old start; reverse ones keep its new start.
    hunks.push(
      reverse
        ? { ...hunk, oldStart: hunk.newStart - shift, lines: out }
        : { ...hunk, newStart: hunk.oldStart + shift, lines: out },
    );
    shift += added - removed;
  });
  if (!hunks.length) return { refused: 'empty' };
  return { patch: render(partialHeader(patch), hunks) };
}

// A partial patch changes content only: the blob ids no longer match, a mode change stays for a
// whole-file stage, and a partly staged deletion leaves the file in place.
function partialHeader(patch: ParsedPatch): string[] {
  const header = patch.header.filter(
    (row) =>
      !/^(index |old mode |new mode |similarity index |dissimilarity index |deleted file mode )/.test(
        row,
      ),
  );
  if (!patch.deleted) return header;
  const from = header.find((row) => row.startsWith('--- '));
  return header.map((row) =>
    row.startsWith('+++ ') && from
      ? `+++ ${from.slice(4).replace(/^("?)a\//, '$1b/')}`
      : row,
  );
}

function render(header: string[], hunks: PatchHunk[]): string {
  const out = [...header];
  for (const hunk of hunks) {
    const oldCount = hunk.lines.filter((l) => l.op !== '+').length;
    const newCount = hunk.lines.filter((l) => l.op !== '-').length;
    out.push(
      `@@ -${hunk.oldStart},${oldCount} +${hunk.newStart},${newCount} @@${hunk.tail}`,
    );
    for (const line of hunk.lines) {
      out.push(line.op + line.text);
      if (line.noEol) out.push('\\ No newline at end of file');
    }
  }
  return `${out.join('\n')}\n`;
}

// C-style quoting, as Git writes a path with quotes, backslashes or control characters.
export function quotePath(rel: string): string {
  // oxlint-disable-next-line no-control-regex
  if (!/["\\\x00-\x1f\x7f]/.test(rel)) return rel;
  const escaped = rel.replace(
    // oxlint-disable-next-line no-control-regex
    /["\\\x00-\x1f\x7f]/g,
    (c) =>
      ({ '"': '\\"', '\\': '\\\\', '\t': '\\t', '\n': '\\n', '\r': '\\r' })[
        c
      ] ?? `\\${c.charCodeAt(0).toString(8).padStart(3, '0')}`,
  );
  return `"${escaped}"`;
}

// An untracked file as the patch Git would write for adding it, so it can be staged in parts.
export function newFilePatch(
  rel: string,
  content: string,
  mode: string,
): string {
  const prefixed = (side: 'a' | 'b') => {
    const quoted = quotePath(rel);
    return quoted.startsWith('"')
      ? `"${side}/${quoted.slice(1)}`
      : `${side}/${quoted}`;
  };
  const lines = content.split('\n');
  const noEol = lines.at(-1) !== '';
  if (!noEol) lines.pop();
  const body = lines.map((line) => `+${line}`);
  if (noEol && body.length) body.push('\\ No newline at end of file');
  return [
    `diff --git ${prefixed('a')} ${prefixed('b')}`,
    `new file mode ${mode}`,
    '--- /dev/null',
    `+++ ${prefixed('b')}`,
    ...(lines.length ? [`@@ -0,0 +1,${lines.length} @@`, ...body] : []),
    '',
  ].join('\n');
}
