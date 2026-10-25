import type { Stats } from 'node:fs';
import { lstat, realpath } from 'node:fs/promises';
import path from 'node:path';

// Windows also reaches .git through its 8.3 short name and drops trailing dots and spaces.
const GIT_DIR = /^(\.git|git~\d+)$/i;

export const isInside = (root: string, target: string): boolean => {
  const relative = path.relative(root, target);
  return (
    relative === '' ||
    (relative !== '..' &&
      !relative.startsWith(`..${path.sep}`) &&
      !path.isAbsolute(relative))
  );
};

export type Inside = { abs: string; stat: Stats | null };

// A repository-relative path as an absolute one that stays inside the repository, or null.
// Folders on the way are resolved through symlinks; the last part is never followed, so a
// symlink comes back as a symlink (stat from lstat) and the caller decides what to show.
// '' is the root itself. Anything inside .git is refused: its config and hooks aren't files to read.
export async function resolveInside(
  root: string,
  rel: string,
): Promise<Inside | null> {
  if (rel.includes('\0') || path.isAbsolute(rel) || /^[A-Za-z]:/.test(rel))
    return null;
  const segments = rel.split(/[\\/]/).filter((s) => s !== '' && s !== '.');
  if (
    segments.some(
      (s) =>
        s === '..' ||
        GIT_DIR.test(s.replace(/[. ]+$/, '')) ||
        (process.platform === 'win32' && s.includes(':')),
    )
  )
    return null;
  const realRoot = await realpath(root).catch(() => null);
  if (!realRoot) return null;
  const abs = path.resolve(root, ...segments);
  if (!segments.length)
    return { abs, stat: await lstat(abs).catch(() => null) };
  const parent = await realpath(path.dirname(abs)).catch(() => null);
  if (!parent || !isInside(realRoot, parent)) return null;
  return { abs, stat: await lstat(abs).catch(() => null) };
}
