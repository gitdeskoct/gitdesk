import { and, desc, eq, isNull } from 'drizzle-orm';
import type { Db } from '../../db/client';
import { repositories, repositoryBranches } from '../../db/schema';
import type { GitHost, HostTreeEntry } from '../../lib/git-host';

// Browsing a hosted repository's files: one folder or one file at a time, always from one
// commit. A branch name is resolved once; the desktop then asks by that commit id, so a push in
// the middle of browsing can't mix two snapshots.
export const OID = /^[0-9a-f]{40,64}$/;
export const PAGE = 500;
// The Workers free plan allows 50 subrequests per request, so branch tips are capped well under it.
const MAX_BRANCHES = 20;
const MAX_DEPTH = 64;
export const IMAGE_MAX = 1024 * 1024;

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  svg: 'image/svg+xml',
};

export type Browsable =
  | { status: 'ok'; id: string; defaultBranch: string }
  | { status: 'not_found' }
  | { status: 'not_ready' }
  | { status: 'unavailable' };

export async function browsable(
  db: Db,
  git: GitHost | null,
  accountId: string,
  id: string,
): Promise<Browsable> {
  const [row] = await db
    .select()
    .from(repositories)
    .where(and(eq(repositories.id, id), eq(repositories.ownerAccountId, accountId)))
    .limit(1);
  if (!row) return { status: 'not_found' };
  if (!git) return { status: 'unavailable' };
  if (row.status !== 'ready' || !row.gitRemote) return { status: 'not_ready' };
  return { status: 'ok', id: row.id, defaultBranch: row.defaultBranch };
}

// A commit id, or the commit a branch (HEAD means the default branch) points at now.
export async function resolveRef(
  git: GitHost,
  repo: { id: string; defaultBranch: string },
  ref: string,
): Promise<string | null> {
  if (OID.test(ref)) return (await git.readCommit(repo.id, ref)) ? ref : null;
  const branch = ref === 'HEAD' ? repo.defaultBranch : ref;
  return git.tip(repo.id, `refs/heads/${branch}`);
}

export async function branches(
  db: Db,
  git: GitHost,
  repo: { id: string; defaultBranch: string },
): Promise<{ name: string; oid: string }[]> {
  // Artifacts can't list refs, so the branches are the default one plus the confirmed branch index,
  // most recently updated first, and each name is still checked against its real tip.
  const known = await db
    .select({ name: repositoryBranches.name })
    .from(repositoryBranches)
    .where(and(eq(repositoryBranches.repositoryId, repo.id), isNull(repositoryBranches.deletedAt)))
    .orderBy(desc(repositoryBranches.updatedAt))
    .limit(MAX_BRANCHES);
  const names = [
    repo.defaultBranch,
    ...known.map((b) => b.name).filter((n) => n !== repo.defaultBranch),
  ].slice(0, MAX_BRANCHES);
  const tips = await Promise.all(names.map((name) => git.tip(repo.id, `refs/heads/${name}`)));
  return names
    .map((name, i) => ({ name, oid: tips[i] }))
    .filter((b): b is { name: string; oid: string } => !!b.oid)
    .sort((a, b) => (a.name === repo.defaultBranch ? -1 : b.name === repo.defaultBranch ? 1 : a.name.localeCompare(b.name)));
}

// The entries of `path` in that commit, walking one tree per folder: 'ref' when the commit
// is gone, 'path' when a folder on the way isn't there.
export async function treeAt(
  git: GitHost,
  repoId: string,
  commit: string,
  path: string,
): Promise<HostTreeEntry[] | 'ref' | 'path'> {
  const meta = await git.readCommit(repoId, commit);
  if (!meta) return 'ref';
  const segments = path ? path.split('/') : [];
  if (segments.length > MAX_DEPTH) return 'path';
  let tree = meta.treeOid;
  for (const segment of segments) {
    const entries = await git.readTree(repoId, tree);
    const next = entries?.find((e) => e.name === segment && e.type === 'tree');
    if (!next) return 'path';
    tree = next.oid;
  }
  return (await git.readTree(repoId, tree)) ?? 'path';
}

const folder = (e: HostTreeEntry) => (e.type === 'tree' || e.type === 'gitlink' ? 0 : 1);

// The same order as the desktop's own listing: folders first, then names as people sort them.
export function sortTree(entries: HostTreeEntry[]): HostTreeEntry[] {
  return [...entries].sort(
    (a, b) =>
      folder(a) - folder(b) ||
      a.name.localeCompare(b.name, undefined, { sensitivity: 'base', numeric: true }) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

export const toBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(binary);
};

export type BlobView =
  | { kind: 'text'; size: number; text: string }
  | { kind: 'image'; size: number; mime: string; base64: string }
  | { kind: 'binary'; size: number; reason: 'binary' | 'encoding' }
  | { kind: 'too-large'; size: number | null; limit: number };

// How the desktop shows a blob, decided the same way it decides for local files: a NUL in the
// first 8000 bytes is binary, invalid UTF-8 is binary, images under 1 MB come as base64.
export function viewBlob(
  blob: { size: number | null; bytes: Uint8Array | null },
  path: string,
  limit: number,
): BlobView {
  const ext = path.includes('.') ? path.slice(path.lastIndexOf('.') + 1).toLowerCase() : '';
  const mime = IMAGE_MIME[ext];
  const { size, bytes } = blob;
  if (mime && bytes && bytes.length <= IMAGE_MAX)
    return { kind: 'image', size: bytes.length, mime, base64: toBase64(bytes) };
  if (!bytes || size === null || size > limit) return { kind: 'too-large', size, limit };
  if (bytes.subarray(0, 8000).includes(0)) return { kind: 'binary', size, reason: 'binary' };
  try {
    return { kind: 'text', size, text: new TextDecoder('utf-8', { fatal: true, ignoreBOM: false }).decode(bytes) };
  } catch {
    return { kind: 'binary', size, reason: 'encoding' };
  }
}
