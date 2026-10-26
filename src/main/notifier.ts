import type { AppNotice, TestNotificationResult } from '../shared/ipc';
import type { Settings } from '../shared/settings';

// What the notifier needs from Electron, injected so tests can run without it.
export type NotificationSink = {
  isSupported(): boolean;
  // Shows a system notification; onClick fires if the person clicks it.
  show(notice: { title: string; body: string }, onClick: () => void): void;
};

export type NoticeKind = 'clone' | 'problem' | 'update' | 'test';

const REPEAT_GAP_MS = 60_000;
// Windows and macOS truncate long notifications; keep both lines short and whole.
const clip = (text: string, max: number) =>
  text.length > max ? `${text.slice(0, max - 1)}…` : text;

// One rule decides where news goes: a system notification while gitdesk is in the background,
// a toast in the window while it is in front. The same notice is never sent twice in a minute.
export function createNotifier(deps: {
  settings: () => Settings;
  isFocused: () => boolean;
  sink: NotificationSink;
  // Shows a toast in the window.
  toWindow: (notice: AppNotice) => void;
  // A system notification was clicked: bring gitdesk forward, and open the repository if any.
  onClick: (repositoryId: string | null) => void;
  now?: () => number;
}) {
  const now = deps.now ?? Date.now;
  const lastSent = new Map<string, number>();

  function allowed(kind: NoticeKind): boolean {
    const s = deps.settings();
    if (kind === 'test') return true;
    if (!s.notifications) return false;
    if (kind === 'update') return true;
    return kind === 'clone' ? s.notifyClone : s.notifyProblems;
  }

  return {
    // Returns where the notice went, for tests and for the Settings test button.
    notify(kind: NoticeKind, notice: AppNotice): 'system' | 'window' | 'none' {
      if (!allowed(kind)) return 'none';
      const key = `${kind}:${notice.repositoryId ?? ''}:${notice.title}`;
      const sent = lastSent.get(key);
      if (kind !== 'test' && sent !== undefined && now() - sent < REPEAT_GAP_MS)
        return 'none';
      lastSent.set(key, now());

      const inFront = deps.isFocused();
      const background = !inFront || !deps.settings().notifyOnlyInBackground;
      if (background && deps.sink.isSupported()) {
        deps.sink.show(
          { title: clip(notice.title, 64), body: clip(notice.body, 160) },
          () => deps.onClick(notice.repositoryId),
        );
        return 'system';
      }
      if (inFront) {
        deps.toWindow(notice);
        return 'window';
      }
      return 'none';
    },

    // The Settings button: always a system notification, so the person sees what their OS allows.
    test(): TestNotificationResult {
      if (!deps.sink.isSupported()) return 'unsupported';
      if (!deps.settings().notifications) return 'off';
      deps.sink.show(
        {
          title: 'Notifications are on',
          body: 'gitdesk will tell you here when a clone finishes or a check finds a problem.',
        },
        () => deps.onClick(null),
      );
      return 'shown';
    },
  };
}

export type Notifier = ReturnType<typeof createNotifier>;
