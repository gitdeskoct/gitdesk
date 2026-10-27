import type {
  AnalyticsRange,
  RepositoryAnalytics,
} from '../../shared/workspace';
import { weekStart } from './git-inspector';

export type LogEntry = {
  oid: string;
  at: number;
  author: string;
  email: string;
  files: { path: string; added: number | null; removed: number | null }[];
};

// `git log -z -M --numstat --format=%x1e%H%x00%ct%x00%an%x00%ae`. Each commit starts with \x1e; its
// numstat entries follow as "added\tremoved\tpath\0", or "added\tremoved\t\0old\0new\0" for a
// rename. Binary files report "-" for both counts.
export function parseLogNumstat(output: string): LogEntry[] {
  const entries: LogEntry[] = [];
  for (const record of output.split('\x1e')) {
    if (!record) continue;
    const tokens = record.split('\0');
    const [oid, ct, author, email] = tokens;
    if (!oid || !/^[0-9a-f]{40,64}$/.test(oid)) continue;
    const at = Number(ct) * 1000;
    if (!Number.isFinite(at) || at <= 0) continue;
    const files: LogEntry['files'] = [];
    for (let i = 4; i < tokens.length; i++) {
      const token = tokens[i]!.replace(/^\n+/, '');
      const match = /^(\d+|-)\t(\d+|-)\t(.*)$/s.exec(token);
      if (!match) continue;
      let path = match[3]!;
      if (path === '') {
        i++; // the old path of a rename; the new one names the file from here on
        path = tokens[++i] ?? '';
      }
      if (!path) continue;
      files.push({
        path: path.slice(0, 4096),
        added: match[1] === '-' ? null : Number(match[1]),
        removed: match[2] === '-' ? null : Number(match[2]),
      });
    }
    entries.push({
      oid,
      at,
      author: (author ?? '').slice(0, 100),
      email: (email ?? '').slice(0, 254),
      files,
    });
  }
  return entries;
}

// One change this large is usually a lockfile or generated output, which would drown the chart.
export const LARGE_CHANGE = 5000;

function monthStart(at: number): number {
  const day = new Date(at);
  return new Date(day.getFullYear(), day.getMonth(), 1).getTime();
}

// Bucket starts, oldest first: weeks (Monday, local time) for short ranges, months for long ones.
export function analyticsBuckets(
  range: AnalyticsRange,
  now: number,
): { bucket: 'week' | 'month'; starts: number[] } {
  const starts: number[] = [];
  if (range === '4w' || range === '12w') {
    const count = range === '4w' ? 4 : 12;
    for (let start = weekStart(now); starts.length < count;) {
      starts.unshift(start);
      const previous = new Date(start);
      previous.setDate(previous.getDate() - 7);
      start = previous.getTime();
    }
    return { bucket: 'week', starts };
  }
  const count = range === '6m' ? 6 : 12;
  const current = new Date(monthStart(now));
  for (let i = count - 1; i >= 0; i--)
    starts.push(
      new Date(current.getFullYear(), current.getMonth() - i, 1).getTime(),
    );
  return { bucket: 'month', starts };
}

export const rangeStart = (range: AnalyticsRange, now: number): number =>
  analyticsBuckets(range, now).starts[0]!;

export function aggregate(
  entries: LogEntry[],
  options: {
    range: AnalyticsRange;
    now: number;
    branch: string | null;
    headOid: string | null;
    totalCommits: number;
    truncated: boolean;
  },
): RepositoryAnalytics {
  const { bucket, starts } = analyticsBuckets(options.range, options.now);
  const since = starts[0]!;
  const buckets = starts.map((start) => ({
    start,
    commits: 0,
    added: 0,
    removed: 0,
  }));
  const heat = Array.from({ length: 7 }, () =>
    Array.from({ length: 24 }, () => 0),
  );
  const days = new Set<string>();
  const files = new Map<string, number>();
  // Keyed by email, so one person with two spellings of their name counts once.
  const authors = new Map<
    string,
    { name: string; email: string; commits: number }
  >();
  const skipped = new Set<string>();
  let commits = 0;
  let added = 0;
  let removed = 0;

  for (const entry of entries) {
    if (entry.at < since) continue;
    commits++;
    let index = buckets.length - 1;
    while (index > 0 && entry.at < buckets[index]!.start) index--;
    const target = buckets[index]!;
    target.commits++;
    const date = new Date(entry.at);
    heat[(date.getDay() + 6) % 7]![date.getHours()]!++;
    days.add(`${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`);
    const who = (entry.email || entry.author).toLowerCase();
    const known = authors.get(who);
    if (known) known.commits++;
    else
      authors.set(who, { name: entry.author, email: entry.email, commits: 1 });
    const seen = new Set<string>();
    for (const file of entry.files) {
      if (!seen.has(file.path)) {
        seen.add(file.path);
        files.set(file.path, (files.get(file.path) ?? 0) + 1);
      }
      if (file.added === null || file.removed === null) continue;
      if (file.added + file.removed > LARGE_CHANGE) {
        skipped.add(file.path);
        continue;
      }
      added += file.added;
      removed += file.removed;
      target.added += file.added;
      target.removed += file.removed;
    }
  }

  const top = <K>(map: Map<K, number>, count: number) =>
    [...map.entries()]
      .sort((a, b) => b[1] - a[1] || String(a[0]).localeCompare(String(b[0])))
      .slice(0, count);

  return {
    branch: options.branch,
    headOid: options.headOid,
    range: options.range,
    since,
    totalCommits: options.totalCommits,
    commits,
    activeDays: days.size,
    added,
    removed,
    filesTouched: files.size,
    bucket,
    buckets,
    heat,
    topFiles: top(files, 20).map(([path, count]) => ({ path, commits: count })),
    authors: [...authors.values()]
      .sort((a, b) => b.commits - a.commits || a.name.localeCompare(b.name))
      .slice(0, 10),
    truncated: options.truncated,
    skippedLarge: [...skipped].slice(0, 20),
  };
}
