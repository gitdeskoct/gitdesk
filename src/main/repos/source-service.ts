import { lstat, open, readdir, readlink } from 'node:fs/promises';
import path from 'node:path';
import { fileType, type FileIcon } from '../../shared/file-types';
import {
  mib,
  SOURCE_LIMITS,
  type SourceEntry,
  type SourceEntryType,
  type SourceFile,
  type SourceLastChange,
  type SourceListInput,
  type SourceListResult,
  type SourcePathsResult,
  type SourceReadInput,
  type SourceSnapshot,
  type SourceStats,
  type SourceStatus,
} from '../../shared/source';
import { UserError } from '../errors';
import { gitBytes } from './git-inspector';
import { parseStatusPaths, type StatusPath } from './git-status';
import { resolveInside } from './paths';
import { classify } from './source-classify';

export class SourceError extends UserError {}

const LIST_BYTES = 64 * 1024 * 1024;
const PATHS_TTL_MS = 15_000;
const MAX_PATHS = 200_000;

const join = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
const isGitDir = (name: string) =>
  /^(\.git|git~\d+)$/i.test(name.replace(/[. ]+$/, ''));

const CODE_LABELS: Record<string, string> = {
  M: 'M',
  A: 'A',
  D: 'D',
  R: 'R',
  C: 'C',
  T: 'T',
  U: 'U',
  '?': '?',
};

function statusOf(entry: StatusPath): SourceStatus {
  if (entry.x === '?')
    return { code: '?', kind: 'untracked', staged: false, unstaged: true };
  if (entry.x === 'U' || entry.y === 'U')
    return { code: 'U', kind: 'conflict', staged: false, unstaged: true };
  const staged = entry.x !== '.';
  const unstaged = entry.y !== '.';
  const letter = unstaged ? entry.y : entry.x;
  return {
    code: CODE_LABELS[letter] ?? 'M',
    kind: unstaged ? 'modified' : 'staged',
    staged,
    unstaged,
  };
}

export function sortEntries(
  entries: SourceEntry[],
  foldersFirst: boolean,
): SourceEntry[] {
  const folder = (e: SourceEntry) =>
    e.type === 'dir' || e.type === 'submodule' ? 0 : 1;
  return entries.sort(
    (a, b) =>
      (foldersFirst ? folder(a) - folder(b) : 0) ||
      a.name.localeCompare(b.name, undefined, {
        sensitivity: 'base',
        numeric: true,
      }) ||
      (a.name < b.name ? -1 : a.name > b.name ? 1 : 0),
  );
}

export function createSourceService(deps: {
  rootOf: (id: string) => string;
  showItemInFolder: (target: string) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const pathsCache = new Map<
    string,
    { at: number; paths: string[]; truncated: boolean }
  >();

  async function git(
    root: string,
    args: string[],
    options: {
      input?: string;
      maxBytes?: number;
      okCodes?: number[];
      literalPathspecs?: boolean;
    } = {},
  ): Promise<string> {
    const result = await gitBytes(root, args, {
      maxBytes: options.maxBytes ?? LIST_BYTES,
      input: options.input,
      timeoutMs: 30_000,
      literalPathspecs: options.literalPathspecs,
    });
    if (!(options.okCodes ?? [0]).includes(result.code ?? -1))
      throw new SourceError("Git couldn't read that. Refresh and try again.");
    return result.stdout.toString('utf8');
  }

  async function statusPaths(root: string, dir: string): Promise<StatusPath[]> {
    const output = await git(root, [
      'status',
      '--porcelain=v2',
      '-z',
      '--untracked-files=normal',
      '--ignored=no',
      ...(dir ? ['--', `${dir}/`] : []),
    ]);
    return parseStatusPaths(output);
  }

  // Paths ignored by .gitignore and friends. Tracked files are never reported, matching Git.
  async function ignoredOf(
    root: string,
    candidates: string[],
  ): Promise<Set<string>> {
    // A leading ':' would read as pathspec magic, which check-ignore rejects; such a name is
    // simply treated as not ignored.
    const asked = candidates.filter(
      (p) => !p.startsWith(':') && !p.includes('/:'),
    );
    if (!asked.length) return new Set();
    const output = await git(root, ['check-ignore', '-z', '--stdin'], {
      input: asked.join('\0') + '\0',
      okCodes: [0, 1],
      literalPathspecs: false,
    });
    return new Set(
      output
        .split('\0')
        .filter(Boolean)
        .map((p) => p.replace(/\/$/, '')),
    );
  }

  function decorate(
    entries: SourceEntry[],
    statuses: StatusPath[],
    onlyStaged: boolean,
  ): void {
    const byPath = new Map(statuses.map((s) => [s.path.replace(/\/$/, ''), s]));
    for (const entry of entries) {
      const exact = byPath.get(entry.path);
      if (exact && (!onlyStaged || (exact.x !== '.' && exact.x !== '?')))
        entry.status = statusOf(exact);
      if (entry.type === 'dir' || entry.type === 'submodule') {
        const prefix = `${entry.path}/`;
        entry.changes = statuses.some(
          (s) =>
            s.path.startsWith(prefix) &&
            (!onlyStaged || (s.x !== '.' && s.x !== '?')),
        );
      }
    }
  }

  function page(
    entries: SourceEntry[],
    input: SourceListInput,
  ): { slice: SourceEntry[]; total: number; nextOffset: number | null } {
    const sorted = sortEntries(entries, input.foldersFirst);
    const slice = sorted.slice(input.offset, input.offset + SOURCE_LIMITS.page);
    const end = input.offset + slice.length;
    return {
      slice,
      total: sorted.length,
      nextOffset: end < sorted.length ? end : null,
    };
  }

  async function listWorktree(
    root: string,
    input: SourceListInput,
  ): Promise<SourceListResult> {
    const dir = await resolveInside(root, input.path);
    if (!dir) throw new SourceError('That folder is outside the repository.');
    if (!dir.stat?.isDirectory())
      throw new SourceError(
        "That folder isn't there anymore. Refresh the list.",
      );
    const dirents = await readdir(dir.abs, { withFileTypes: true });
    const entries: SourceEntry[] = [];
    for (const d of dirents) {
      if (isGitDir(d.name)) continue;
      if (!input.showHidden && d.name.startsWith('.')) continue;
      const type: SourceEntryType = d.isSymbolicLink()
        ? 'symlink'
        : d.isDirectory()
          ? 'dir'
          : 'file';
      entries.push({
        name: d.name,
        path: join(input.path, d.name),
        type,
        size: null,
        oid: null,
        status: null,
        ignored: false,
        changes: false,
      });
    }
    // check-ignore also reports paths inside an ignored folder, and never a tracked file.
    const candidates = entries.map((e) =>
      e.type === 'dir' ? `${e.path}/` : e.path,
    );
    const [ignored, statuses] = await Promise.all([
      ignoredOf(root, candidates),
      statusPaths(root, input.path),
    ]);
    const kept = entries.filter((e) => {
      e.ignored = ignored.has(e.path);
      return input.showIgnored || !e.ignored;
    });
    const { slice, total, nextOffset } = page(kept, input);
    await Promise.all(
      slice.map(async (entry) => {
        const abs = path.join(dir.abs, entry.name);
        const info = await lstat(abs).catch(() => null);
        if (entry.type === 'file') entry.size = info?.size ?? null;
        if (entry.type === 'dir') {
          // A folder holding its own .git is another repository: a boundary, not a folder to walk.
          const nested = await lstat(path.join(abs, '.git')).catch(() => null);
          if (nested) entry.type = 'submodule';
        }
      }),
    );
    decorate(slice, statuses, false);
    // Git lists an untracked folder once ("dir/"), so everything inside it is untracked too.
    const prefix = `${input.path}/`;
    if (
      input.path &&
      statuses.some(
        (s) => s.x === '?' && s.path.endsWith('/') && prefix.startsWith(s.path),
      )
    )
      for (const entry of slice)
        if (!entry.ignored)
          entry.status = {
            code: '?',
            kind: 'untracked',
            staged: false,
            unstaged: true,
          };
    return { entries: slice, total, nextOffset };
  }

  async function listIndex(
    root: string,
    input: SourceListInput,
  ): Promise<SourceListResult> {
    const prefix = input.path ? `${input.path}/` : '';
    const output = await git(root, [
      'ls-files',
      '-s',
      '-z',
      '--full-name',
      ...(prefix ? ['--', prefix] : []),
    ]);
    const children = new Map<string, SourceEntry>();
    for (const record of output.split('\0')) {
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const [mode, oid] = record.slice(0, tab).split(' ');
      const full = record.slice(tab + 1);
      if (!full.startsWith(prefix)) continue;
      const rest = full.slice(prefix.length);
      const slash = rest.indexOf('/');
      const name = slash < 0 ? rest : rest.slice(0, slash);
      if (!name || children.has(name)) continue;
      if (!input.showHidden && name.startsWith('.')) continue;
      const type: SourceEntryType =
        slash >= 0
          ? 'dir'
          : mode === '160000'
            ? 'submodule'
            : mode === '120000'
              ? 'symlink'
              : 'file';
      children.set(name, {
        name,
        path: join(input.path, name),
        type,
        size: null,
        oid: type === 'dir' ? null : (oid ?? null),
        status: null,
        ignored: false,
        changes: false,
      });
    }
    const { slice, total, nextOffset } = page([...children.values()], input);
    const statuses = await statusPaths(root, input.path);
    decorate(slice, statuses, true);
    return { entries: slice, total, nextOffset };
  }

  async function listCommit(
    root: string,
    oid: string,
    input: SourceListInput,
  ): Promise<SourceListResult> {
    const result = await gitBytes(
      root,
      [
        'ls-tree',
        '-z',
        '-l',
        input.path ? `${oid}:${input.path}` : `${oid}^{tree}`,
      ],
      { maxBytes: LIST_BYTES, timeoutMs: 30_000 },
    );
    if (result.code !== 0)
      throw new SourceError(
        input.path
          ? `${input.path} isn't in this commit.`
          : "This commit isn't in the repository.",
      );
    const entries: SourceEntry[] = [];
    for (const record of result.stdout.toString('utf8').split('\0')) {
      const tab = record.indexOf('\t');
      if (tab < 0) continue;
      const [mode, kind, objectId, size] = record.slice(0, tab).split(/ +/);
      const name = record.slice(tab + 1);
      if (!input.showHidden && name.startsWith('.')) continue;
      const type: SourceEntryType =
        kind === 'tree'
          ? 'dir'
          : kind === 'commit'
            ? 'submodule'
            : mode === '120000'
              ? 'symlink'
              : 'file';
      entries.push({
        name,
        path: join(input.path, name),
        type,
        size: type === 'file' && size && size !== '-' ? Number(size) : null,
        oid: objectId ?? null,
        status: null,
        ignored: false,
        changes: false,
      });
    }
    const { slice, total, nextOffset } = page(entries, input);
    return { entries: slice, total, nextOffset };
  }

  // Where a file's bytes live in the index or a commit: mode and object id, or null when absent.
  async function objectOf(
    root: string,
    snapshot: Exclude<SourceSnapshot, { kind: 'worktree' }>,
    file: string,
  ): Promise<{ mode: string; oid: string } | null> {
    const output =
      snapshot.kind === 'index'
        ? await git(root, ['ls-files', '-s', '-z', '--full-name', '--', file])
        : await git(root, ['ls-tree', '-z', snapshot.oid, '--', file]);
    for (const record of output.split('\0')) {
      const tab = record.indexOf('\t');
      if (tab < 0 || record.slice(tab + 1) !== file) continue;
      const fields = record.slice(0, tab).split(' ');
      const mode = fields[0]!;
      if (snapshot.kind === 'commit' && fields[1] === 'tree') return null;
      const oid = snapshot.kind === 'index' ? fields[1] : fields[2];
      if (oid && /^[0-9a-f]{40,64}$/.test(oid)) return { mode, oid };
    }
    return null;
  }

  async function readBlob(
    root: string,
    oid: string,
    file: string,
    limit: number,
    canGrow: boolean,
  ): Promise<SourceFile> {
    const size = Number((await git(root, ['cat-file', '-s', oid])).trim());
    if (!Number.isFinite(size)) return { kind: 'missing' };
    const imageFits = classifyImageFirst(file, size);
    if (size > limit && !imageFits)
      return {
        kind: 'too-large',
        size,
        limit,
        canForce: canGrow && size <= SOURCE_LIMITS.maxText,
      };
    const bytes = (
      await gitBytes(root, ['cat-file', 'blob', oid], {
        maxBytes: Math.max(limit, SOURCE_LIMITS.maxImage) + 1,
      })
    ).stdout;
    return classify(bytes, file, oid, SOURCE_LIMITS.maxImage);
  }

  const classifyImageFirst = (file: string, size: number) =>
    fileType(file).icon === 'image' && size <= SOURCE_LIMITS.maxImage;

  async function read(input: SourceReadInput): Promise<SourceFile> {
    const root = deps.rootOf(input.id);
    const limit = input.force ? SOURCE_LIMITS.maxText : mib(input.limitMiB);
    const canGrow = !input.force;
    if (input.snapshot.kind !== 'worktree') {
      const object = await objectOf(root, input.snapshot, input.path);
      if (!object) return { kind: 'missing' };
      if (object.mode === '160000')
        return { kind: 'submodule', oid: object.oid };
      if (object.mode === '120000') {
        const target = await git(root, ['cat-file', 'blob', object.oid], {
          maxBytes: 4096,
        });
        return { kind: 'symlink', target };
      }
      return readBlob(root, object.oid, input.path, limit, canGrow);
    }
    const inside = await resolveInside(root, input.path);
    if (!inside) throw new SourceError('That file is outside the repository.');
    const info = inside.stat;
    if (!info) return { kind: 'missing' };
    if (info.isSymbolicLink())
      return { kind: 'symlink', target: await readlink(inside.abs) };
    if (info.isDirectory()) {
      const nested = await lstat(path.join(inside.abs, '.git')).catch(
        () => null,
      );
      return nested ? { kind: 'submodule', oid: null } : { kind: 'missing' };
    }
    if (!info.isFile())
      return { kind: 'binary', size: info.size, reason: 'binary' };
    if (info.size > limit && !classifyImageFirst(input.path, info.size))
      return {
        kind: 'too-large',
        size: info.size,
        limit,
        canForce: canGrow && info.size <= SOURCE_LIMITS.maxText,
      };
    // A bounded read of what lstat promised: a file that grew meanwhile is cut, never unbounded.
    const handle = await open(inside.abs, 'r');
    try {
      const length = Math.min(
        info.size,
        Math.max(limit, SOURCE_LIMITS.maxImage),
      );
      const buffer = Buffer.alloc(length);
      const { bytesRead } = await handle.read(buffer, 0, length, 0);
      return classify(
        buffer.subarray(0, bytesRead),
        input.path,
        null,
        SOURCE_LIMITS.maxImage,
      );
    } finally {
      await handle.close();
    }
  }

  async function allPaths(id: string, root: string) {
    const cached = pathsCache.get(id);
    if (cached && now() - cached.at < PATHS_TTL_MS) return cached;
    const output = await git(root, [
      'ls-files',
      '-z',
      '--cached',
      '--others',
      '--exclude-standard',
      '--full-name',
    ]);
    const all = [...new Set(output.split('\0').filter(Boolean))];
    const fresh = {
      at: now(),
      paths: all.slice(0, MAX_PATHS),
      truncated: all.length > MAX_PATHS,
    };
    pathsCache.set(id, fresh);
    return fresh;
  }

  return {
    read,

    async list(input: SourceListInput): Promise<SourceListResult> {
      const root = deps.rootOf(input.id);
      if (input.snapshot.kind === 'worktree') return listWorktree(root, input);
      if (input.snapshot.kind === 'index') return listIndex(root, input);
      return listCommit(root, input.snapshot.oid, input);
    },

    async resolve(input: {
      id: string;
      ref: string;
    }): Promise<{ oid: string }> {
      const root = deps.rootOf(input.id);
      const output = await gitBytes(
        root,
        [
          'rev-parse',
          '--verify',
          '--quiet',
          '--end-of-options',
          `${input.ref}^{commit}`,
        ],
        { maxBytes: 4096 },
      );
      const oid = output.stdout.toString('utf8').trim();
      if (output.code !== 0 || !/^[0-9a-f]{40,64}$/.test(oid))
        throw new SourceError(`${input.ref} isn't in this repository.`);
      return { oid };
    },

    async paths(input: {
      id: string;
      query: string;
    }): Promise<SourcePathsResult> {
      const root = deps.rootOf(input.id);
      const { paths, truncated } = await allPaths(input.id, root);
      const query = input.query.trim().toLowerCase();
      const rank = (p: string): number => {
        const lower = p.toLowerCase();
        const base = lower.slice(lower.lastIndexOf('/') + 1);
        if (base.startsWith(query)) return 0;
        if (base.includes(query)) return 1;
        return lower.includes(query) ? 2 : -1;
      };
      const ranked = paths
        .map((p) => ({ p, r: rank(p) }))
        .filter((m) => m.r >= 0)
        .sort(
          (a, b) =>
            a.r - b.r || a.p.length - b.p.length || (a.p < b.p ? -1 : 1),
        );
      return {
        matches: ranked.slice(0, SOURCE_LIMITS.pathMatches).map((m) => m.p),
        total: ranked.length,
        truncated,
      };
    },

    async lastChange(input: {
      id: string;
      snapshot: SourceSnapshot;
      path: string;
    }): Promise<SourceLastChange> {
      const root = deps.rootOf(input.id);
      const rev =
        input.snapshot.kind === 'commit' ? input.snapshot.oid : 'HEAD';
      const result = await gitBytes(
        root,
        [
          'log',
          '-1',
          '--no-color',
          '--format=%H%x00%an%x00%at%x00%s',
          rev,
          '--',
          input.path,
        ],
        { maxBytes: 64 * 1024, timeoutMs: 5_000 },
      ).catch(() => null);
      if (!result || result.code !== 0) return null;
      const [oid, author, seconds, ...subject] = result.stdout
        .toString('utf8')
        .replace(/\n$/, '')
        .split('\0');
      if (!oid || !/^[0-9a-f]{40,64}$/.test(oid)) return null;
      return {
        oid,
        author: (author ?? '').slice(0, 200),
        at: Number(seconds) * 1000,
        subject: subject.join(' ').slice(0, 500),
      };
    },

    async reveal(input: { id: string; path: string }): Promise<void> {
      const root = deps.rootOf(input.id);
      const inside = await resolveInside(root, input.path);
      if (!inside)
        throw new SourceError('That file is outside the repository.');
      if (!inside.stat) throw new SourceError("That file isn't there anymore.");
      deps.showItemInFolder(inside.abs);
    },

    async stats(id: string): Promise<SourceStats> {
      const root = deps.rootOf(id);
      const [tracked, statuses] = await Promise.all([
        git(root, ['ls-files', '-z', '--full-name']),
        statusPaths(root, ''),
      ]);
      const files = tracked.split('\0').filter(Boolean);
      const dirs = new Set<string>();
      // Each kind shows the tree icon most of its files have, so TypeScript is code, not a test.
      const counts = new Map<
        string,
        { count: number; icons: Map<FileIcon, number> }
      >();
      for (const file of files.slice(0, MAX_PATHS)) {
        for (let i = file.indexOf('/'); i >= 0; i = file.indexOf('/', i + 1))
          dirs.add(file.slice(0, i));
        const { label, icon } = fileType(file);
        const kind = counts.get(label) ?? { count: 0, icons: new Map() };
        kind.count++;
        kind.icons.set(icon, (kind.icons.get(icon) ?? 0) + 1);
        counts.set(label, kind);
      }
      const sorted = [...counts].sort(
        (a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1),
      );
      const top = sorted.slice(0, 6).map(([label, { count, icons }]) => ({
        label,
        count,
        icon: [...icons].sort((a, b) => b[1] - a[1])[0]![0],
      }));
      const other = sorted
        .slice(6)
        .reduce((sum, [, { count }]) => sum + count, 0);
      return {
        files: files.length,
        dirs: dirs.size,
        changed: statuses.length,
        groups: other
          ? [...top, { label: 'Other', count: other, icon: 'file' as const }]
          : top,
        truncated: files.length > MAX_PATHS,
        countedAt: now(),
      };
    },

    // A watched change can add or remove paths, so the search list is read again next time.
    invalidate(id: string): void {
      pathsCache.delete(id);
    },
  };
}

export type SourceService = ReturnType<typeof createSourceService>;
