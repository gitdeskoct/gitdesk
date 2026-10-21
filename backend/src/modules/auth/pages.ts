import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

// Static copy only; nothing from the request is interpolated, so no escaping is needed.
export function messagePage(
  c: Context,
  status: ContentfulStatusCode,
  title: string,
  body: string,
) {
  c.header(
    'Content-Security-Policy',
    "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'; base-uri 'none'",
  );
  return c.html(
    `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title} · gitdesk</title><style>body{margin:0;min-height:100vh;display:grid;place-items:center;font:16px/1.5 system-ui,sans-serif;background:#eef0f3;color:#14161a}main{max-width:28rem;padding:24px}h1{font-size:1.25rem;margin:0 0 6px}p{margin:0;color:#5b6270}@media (prefers-color-scheme:dark){body{background:#0b0b0d;color:#f1f1f3}p{color:#a8adb7}}</style></head><body><main><h1>${title}</h1><p>${body}</p></main></body></html>`,
    status,
  );
}
