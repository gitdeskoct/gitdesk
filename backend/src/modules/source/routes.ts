import type { Context, Hono } from 'hono';
import { z } from 'zod';
import { getDb } from '../../db/client';
import type { AppEnv } from '../../env';
import { cursor, encodeCursor } from '../../lib/cursor';
import { ApiError } from '../../lib/errors';
import type { GitHost } from '../../lib/git-host';
import { validate } from '../../middleware/validate';
import { branchName } from '../pull-requests/schemas';
import { repositoryParams } from '../repositories/schemas';
import {
  branches,
  browsable,
  OID,
  PAGE,
  resolveRef,
  sortTree,
  toBase64,
  treeAt,
  viewBlob,
} from './source';

const MiB = 1024 * 1024;
const oid = z.string().regex(OID);

// Forward slashes only, no empty, "." or ".." segment, no .git folder: the walk follows tree
// entries by name, so this is about keeping requests honest, not about reaching storage keys.
const segmentOk = (s: string) =>
  s !== '' && s !== '.' && s !== '..' && s.replace(/[. ]+$/, '').toLowerCase() !== '.git';
const sourcePath = z
  .string()
  .min(1)
  .max(4096)
  .refine((p) => !p.includes('\0') && !p.includes('\\') && p.split('/').every(segmentOk));

const treeQuery = z.object({
  ref: z.union([oid, z.literal('HEAD'), branchName]),
  path: z.union([z.literal(''), sourcePath]).default(''),
  // The commit and folder are inside the cursor, so a second page can't come from another snapshot.
  cursor: cursor(z.tuple([oid, z.string().max(4096), z.number().int().min(0).max(10_000_000)])).optional(),
});
const blobParams = repositoryParams.extend({ oid });
const blobQuery = z.object({
  path: sourcePath,
  max: z.coerce.number().int().min(1).max(5).default(1),
  // The bytes as they are, for saving a copy: any kind of file up to 5 MB.
  raw: z.enum(['0', '1']).default('0'),
});

type GitHostFor = (env: CloudflareBindings) => GitHost | null;

// Mounted inside the repository routes, behind their requireAuth and per-account rate limit.
export function repositorySourceRoutes(
  app: Hono<AppEnv>,
  gitHost: GitHostFor,
  viaGitHost: <T>(c: Context<AppEnv>, work: () => Promise<T>) => Promise<T>,
) {
  async function open(c: Context<AppEnv>, id: string) {
    const git = gitHost(c.env);
    const repo = await browsable(getDb(c.env.DB), git, c.get('auth').accountId, id);
    // Missing and not-yours answer the same, so ids can't be probed.
    if (repo.status === 'not_found') throw new ApiError('NOT_FOUND', 'Not found.');
    if (repo.status === 'unavailable')
      throw new ApiError('GIT_HOSTING_UNAVAILABLE', 'Git hosting is not set up on this server.');
    if (repo.status === 'not_ready') throw new ApiError('INVALID_STATE', 'This repository is not ready yet.');
    return { git: git!, repo };
  }

  app.get('/:id/branches', validate('param', repositoryParams), async (c) => {
    const { git, repo } = await open(c, c.req.valid('param').id);
    const list = await viaGitHost(c, () => branches(getDb(c.env.DB), git, repo));
    return c.json({ defaultBranch: repo.defaultBranch, branches: list });
  });

  app.get('/:id/tree', validate('param', repositoryParams), validate('query', treeQuery), async (c) => {
    const { git, repo } = await open(c, c.req.valid('param').id);
    const query = c.req.valid('query');
    const [commit, path, offset] = query.cursor ?? [null, query.path, 0];
    const resolved = commit ?? (await viaGitHost(c, () => resolveRef(git, repo, query.ref)));
    if (!resolved) throw new ApiError('REF_NOT_FOUND', 'That branch or commit is not in this repository.');
    const entries = await viaGitHost(c, () => treeAt(git, repo.id, resolved, path));
    if (entries === 'ref') throw new ApiError('REF_NOT_FOUND', 'That commit is not in this repository.');
    if (entries === 'path') throw new ApiError('PATH_NOT_FOUND', 'That folder is not in this commit.');
    const sorted = sortTree(entries);
    const page = sorted.slice(offset, offset + PAGE);
    const end = offset + page.length;
    return c.json({
      commit: resolved,
      entries: page.map((e) => ({
        name: e.name,
        path: path ? `${path}/${e.name}` : e.name,
        type: e.type === 'tree' ? 'dir' : e.type === 'gitlink' ? 'submodule' : e.type === 'symlink' ? 'symlink' : 'file',
        oid: e.oid,
      })),
      nextCursor: end < sorted.length ? encodeCursor([resolved, path, end]) : null,
    });
  });

  app.get('/:id/blobs/:oid', validate('param', blobParams), validate('query', blobQuery), async (c) => {
    const params = c.req.valid('param');
    const { git, repo } = await open(c, params.id);
    const { path, max, raw } = c.req.valid('query');
    const limit = (raw === '1' ? 5 : max) * MiB;
    // The repository is the owner's own Artifacts repository, so an object id from anywhere else
    // simply isn't found here.
    const blob = await viaGitHost(c, () => git.readBlob(repo.id, params.oid, limit));
    if (!blob) throw new ApiError('PATH_NOT_FOUND', 'That file is not in this repository.');
    if (raw === '1')
      return c.json(
        blob.bytes
          ? { oid: params.oid, kind: 'raw', size: blob.bytes.length, base64: toBase64(blob.bytes) }
          : { oid: params.oid, kind: 'too-large', size: blob.size, limit },
      );
    return c.json({ oid: params.oid, ...viewBlob(blob, path, limit) });
  });

  app.get('/:id/commits/:oid', validate('param', blobParams), async (c) => {
    const params = c.req.valid('param');
    const { git, repo } = await open(c, params.id);
    const commit = await viaGitHost(c, () => git.readCommit(repo.id, params.oid));
    if (!commit) throw new ApiError('REF_NOT_FOUND', 'That commit is not in this repository.');
    return c.json({ commit: { ...commit, message: commit.message.slice(0, 2000) } });
  });
}
