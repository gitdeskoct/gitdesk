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

// One watcher for the repository whose workspace is open. Events are hints, never the truth:
// they only schedule a status check, debounced so an editor's burst of writes is one check.
export function createTreeWatcher(options: {
  onChange: (id: string) => void;
  onGone: (id: string) => void;
}) {
  let current: {
    id: string;
    root: string;
    watcher: FSWatcher;
    timer: NodeJS.Timeout | null;
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
      const entry = { id, root, watcher, timer: null as NodeJS.Timeout | null };
      current = entry;
      const schedule = () => {
        if (entry.timer) clearTimeout(entry.timer);
        entry.timer = setTimeout(() => {
          entry.timer = null;
          options.onChange(id);
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
        schedule();
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
