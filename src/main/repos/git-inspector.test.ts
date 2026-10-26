import { describe, expect, it, vi } from 'vitest';
import { stopTree, versionAtLeast } from './git-inspector';

describe('versionAtLeast', () => {
  it('compares Git versions by number, vendor suffixes included', () => {
    expect(versionAtLeast('2.26.0', '2.26.0')).toBe(true);
    expect(versionAtLeast('2.45.1.windows.1', '2.26.0')).toBe(true);
    expect(versionAtLeast('2.100.0', '2.26.0')).toBe(true);
    expect(versionAtLeast('2.25.4', '2.26.0')).toBe(false);
    expect(versionAtLeast('1.9.5', '2.26.0')).toBe(false);
    expect(versionAtLeast('3.0', '2.26.0')).toBe(true);
    expect(versionAtLeast('not a version', '2.26.0')).toBe(false);
  });
});

describe('stopTree', () => {
  it('ends the whole process tree with taskkill on Windows', () => {
    const kill = vi.fn();
    const run = vi.fn();
    stopTree({ pid: 4321, kill }, 'win32', run as never);
    expect(run).toHaveBeenCalledWith(
      expect.stringMatching(/System32[\\/]taskkill\.exe$/i),
      ['/pid', '4321', '/T', '/F'],
      expect.objectContaining({ windowsHide: true }),
      expect.any(Function),
    );
    expect(kill).not.toHaveBeenCalled();
    // taskkill failing falls back to killing Git itself.
    const done = run.mock.calls[0]![3] as (err: Error | null) => void;
    done(new Error('access denied'));
    expect(kill).toHaveBeenCalledOnce();
  });

  it('kills the child directly elsewhere, or without a pid', () => {
    const kill = vi.fn();
    const run = vi.fn();
    stopTree({ pid: 1, kill }, 'linux', run as never);
    stopTree({ pid: undefined, kill }, 'win32', run as never);
    expect(kill).toHaveBeenCalledTimes(2);
    expect(run).not.toHaveBeenCalled();
  });
});
