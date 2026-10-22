import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppNotice } from '../shared/ipc';
import { DEFAULT_SETTINGS, type Settings } from '../shared/settings';
import { createNotifier } from './notifier';

const notice: AppNotice = {
  title: 'api-tools cloned',
  body: '18 MB in 9 seconds.',
  tone: 'success',
  repositoryId: 'repo-1',
};

let settings: Settings;
let focused: boolean;
let time: number;
const show = vi.fn();
const toWindow = vi.fn();
const onClick = vi.fn();

const setup = (supported = true) =>
  createNotifier({
    settings: () => settings,
    isFocused: () => focused,
    sink: { isSupported: () => supported, show },
    toWindow,
    onClick,
    now: () => time,
  });

beforeEach(() => {
  settings = { ...DEFAULT_SETTINGS };
  focused = false;
  time = 1_000;
  show.mockReset();
  toWindow.mockReset();
  onClick.mockReset();
});

describe('notifier', () => {
  it('uses a system notification in the background and a toast in front', () => {
    const notifier = setup();
    expect(notifier.notify('clone', notice)).toBe('system');
    focused = true;
    time += 61_000;
    expect(notifier.notify('clone', notice)).toBe('window');
    expect(show).toHaveBeenCalledOnce();
    expect(toWindow).toHaveBeenCalledWith(notice);
  });

  it('does not repeat the same notice within a minute', () => {
    const notifier = setup();
    notifier.notify('problem', notice);
    time += 30_000;
    expect(notifier.notify('problem', notice)).toBe('none');
    time += 31_000;
    expect(notifier.notify('problem', notice)).toBe('system');
  });

  it('respects the master switch and each kind', () => {
    settings = { ...settings, notifyClone: false };
    const notifier = setup();
    expect(notifier.notify('clone', notice)).toBe('none');
    expect(notifier.notify('problem', notice)).toBe('system');
    settings = { ...settings, notifications: false };
    expect(notifier.notify('problem', { ...notice, title: 'other' })).toBe(
      'none',
    );
  });

  it('can send system notifications in front when asked to', () => {
    settings = { ...settings, notifyOnlyInBackground: false };
    focused = true;
    expect(setup().notify('clone', notice)).toBe('system');
  });

  it('falls back to the toast when the system cannot notify', () => {
    focused = true;
    settings = { ...settings, notifyOnlyInBackground: false };
    expect(setup(false).notify('clone', notice)).toBe('window');
    focused = false;
    expect(setup(false).notify('clone', notice)).toBe('none');
  });

  it('opens the repository when the notification is clicked', () => {
    setup().notify('clone', notice);
    show.mock.calls[0]![1]();
    expect(onClick).toHaveBeenCalledWith('repo-1');
  });

  it('reports what the test button did', () => {
    expect(setup(false).test()).toBe('unsupported');
    settings = { ...settings, notifications: false };
    expect(setup().test()).toBe('off');
    settings = { ...settings, notifications: true };
    expect(setup().test()).toBe('shown');
  });
});
