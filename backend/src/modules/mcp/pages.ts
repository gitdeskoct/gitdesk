import type { ConsentDescription } from '@cloudflare/workers-oauth-provider';
import { REQUIRED_SCOPE, SCOPE_TEXT, type McpScope } from './oauth';

// Client names, domains and hosts come from whoever registered the client: every one is escaped.
export const escapeHtml = (value: string) =>
  value.replace(/[&<>"']/g, (char) => `&#${char.charCodeAt(0)};`);

// gitdesk's own palette (DESIGN.md), flat and cardless like the app, in both themes.
const STYLE = `
:root{--canvas:#eef0f3;--surface:#fff;--line:#dde1e7;--line-strong:#c6ccd5;--ink:#14161a;--muted:#5b6270;--accent:#2f5bea;--accent-hover:#2549c4;--on-accent:#fff;--warning:#a86a12}
@media (prefers-color-scheme:dark){:root{--canvas:#0b0b0d;--surface:#131316;--line:#222327;--line-strong:#32343a;--ink:#f1f1f3;--muted:#a8adb7;--accent:#7f95ff;--accent-hover:#98a9ff;--on-accent:#0d1020;--warning:#e7b45a}}
*{box-sizing:border-box}
body{margin:0;min-height:100vh;font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;background:var(--canvas);color:var(--ink)}
main{max-width:34rem;min-height:100vh;margin:0 auto;padding:48px 24px;background:var(--surface)}
.brand{font-size:.8125rem;font-weight:600;color:var(--muted);margin:0 0 30px}
h1{font-size:1.375rem;line-height:1.3;letter-spacing:-.02em;margin:0 0 6px;overflow-wrap:anywhere}
p{margin:0;color:var(--muted)}
strong{color:var(--ink);font-weight:600;overflow-wrap:anywhere}
.note{margin-top:12px;color:var(--ink)}
.note b{color:var(--warning)}
h2{font-size:.8125rem;font-weight:500;color:var(--muted);margin:30px 0 4px}
ul{list-style:none;margin:0;padding:0;border-top:1px solid var(--line);border-bottom:1px solid var(--line)}
li+li{border-top:1px solid var(--line)}
label{display:flex;gap:12px;padding:14px 0;cursor:pointer}
input[type=checkbox]{width:16px;height:16px;margin:4px 0 0;flex:none;accent-color:var(--accent)}
label span{display:block;font-size:.875rem;font-weight:500}
label small{display:block;font-size:.875rem;color:var(--muted)}
.actions{display:flex;flex-wrap:wrap;gap:12px;margin-top:30px}
button{font:inherit;font-size:.875rem;font-weight:500;height:36px;padding:0 14px;border-radius:6px;border:1px solid var(--line-strong);background:var(--surface);color:var(--ink);cursor:pointer}
button.primary{border-color:var(--accent);background:var(--accent);color:var(--on-accent)}
button.primary:hover{border-color:var(--accent-hover);background:var(--accent-hover)}
button:focus-visible,input:focus-visible{outline:2px solid var(--accent);outline-offset:2px}
.foot{margin-top:18px;font-size:.875rem}
`;

const page = (title: string, body: string) =>
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex"><title>${escapeHtml(title)} · gitdesk</title><style>${STYLE}</style></head><body><main><p class="brand">gitdesk</p>${body}</main></body></html>`;

function scopeRow(scope: McpScope): string {
  const { label, detail } = SCOPE_TEXT[scope];
  const required = scope === REQUIRED_SCOPE;
  // A disabled box isn't submitted, so the required scope also travels as a hidden field.
  // Changing pull requests is the one thing an agent can alter, so it is never ticked for you.
  const box = required
    ? `<input type="hidden" name="scope" value="${scope}"><input type="checkbox" checked disabled>`
    : `<input type="checkbox" name="scope" value="${scope}"${scope === 'pr:write' ? '' : ' checked'}>`;
  return `<li><label>${box}<div><span>${escapeHtml(label)}${required ? ' (always included)' : ''}</span><small>${escapeHtml(detail)}</small></div></label></li>`;
}

export function consentPage(details: ConsentDescription, scopes: McpScope[], handle: string): string {
  const name = escapeHtml(details.clientName);
  const who = details.clientDomain
    ? `Published by <strong>${escapeHtml(details.clientDomain)}</strong>.`
    : 'This app registered itself, so its name is not verified.';
  const loopback = details.redirectIsLoopback
    ? '<p class="note"><b>Access goes to an app on this computer.</b> Continue only if you just started connecting from it.</p>'
    : '';
  return page(
    `Connect ${details.clientName}`,
    `<h1>Let ${name} use your gitdesk account?</h1>
<p>${who} Access will be sent to <strong>${escapeHtml(details.redirectHost)}</strong>.</p>${loopback}
<form method="post">
<input type="hidden" name="handle" value="${escapeHtml(handle)}">
<h2>It will be able to</h2>
<ul>${scopes.map(scopeRow).join('')}</ul>
<div class="actions"><button class="primary" name="decision" value="approve">Continue with Google</button><button name="decision" value="deny">Don't allow</button></div>
<p class="foot">You confirm with Google which account it is. Revoke access any time in gitdesk under Settings, MCP.</p>
</form>`,
  );
}

export const noticePage = (title: string, message: string) =>
  page(title, `<h1>${escapeHtml(title)}</h1><p>${escapeHtml(message)}</p>`);
