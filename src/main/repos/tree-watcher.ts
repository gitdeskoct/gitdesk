import path from 'node:path';
import { watch, type FSWatcher } from 'chokidar';

// Folders that change constantly and never hold source worth a status check. .git has its own
// watcher in repository-service; working-tree events only need the files a person edits.
const IGNORED_DIRS = new Set([
  '.git',
  'node_modules',
  '.vite',
  'dist',
  'out',
  'build',
  'target',
  '.next',
  '.turbo',
  'coverage',
  '.venv',
  '__pycache__',
]);

export function ignoredPath(root: string, file: string): boolean {
  const relative = path.relative(root, file);
  if (!relative) return false;
  return relative.split(/[\\/]/).some((part) => IGNORED_DIRS.has(part));
}

const DEBOUNCE_MS = 300;
// Past this many folders in one burst (a checkout, an install) the Files tab reloads everything.
const MAX_DIRS = 200;

// The repository-relative folder holding a changed path, with forward slashes; '' is the root.
export function changedDir(root: string, file: string): string | null {
  const relative = path.relative(root, path.dirname(file));
  if (relative.startsWith('..') || path.isAbsolute(relative)) return null;
  return relative.split(path.sep).join('/');
}

// One watcher for the repository whose workspace is open. Events are hints, never the truth:
// they only schedule a status check, debounced so an editor's burst of writes is one check.
// The folders touched in that burst go along, so the Files tab reloads only those.
export function createTreeWatcher(options: {
  onChange: (id: string, dirs: string[] | null) => void;
  onGone: (id: string) => void;
}) {
  let current: {
    id: string;
    root: string;
    watcher: FSWatcher;
    timer: NodeJS.Timeout | null;
    dirs: Set<string> | null;
  } | null = null;

  function stop(): void {
    if (!current) return;
    if (current.timer) clearTimeout(current.timer);
    void current.watcher.close().catch(() => undefined);
    current = null;
  }

  return {
    watch(id: string, root: string): void {
      if (current?.id === id && current.root === root) return;
      stop();
      const watcher = watch(root, {
        ignoreInitial: true,
        // A symlink to elsewhere is not followed, so watching never reaches outside the repository.
        followSymlinks: false,
        ignorePermissionErrors: true,
        persistent: false,
        ignored: (file) => ignoredPath(root, file),
      });
      const entry = {
        id,
        root,
        watcher,
        timer: null as NodeJS.Timeout | null,
        dirs: new Set<string>() as Set<string> | null,
      };
      current = entry;
      const schedule = (file: string) => {
        const dir = changedDir(root, file);
        if (entry.dirs && dir !== null) entry.dirs.add(dir);
        if (entry.dirs && entry.dirs.size > MAX_DIRS) entry.dirs = null;
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = null;
          const dirs = entry.dirs ? [...entry.dirs] : null;
          entry.dirs = new Set();
          options.onChange(id, dirs);
        }, DEBOUNCE_MS);
      };
      watcher.on('all', (event, file) => {
        if (
          event === 'unlinkDir' &&
          path.resolve(file) === path.resolve(root)
        ) {
          stop();
          options.onGone(id);
          return;
        }
        schedule(file);
      });
      watcher.on('error', () => {
        // Focus and interval checks still run; a broken watcher only loses the instant update.
        if (current === entry) stop();
        options.onGone(id);
      });
    },
    unwatch(id: string): void {
      if (current?.id === id) stop();
    },
    watching: (): string | null => current?.id ?? null,
    dispose: stop,
  };
}

export type TreeWatcher = ReturnType<typeof createTreeWatcher>;
