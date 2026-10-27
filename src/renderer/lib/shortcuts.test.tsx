import { beforeEach, describe, expect, it } from 'vitest';
import type { DesktopApi } from '../../shared/ipc';
import { matchShortcut, shortcutText } from './shortcuts';

const key = (init: KeyboardEventInit) => new KeyboardEvent('keydown', init);

describe('matchShortcut', () => {
  beforeEach(() => {
    window.desktop = { platform: 'win32' } as unknown as DesktopApi;
  });

  it('tells a letter with Shift from the same letter without it', () => {
    expect(matchShortcut(key({ key: 'o', ctrlKey: true }))).toBe(
      'openRepository',
    );
    expect(
      matchShortcut(key({ key: 'O', ctrlKey: true, shiftKey: true })),
    ).toBe('cloneRepository');
    expect(matchShortcut(key({ key: 'p', ctrlKey: true }))).toBe('push');
    expect(
      matchShortcut(key({ key: 'P', ctrlKey: true, shiftKey: true })),
    ).toBe('pull');
    // No Shift version of Ctrl+N exists, so Ctrl+Shift+N must not create a repository.
    expect(
      matchShortcut(key({ key: 'N', ctrlKey: true, shiftKey: true })),
    ).toBeNull();
  });

  it('keeps zoom working whether or not the + needs Shift', () => {
    expect(matchShortcut(key({ key: '=', ctrlKey: true }))).toBe('zoomIn');
    expect(
      matchShortcut(key({ key: '+', ctrlKey: true, shiftKey: true })),
    ).toBe('zoomIn');
  });

  it('matches repository tabs by digit and ignores Alt', () => {
    expect(matchShortcut(key({ key: '3', ctrlKey: true }))).toBe('repoTab');
    expect(
      matchShortcut(key({ key: '3', ctrlKey: true, altKey: true })),
    ).toBeNull();
    expect(matchShortcut(key({ key: 'F5' }))).toBe('refresh');
  });

  it('writes Shift into the label people read', () => {
    expect(shortcutText('cloneRepository')).toBe('Ctrl+Shift+O');
    expect(shortcutText('push')).toBe('Ctrl+P');
  });
});
