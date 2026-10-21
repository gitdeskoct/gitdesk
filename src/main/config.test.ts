import { describe, expect, it } from 'vitest';
import {
  APP_ORIGIN,
  allowedRendererOrigins,
  isAllowedRendererUrl,
  resolveApiOrigin,
} from './config';

describe('resolveApiOrigin', () => {
  it('accepts https and returns only the origin', () => {
    expect(resolveApiOrigin('https://api.gitdesk.example/v1/', true)).toBe(
      'https://api.gitdesk.example',
    );
    expect(resolveApiOrigin('https://api.gitdesk.example', false)).toBe(
      'https://api.gitdesk.example',
    );
  });

  it('accepts local http only when unpackaged', () => {
    expect(resolveApiOrigin('http://localhost:8787', false)).toBe(
      'http://localhost:8787',
    );
    expect(resolveApiOrigin('http://127.0.0.1:9000', false)).toBe(
      'http://127.0.0.1:9000',
    );
    expect(resolveApiOrigin(undefined, false)).toBe('http://localhost:8787');
    expect(resolveApiOrigin('', false)).toBe('http://localhost:8787');

    expect(() => resolveApiOrigin('http://localhost:8787', true)).toThrow(
      /https/,
    );
    expect(() => resolveApiOrigin('http://127.0.0.1:9000', true)).toThrow(
      /https/,
    );
    expect(() => resolveApiOrigin(undefined, true)).toThrow(/https/);
  });

  it.each([
    'http://api.gitdesk.example',
    'http://localhost.evil.example',
    'http://192.168.1.10:8787',
    'ftp://localhost',
    'file:///etc/passwd',
  ])('rejects %s', (raw) => {
    expect(() => resolveApiOrigin(raw, false)).toThrow();
  });

  it('throws on a malformed URL', () => {
    expect(() => resolveApiOrigin('not a url', false)).toThrow();
  });
});

describe('isAllowedRendererUrl', () => {
  const origins = allowedRendererOrigins('http://localhost:5173/');

  it('lists the dev server origin only when one is given', () => {
    expect(allowedRendererOrigins(undefined)).toEqual([APP_ORIGIN]);
    expect(origins).toEqual([APP_ORIGIN, 'http://localhost:5173']);
  });

  it('accepts URLs on the dev server origin', () => {
    expect(isAllowedRendererUrl('http://localhost:5173/', origins)).toBe(true);
    expect(
      isAllowedRendererUrl('http://localhost:5173/#/settings', origins),
    ).toBe(true);
  });

  // Regression: Node reports app:// origins as "null", which once rejected the packaged renderer.
  it('accepts the packaged app:// renderer', () => {
    expect(isAllowedRendererUrl('app://gitdesk/index.html', origins)).toBe(
      true,
    );
  });

  it.each([
    'app://evil/index.html',
    'http://localhost:5174/',
    'https://localhost:5173/',
    'https://gitdesk.example/',
    'file:///index.html',
    'about:blank',
    'not a url',
    '',
  ])('rejects %s', (url) => {
    expect(isAllowedRendererUrl(url, origins)).toBe(false);
  });
});
