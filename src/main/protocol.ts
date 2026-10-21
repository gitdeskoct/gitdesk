import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { net, protocol } from 'electron';

export const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data: https://*.googleusercontent.com",
  "font-src 'self'",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join('; ');

// Must run before app 'ready'.
export function registerAppScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: 'app',
      privileges: { standard: true, secure: true, supportFetchAPI: true },
    },
  ]);
}

export function resolveAppFile(
  rootDir: string,
  requestUrl: string,
): string | null {
  const url = new URL(requestUrl);
  if (url.host !== 'gitdesk') return null;
  const relative = decodeURIComponent(
    url.pathname === '/' ? '/index.html' : url.pathname,
  );
  const file = path.resolve(rootDir, `.${relative}`);
  const inside = path.relative(rootDir, file);
  return inside && !inside.startsWith('..') && !path.isAbsolute(inside)
    ? file
    : null;
}

export function serveRendererFrom(rootDir: string): void {
  protocol.handle('app', async (request) => {
    const file = resolveAppFile(rootDir, request.url);
    if (!file) return new Response('Not found', { status: 404 });
    const res = await net.fetch(pathToFileURL(file).toString());
    const headers = new Headers(res.headers);
    headers.set('Content-Security-Policy', CSP);
    headers.set('X-Content-Type-Options', 'nosniff');
    return new Response(res.body, { status: res.status, headers });
  });
}
