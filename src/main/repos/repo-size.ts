import { lstat, readdir } from 'node:fs/promises';
import path from 'node:path';
import type { RepoSize } from '../../shared/workspace';
import { gitAt } from './git-inspector';

// A huge tree (a monorepo with node_modules) must not keep main busy: the walk stops here and
// says its numbers are a lower bound.
const MAX_ENTRIES = 300_000;
const MAX_MS = 15_000;
const BATCH = 64;

type Walk = { bytes: number; files: number; truncated: boolean };

// Sums file sizes under `dir` without following symlinks, skipping the folders in `skip`.
export async function folderSize(
  dir: string,
  skip: Set<string>,
  deadline: number,
): Promise<Walk> {
  const walk: Walk = { bytes: 0, files: 0, truncated: false };
  const queue = [dir];
  let seen = 0;
  while (queue.length) {
    if (seen > MAX_ENTRIES || Date.now() > deadline) {
      walk.truncated = true;
      break;
    }
    const current = queue.pop()!;
    const entries = await readdir(current, { withFileTypes: true }).catch(
      () => [],
    );
    seen += entries.length;
    for (let i = 0; i < entries.length; i += BATCH) {
      await Promise.all(
        entries.slice(i, i + BATCH).map(async (entry) => {
          const full = path.join(current, entry.name);
          if (entry.isDirectory()) {
            if (!skip.has(path.resolve(full))) queue.push(full);
          } else if (entry.isFile()) {
            const info = await lstat(full).catch(() => null);
            if (info) {
              walk.bytes += info.size;
              walk.files++;
            }
          }
        }),
      );
    }
  }
  return walk;
}

// `git count-objects -v`: sizes are in KiB.
export function parseCountObjects(output: string) {
  const values: Record<string, number> = {};
  for (const line of output.split('\n')) {
    const [key, value] = line.split(':').map((part) => part.trim());
    if (key && value && /^\d+$/.test(value)) values[key] = Number(value);
  }
  return {
    loose: values.count ?? 0,
    packed: values['in-pack'] ?? 0,
    packs: values.packs ?? 0,
  };
}

// `git ls-tree -r -l -z HEAD`: "<mode> blob <oid> <size>\t<path>\0" per file.
export function parseTreeSizes(output: string) {
  const files: { path: string; bytes: number }[] = [];
  for (const record of output.split('\0')) {
    const match = /^\d+ blob [0-9a-f]+ +(\d+)\t(.+)$/s.exec(record);
    if (match)
      files.push({ path: match[2]!.slice(0, 4096), bytes: Number(match[1]) });
  }
  return files;
}

export async function measureRepository(
  root: string,
  now = Date.now,
): Promise<RepoSize> {
  const git = gitAt(root);
  const [dirs, count, tree] = await Promise.all([
    git
      .raw(['rev-parse', '--absolute-git-dir', '--git-common-dir'])
      .catch(() => ''),
    git.raw(['count-objects', '-v']).catch(() => ''),
    git.raw(['ls-tree', '-r', '-l', '-z', 'HEAD']).catch(() => ''),
  ]);
  const [own, common] = dirs.split('\n').map((line) => line.trim());
  const gitDirs = [own, common]
    .filter((dir): dir is string => !!dir)
    .map((dir) => path.resolve(root, dir));
  // The walk's time limit is wall-clock; `now` only stamps the result.
  const deadline = Date.now() + MAX_MS;
  const skip = new Set(gitDirs.map((dir) => path.resolve(dir)));
  // A linked worktree's .git is a file; its data lives in the common folder measured below.
  skip.add(path.resolve(root, '.git'));
  const working = await folderSize(root, skip, deadline);
  let gitBytes = 0;
  let truncated = working.truncated;
  for (const dir of new Set(gitDirs)) {
    const walk = await folderSize(dir, new Set(), deadline);
    gitBytes += walk.bytes;
    truncated ||= walk.truncated;
  }
  const files = parseTreeSizes(tree);
  const tracked = files.reduce((sum, file) => sum + file.bytes, 0);
  return {
    total: working.bytes + gitBytes,
    git: gitBytes,
    tracked,
    other: Math.max(0, working.bytes - tracked),
    trackedFiles: files.length,
    workingFiles: working.files,
    objects: parseCountObjects(count),
    largest: files.sort((a, b) => b.bytes - a.bytes).slice(0, 5),
    measuredAt: now(),
    truncated,
  };
}
