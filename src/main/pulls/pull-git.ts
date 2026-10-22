import { createHash } from 'node:crypto';
import type {
  Comparison,
  ConflictFile,
  ConflictKind,
  Mergeability,
  MergeabilityReason,
  PullFile,
} from '../../shared/pulls';
import type { DiffResult } from '../../shared/workspace';
import { UserError } from '../errors';
import { parseDiff } from '../repos/git-diff';
import { describeGitError, gitAt } from '../repos/git-inspector';
import { parseCommitRows } from '../repos/workspace-service';

// Read-only Git for pull requests. Every ref is passed fully qualified after validation, and
// every argument is an array element: nothing from the renderer reaches a shell.

export class PullGitError extends UserError {}

const OID = /^[0-9a-f]{40,64}$/;
// Past these a comparison says it was cut, so one huge branch can't stall the review.
const MAX_COMMITS = 250;
const MAX_FILES = 3000;
const MAX_DIFF_CHANGES = 5000;
const MAX_LINES = 10_000;
const MAX_FULL_LINES = 50_000;
const MAX_SIDE_BYTES = 2 * 1024 * 1024;
const BASE_DIFF = [
  'diff',
  '--no-ext-diff',
  '--no-textconv',
  '--no-color',
  '-M',
];

async function raw(root: string, args: string[]): Promise<string> {
  try {
    return await gitAt(root).raw(args);
  } catch (err) {
    throw new PullGitError(describeGitError(err));
  }
}

// A local branch's commit, or null when the branch doesn't exist.
export async function resolveBranch(
  root: string,
  name: string,
): Promise<string | null> {
  const oid = (
    await gitAt(root)
      .raw([
        'rev-parse',
        '--verify',
        '--quiet',
        '--end-of-options',
        `refs/heads/${name}^{commit}`,
      ])
      .catch(() => '')
  ).trim();
  return OID.test(oid) ? oid : null;
}

export async function mergeBase(
  root: string,
  a: string,
  b: string,
): Promise<string | null> {
  const oid = (
    await gitAt(root)
      .raw(['merge-base', a, b])
      .catch(() => '')
  ).trim();
  return OID.test(oid) ? oid : null;
}

// simple-git resolves a non-zero exit that wrote nothing to stderr, so `--is-ancestor`'s exit code
// can't be read; `ancestor` is an ancestor exactly when it is the merge base.
export async function isAncestor(
  root: string,
  ancestor: string,
  of: string,
): Promise<boolean> {
  return (await mergeBase(root, ancestor, of)) === ancestor;
}

const STATUS: Record<string, PullFile['status']> = {
  A: 'added',
  M: 'modified',
  D: 'deleted',
  R: 'renamed',
  C: 'copied',
  T: 'type',
};

// `--name-status -z`: "M\0path\0", or "R100\0old\0new\0" for renames and copies.
export function parseNameStatus(
  output: string,
): Omit<PullFile, 'added' | 'removed' | 'binary'>[] {
  const fields = output.split('\0');
  const files: Omit<PullFile, 'added' | 'removed' | 'binary'>[] = [];
  for (let i = 0; i < fields.length; ) {
    const code = fields[i]?.trim() ?? '';
    const status = STATUS[code[0] ?? ''];
    if (!status) {
      i++;
      continue;
    }
    if (status === 'renamed' || status === 'copied') {
      files.push({
        status,
        oldPath: fields[i + 1] ?? null,
        path: fields[i + 2] ?? '',
      });
      i += 3;
    } else {
      files.push({ status, oldPath: null, path: fields[i + 1] ?? '' });
      i += 2;
    }
  }
  return files.filter((file) => file.path);
}

// `--numstat -z`: "a\tr\tpath\0", or "a\tr\t\0old\0new\0" for renames. "-" counts are binary.
export function parseNumstatFiles(
  output: string,
): Map<
  string,
  { added: number | null; removed: number | null; binary: boolean }
> {
  const fields = output.split('\0');
  const counts = new Map<
    string,
    { added: number | null; removed: number | null; binary: boolean }
  >();
  for (let i = 0; i < fields.length; i++) {
    const match = /^\n?(\d+|-)\t(\d+|-)\t(.*)$/s.exec(fields[i] ?? '');
    if (!match) continue;
    let path = match[3]!;
    if (!path) {
      path = fields[i + 2] ?? '';
      i += 2;
    }
    const binary = match[1] === '-';
    counts.set(path, {
      added: binary ? null : Number(match[1]),
      removed: binary ? null : Number(match[2]),
      binary,
    });
  }
  return counts;
}

// The changes the source brings since the merge base (the three-dot form `target...source`),
// and the commits `target..source`. null when the branches share no history.
export async function compare(
  root: string,
  targetOid: string,
  sourceOid: string,
): Promise<Comparison | null> {
  const base = await mergeBase(root, targetOid, sourceOid);
  if (!base) return null;
  const [log, names, numstat] = await Promise.all([
    raw(root, [
      'log',
      '--format=%H%x00%P%x00%an%x00%ae%x00%ct%x00%s%x00%D%x1e',
      `--max-count=${MAX_COMMITS + 1}`,
      `${targetOid}..${sourceOid}`,
      '--',
    ]),
    raw(root, [...BASE_DIFF, '--name-status', '-z', base, sourceOid, '--']),
    raw(root, [...BASE_DIFF, '--numstat', '-z', base, sourceOid, '--']),
  ]);
  const commits = parseCommitRows(log);
  const counts = parseNumstatFiles(numstat);
  const files = parseNameStatus(names).map((file) => ({
    ...file,
    ...(counts.get(file.path) ?? { added: null, removed: null, binary: false }),
  }));
  return {
    sourceOid,
    targetOid,
    mergeBaseOid: base,
    // Oldest first reads like the story of the branch.
    commits: commits.slice(0, MAX_COMMITS).reverse(),
    commitsTruncated: commits.length > MAX_COMMITS,
    files: files.slice(0, MAX_FILES),
    filesTruncated: files.length > MAX_FILES,
    added: files.reduce((sum, file) => sum + (file.added ?? 0), 0),
    removed: files.reduce((sum, file) => sum + (file.removed ?? 0), 0),
  };
}

// One file's diff between the merge base and the source, with the same size guard as Changes.
export async function fileDiff(
  root: string,
  input: {
    base: string;
    source: string;
    path: string;
    oldPath: string | null;
    context: number;
    ignoreWhitespace: boolean;
    full: boolean;
  },
): Promise<DiffResult> {
  const args = [...BASE_DIFF, ...(input.ignoreWhitespace ? ['-w'] : [])];
  const range = [input.base, input.source];
  const paths = ['--', input.path, ...(input.oldPath ? [input.oldPath] : [])];
  const counts = parseNumstatFiles(
    await raw(root, [...args, '--numstat', '-z', ...range, ...paths]),
  ).get(input.path);
  if (counts?.binary)
    return { status: 'binary', path: input.path, oldPath: input.oldPath };
  const changes = (counts?.added ?? 0) + (counts?.removed ?? 0);
  if (!input.full && changes > MAX_DIFF_CHANGES)
    return {
      status: 'too-large',
      path: input.path,
      added: counts?.added ?? 0,
      removed: counts?.removed ?? 0,
    };
  const parsed = parseDiff(
    await raw(root, [...args, `-U${input.context}`, ...range, ...paths]),
    input.full ? MAX_FULL_LINES : MAX_LINES,
  );
  if (parsed.binary)
    return { status: 'binary', path: input.path, oldPath: parsed.oldPath };
  if (!parsed.hunks.length)
    return { status: 'empty', path: input.path, modeChange: parsed.modeChange };
  return {
    status: 'text',
    path: input.path,
    oldPath: parsed.oldPath ?? input.oldPath,
    added: parsed.added,
    removed: parsed.removed,
    hunks: parsed.hunks,
    truncated: parsed.truncated,
    newFile: parsed.newFile,
    deleted: parsed.deleted,
    modeChange: parsed.modeChange,
  };
}

export const lineHash = (text: string) =>
  createHash('sha1').update(text).digest('hex');

let versionOk: Promise<boolean> | null = null;
// `merge-tree --write-tree` needs Git 2.38 or newer.
export function mergeTreeSupported(root: string): Promise<boolean> {
  versionOk ??= gitAt(root)
    .raw(['version'])
    .then((text) => {
      const [, major, minor] = /(\d+)\.(\d+)/.exec(text) ?? [];
      return Number(major) > 2 || (Number(major) === 2 && Number(minor) >= 38);
    })
    .catch(() => false);
  return versionOk;
}
// Tests reset the cached version check.
export const resetVersionCheck = () => {
  versionOk = null;
};

// `merge-tree --write-tree --name-only -z --messages` prints the tree, the conflicted paths, an
// empty field, then records of "<n>\0<path>...\0<type>\0<message>\0". A conflict is any record
// whose type starts with CONFLICT: per Git's docs the path list alone can miss some conflicts.
export function parseMergeTree(output: string): {
  conflicts: string[];
  conflicted: boolean;
} {
  const fields = output.split('\0');
  let i = 1;
  const conflicts: string[] = [];
  while (i < fields.length && fields[i] !== '') conflicts.push(fields[i++]!);
  i++;
  let conflicted = conflicts.length > 0;
  while (i < fields.length) {
    const count = Number(fields[i]);
    if (!Number.isInteger(count) || count < 0) break;
    const type = fields[i + count + 1] ?? '';
    if (type.startsWith('CONFLICT')) conflicted = true;
    i += count + 3;
  }
  return { conflicts: [...new Set(conflicts)], conflicted };
}

// A non-destructive check: no index, working tree or ref changes.
export async function checkMergeability(
  root: string,
  targetOid: string,
  sourceOid: string,
): Promise<{
  mergeability: Mergeability;
  reason: MergeabilityReason | null;
  conflicts: string[];
}> {
  if (!(await mergeTreeSupported(root)))
    return {
      mergeability: 'unavailable',
      reason: 'git-too-old',
      conflicts: [],
    };
  if (!(await mergeBase(root, targetOid, sourceOid)))
    return { mergeability: 'unavailable', reason: 'unrelated', conflicts: [] };
  try {
    const output = await gitAt(root, { timeoutMs: 60_000 }).raw([
      'merge-tree',
      '--write-tree',
      '--name-only',
      '-z',
      '--messages',
      targetOid,
      sourceOid,
    ]);
    const parsed = parseMergeTree(output);
    return parsed.conflicted
      ? {
          mergeability: 'conflicts',
          reason: null,
          conflicts: parsed.conflicts.slice(0, 200),
        }
      : { mergeability: 'mergeable', reason: null, conflicts: [] };
  } catch (err) {
    // Exit 1 with conflicts and no stderr comes back as output; anything that throws failed.
    const text = err instanceof Error ? err.message : String(err);
    if (/CONFLICT/.test(text)) {
      const parsed = parseMergeTree(text.slice(text.search(/[0-9a-f]{40}/)));
      return {
        mergeability: 'conflicts',
        reason: null,
        conflicts: parsed.conflicts,
      };
    }
    return { mergeability: 'unavailable', reason: 'failed', conflicts: [] };
  }
}

const KINDS: Record<string, ConflictKind> = {
  '123': 'both-modified',
  '23': 'both-added',
  '1': 'both-deleted',
  '13': 'deleted-by-target',
  '12': 'deleted-by-source',
  '2': 'added-by-target',
  '3': 'added-by-source',
};

// `ls-files -u -z`: "<mode> <oid> <stage>\t<path>\0" per stage. Stage 1 is the merge base, 2 the
// current branch (the target during a merge), 3 the branch being merged in (the source).
export async function unmergedFiles(root: string): Promise<ConflictFile[]> {
  const output = await raw(root, ['ls-files', '-u', '-z']);
  const stages = new Map<string, string[]>();
  for (const record of output.split('\0')) {
    const match = /^\d+ [0-9a-f]+ ([123])\t(.+)$/s.exec(record);
    if (!match) continue;
    const list = stages.get(match[2]!) ?? [];
    list.push(match[1]!);
    stages.set(match[2]!, list);
  }
  const files: ConflictFile[] = [];
  for (const [path, list] of stages) {
    const kind = KINDS[[...list].sort().join('')] ?? 'both-modified';
    const numstat = await raw(root, [
      ...BASE_DIFF,
      '--numstat',
      '-z',
      '--cached',
      'HEAD',
      '--',
      path,
    ]).catch(() => '');
    files.push({ path, kind, binary: /^-\t-\t/m.test(numstat) });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path));
}

// One stage of a conflicted path, or null when that side has no version (added or deleted).
export async function stageText(
  root: string,
  stage: 1 | 2 | 3,
  path: string,
): Promise<{ text: string | null; binary: boolean; tooLarge: boolean }> {
  const buffer = await gitAt(root)
    .raw(['cat-file', 'blob', `:${stage}:${path}`])
    .then(
      (text) => Buffer.from(text, 'utf8'),
      () => null,
    );
  if (!buffer) return { text: null, binary: false, tooLarge: false };
  if (buffer.length > MAX_SIDE_BYTES)
    return { text: null, binary: false, tooLarge: true };
  if (buffer.subarray(0, 8000).includes(0))
    return { text: null, binary: true, tooLarge: false };
  return { text: buffer.toString('utf8'), binary: false, tooLarge: false };
}

export async function gitPath(root: string, name: string): Promise<string> {
  return (await raw(root, ['rev-parse', '--git-path', name])).trim();
}
