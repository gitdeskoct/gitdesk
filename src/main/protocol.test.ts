import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { resolveAppFile } from './protocol';

vi.mock('electron', () => ({ net: {}, protocol: {} }));

const root = path.resolve('/srv/gitdesk/renderer');

describe('resolveAppFile', () => {
  it('serves index.html for the root path', () => {
    expect(resolveAppFile(root, 'app://gitdesk/')).toBe(
      path.join(root, 'index.html'),
    );
  });

  it('serves a file inside the root', () => {
    expect(resolveAppFile(root, 'app://gitdesk/index.html')).toBe(
      path.join(root, 'index.html'),
    );
    expect(resolveAppFile(root, 'app://gitdesk/assets/app.js')).toBe(
      path.join(root, 'assets', 'app.js'),
    );
  });

  it('rejects a foreign host', () => {
    expect(resolveAppFile(root, 'app://evil/index.html')).toBeNull();
  });

  // The URL parser already folds literal `..` and `%2e%2e` segments, so traversal only
  // reaches resolveAppFile when the separator is encoded too.
  it.each([
    'app://gitdesk/..%2fsecret.txt',
    'app://gitdesk/%2e%2e%2fsecret.txt',
    'app://gitdesk/%2E%2E%2Fsecret.txt',
    'app://gitdesk/assets/..%2f..%2fsecret.txt',
    'app://gitdesk/..%5csecret.txt',
  ])('rejects traversal in %s', (url) => {
    expect(resolveAppFile(root, url)).toBeNull();
  });

  it('keeps literal `..` and `%2e%2e` segments inside the root', () => {
    for (const url of [
      'app://gitdesk/../secret.txt',
      'app://gitdesk/%2e%2e/secret.txt',
    ]) {
      expect(resolveAppFile(root, url)).toBe(path.join(root, 'secret.txt'));
    }
  });
});
