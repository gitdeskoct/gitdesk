import { createServer, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { safeEqual } from './pkce';

export type LoopbackResult =
  | { kind: 'code'; code: string }
  | { kind: 'error'; error: 'access_denied' | 'provider_error' };

export class SignInCancelled extends Error {}
export class SignInTimedOut extends Error {}

const CODE = /^[A-Za-z0-9_-]{43}$/;

function page(
  res: ServerResponse,
  status: number,
  title: string,
  body: string,
) {
  res.writeHead(status, {
    'Content-Type': 'text/html; charset=utf-8',
    'Content-Security-Policy': "default-src 'none'; style-src 'unsafe-inline'",
    'Cache-Control': 'no-store',
    'Referrer-Policy': 'no-referrer',
    Connection: 'close',
  });
  res.end(
    `<!doctype html><html lang="en"><meta charset="utf-8"><title>${title}</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#eef0f3;color:#14161a}main{max-width:28rem;padding:24px}h1{font-size:1.25rem;margin:0 0 6px}p{margin:0;color:#5b6270}@media (prefers-color-scheme:dark){body{background:#0b0b0d;color:#f1f1f3}p{color:#a8adb7}}</style><main><h1>${title}</h1><p>${body}</p></main></html>`,
  );
}

// RFC 8252 §7.3: bind to 127.0.0.1 on an ephemeral port, accept one matching callback, then close.
export async function startLoopback(opts: {
  state: string;
  signal: AbortSignal;
  timeoutMs?: number;
}): Promise<{ port: number; result: Promise<LoopbackResult> }> {
  let settle!: {
    resolve: (r: LoopbackResult) => void;
    reject: (e: Error) => void;
  };
  const result = new Promise<LoopbackResult>((resolve, reject) => {
    settle = { resolve, reject };
  });

  const server = createServer((req, res) => {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    if (req.method !== 'GET' || url.pathname !== '/callback') {
      res.writeHead(404).end();
      return;
    }
    if (!safeEqual(url.searchParams.get('state') ?? '', opts.state)) {
      page(
        res,
        400,
        'This link is not for this sign-in',
        'Return to gitdesk and start again.',
      );
      return;
    }
    const code = url.searchParams.get('code') ?? '';
    const error = url.searchParams.get('error');
    if (!error && CODE.test(code)) {
      page(
        res,
        200,
        'You are signed in',
        'You can close this tab and return to gitdesk.',
      );
      finish(() => settle.resolve({ kind: 'code', code }));
    } else {
      page(
        res,
        200,
        'Sign-in did not finish',
        'Return to gitdesk to see what happened.',
      );
      const kind =
        error === 'access_denied' ? 'access_denied' : 'provider_error';
      finish(() => settle.resolve({ kind: 'error', error: kind }));
    }
  });

  const timer = setTimeout(
    () => finish(() => settle.reject(new SignInTimedOut()), true),
    opts.timeoutMs ?? 5 * 60_000,
  );
  const onAbort = () =>
    finish(() => settle.reject(new SignInCancelled()), true);
  opts.signal.addEventListener('abort', onAbort, { once: true });

  // From inside a request, a plain close() lets the in-flight response flush first.
  function finish(done: () => void, force = false) {
    clearTimeout(timer);
    opts.signal.removeEventListener('abort', onAbort);
    server.close();
    if (force) server.closeAllConnections();
    done();
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  return { port: (server.address() as AddressInfo).port, result };
}
