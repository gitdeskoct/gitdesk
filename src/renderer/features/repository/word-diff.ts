import type { DiffLine } from '../../../shared/workspace';

export type Range = [start: number, end: number];

const WORDS = /\w+|\s+|[^\w\s]/g;
// Past this many tokens a line is marked whole; a quadratic match there would cost more than it shows.
const MAX_TOKENS = 300;

// The parts of `a` and `b` that differ, as character ranges, from a longest-common-subsequence
// match over words, spaces and single symbols.
export function changedRanges(a: string, b: string): [Range[], Range[]] {
  const left = a.match(WORDS) ?? [];
  const right = b.match(WORDS) ?? [];
  if (left.length > MAX_TOKENS || right.length > MAX_TOKENS)
    return [a ? [[0, a.length]] : [], b ? [[0, b.length]] : []];
  const table = Array.from({ length: left.length + 1 }, () =>
    Array.from({ length: right.length + 1 }, () => 0),
  );
  for (let i = left.length - 1; i >= 0; i--)
    for (let j = right.length - 1; j >= 0; j--)
      table[i]![j] =
        left[i] === right[j]
          ? table[i + 1]![j + 1]! + 1
          : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
  const keepLeft = new Set<number>();
  const keepRight = new Set<number>();
  for (let i = 0, j = 0; i < left.length && j < right.length; ) {
    if (left[i] === right[j]) {
      keepLeft.add(i++);
      keepRight.add(j++);
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) i++;
    else j++;
  }
  const ranges = (tokens: string[], keep: Set<number>): Range[] => {
    const out: Range[] = [];
    let offset = 0;
    tokens.forEach((token, index) => {
      const end = offset + token.length;
      if (!keep.has(index) && token.trim()) {
        const last = out.at(-1);
        if (last && last[1] >= offset - 1) last[1] = end;
        else out.push([offset, end]);
      }
      offset = end;
    });
    return out;
  };
  return [ranges(left, keepLeft), ranges(right, keepRight)];
}

// Pairs each run of removed lines with the added lines that follow it, line by line, and returns
// the changed-word ranges keyed by the line's index in the hunk.
export function wordRanges(lines: DiffLine[]): Map<number, Range[]> {
  const result = new Map<number, Range[]>();
  for (let i = 0; i < lines.length; ) {
    if (lines[i]!.kind !== 'del') {
      i++;
      continue;
    }
    const dels: number[] = [];
    while (i < lines.length && lines[i]!.kind === 'del') dels.push(i++);
    const adds: number[] = [];
    while (i < lines.length && lines[i]!.kind === 'add') adds.push(i++);
    for (let k = 0; k < Math.min(dels.length, adds.length); k++) {
      const [del, add] = changedRanges(
        lines[dels[k]!]!.text,
        lines[adds[k]!]!.text,
      );
      // A line that changed almost entirely reads better without word marks.
      const covered = (ranges: Range[], text: string) =>
        ranges.reduce((sum, [s, e]) => sum + e - s, 0) /
        Math.max(1, text.length);
      if (covered(del, lines[dels[k]!]!.text) > 0.7) continue;
      result.set(dels[k]!, del);
      result.set(adds[k]!, add);
    }
  }
  return result;
}
