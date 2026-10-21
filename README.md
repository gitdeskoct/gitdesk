# gitdesk

A desktop Git client. Electron Forge, React 19 and Tailwind 4 on the desktop, with a Cloudflare Worker (Hono, D1, Drizzle, jose) for accounts and sessions.

The design system lives in [DESIGN.md](DESIGN.md). Worker setup lives in [backend/README.md](backend/README.md).

## Trust zones

The app is split into three zones. Each one trusts the zone below it in this list and treats everything from above as untrusted input.

| Zone     | Code           | Trust                                                                                                                                              |
| -------- | -------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- |
| Renderer | `src/renderer` | **Untrusted.** Sandboxed, context isolated, no Node. Talks to main only through the fixed methods in `src/preload/preload.ts`. Never sees a token. |
| Main     | `src/main`     | **Privileged.** Owns the network, the filesystem, Git, the OS credential store and the access token. Validates every IPC call.                     |
| Worker   | `backend/`     | **Authoritative.** Owns accounts, sessions and token issuance. The session row in D1 is the source of truth for whether a token is still valid.    |

How the boundaries are enforced:

- **Renderer to main.** `src/preload/preload.ts` exposes one method per fixed IPC channel (no generic invoke, no raw `ipcRenderer`). Every handler goes through `createHandle` in `src/main/ipc/handle.ts`, which rejects calls from any sender other than the main window's top frame on an allowed origin, then parses the input with a zod schema.
- **Window hardening.** `src/main/security.ts` blocks navigation and redirects away from the app origin, denies `window.open` and webviews, and refuses every permission request. `src/main/window.ts` sets `contextIsolation`, `sandbox` and `nodeIntegration: false`.
- **Renderer content.** Packaged builds load from the `app://gitdesk` scheme (`src/main/protocol.ts`), which serves only files inside the renderer build directory and sets a strict CSP.
- **Main to Worker.** `src/main/auth/api-client.ts` validates every Worker response with zod, because a misconfigured or compromised server is still untrusted input. The Worker origin comes from `VITE_API_ORIGIN` and must be https in packaged builds (`src/main/config.ts`).
- **Worker inputs.** Every route validates its query, params or body with zod (`backend/src/modules/auth/schemas.ts`). Bodies are capped at 8 KiB and auth routes are rate limited.

## Sign-in

Google sign-in uses the system browser, not an embedded window, following RFC 8252 (OAuth for native apps).

```
main                create PKCE verifier + state, listen on 127.0.0.1:<port>
main -> browser     open <API>/api/v1/auth/google/start?challenge&state&port
browser -> Worker   store transaction, redirect to Google (Worker's own state, nonce, PKCE)
browser -> Google   user picks an account
Google -> Worker    GET /api/v1/auth/google/callback: verify ID token, upsert account
Worker -> browser   redirect to http://127.0.0.1:<port>/callback?code&state (one-time code)
browser -> main     loopback checks state, closes
main -> Worker      POST /api/v1/auth/desktop/exchange {code, code_verifier}
Worker -> main      access token + refresh token + account
main                refresh token -> safeStorage, access token -> memory only
```

Step by step:

1. **Main prepares.** `AuthService.signIn()` (`src/main/auth/auth-service.ts`) creates a PKCE verifier and a state value (32 random bytes each, `src/main/auth/pkce.ts`) and starts a loopback server on `127.0.0.1` with an ephemeral port (`src/main/auth/loopback-server.ts`). The loopback accepts one `GET /callback` with a matching state, then closes. It times out after 5 minutes.
2. **System browser to the Worker.** Main opens `<VITE_API_ORIGIN>/api/v1/auth/google/start?challenge=…&state=…&port=…` with `shell.openExternal`. Main refuses to open any URL on another origin.
3. **Worker to Google.** The Worker stores an OAuth transaction (valid for 10 minutes) holding the desktop challenge, desktop state and port, then redirects to Google with its own state, nonce and PKCE pair. The redirect target is always the loopback shape `http://127.0.0.1:<port>/callback`. Clients never supply a redirect URI.
4. **Google to the Worker callback.** `/api/v1/auth/google/callback` consumes the transaction atomically, exchanges Google's code, verifies the ID token (RS256, issuer, audience, nonce, verified email) and upserts the account by `(provider, subject)`, never by email.
5. **Worker to loopback.** The Worker mints a one-time desktop code (valid for 60 seconds, stored hashed) bound to the desktop challenge, and redirects the browser to `http://127.0.0.1:<port>/callback?code=…&state=…`.
6. **Main exchanges the code.** Main checks the state, then posts the code and the PKCE verifier to `/api/v1/auth/desktop/exchange`. The Worker burns the code before checking the verifier, so a stolen code cannot be retried. A code without the matching verifier is useless.
7. **Tokens are stored.** The Worker returns a 10 minute HS256 access token, a refresh token and the account. Main writes the refresh token to `session.bin` in the user data directory, encrypted with Electron `safeStorage` (`src/main/auth/credential-store.ts`). On Linux with no keyring, `safeStorage` would use a hardcoded key, so the refresh token stays in memory only and the session ends when the app quits. The access token is only ever held in memory in `AuthService`. The renderer receives an `AuthStatus`, never a token.

After sign-in:

- **Refresh rotation.** Every `/api/v1/auth/refresh` returns a new refresh token and invalidates the old one with a compare and swap on its hash. Presenting a token that was already rotated away is treated as theft and revokes the session. Main refreshes in single flight so two parallel refreshes never look like reuse. Sessions expire after 30 days idle or 90 days total (`backend/src/modules/auth/sessions.ts`).
- **Revocation.** Every authenticated request checks the session row, so revoking a session takes effect immediately even though the access token is a JWT. Users can list sessions and revoke any of their own (`GET /api/v1/auth/sessions`, `DELETE /api/v1/auth/sessions/:id`).
- **Sign-out.** Local credentials are always cleared. Remote revocation through `/api/v1/auth/logout` is best effort, and the UI is told if it could not be confirmed.
- **Offline.** If the Worker is unreachable at startup, main reports `offline` with the cached account summary and retries.

## Module layout

```
src/
  main/              privileged Electron main process
    auth/            sign-in, tokens, credential store, loopback
    db/              local SQLite (node:sqlite) for app state, never credentials
    git/             Git access through simple-git
    ipc/             handle() guard and channel registration
    settings/        user settings and theme
    config.ts        API origin and allowed renderer origins
    protocol.ts      app:// scheme and CSP
    security.ts      navigation, permission and window hardening
    window.ts        BrowserWindow and title bar colors
  preload/           the only bridge: one method per IPC channel
  renderer/          React UI (untrusted)
    components/ui/   shared primitives (button, switch, menus, ...)
    lib/
    styles/          globals.css, the tokens from DESIGN.md
  shared/            types and zod schemas used by main, preload and renderer
backend/
  src/
    app.ts           Hono app, global middleware, route mounting
    index.ts         Worker entry: fetch and the daily cleanup cron
    db/              Drizzle schema and client
    jobs/            scheduled jobs
    lib/             crypto, errors, logging
    middleware/      validation, rate limits, requireAuth, error handler
    modules/auth/    Google OAuth, desktop handoff, sessions, tokens
  drizzle/migrations/
  test/
```

### Adding a feature

Each feature is one domain, with one folder per zone:

- **Main:** `src/main/<domain>/`. A service with the privileged logic. Register its handlers in `src/main/ipc/register.ts`, each with a zod input schema.
- **Contract:** add the channel names, types and input schemas to `src/shared/`, and the methods to `DesktopApi` and `src/preload/preload.ts`.
- **Renderer:** `src/renderer/features/<domain>/`. Screens and hooks for that domain. Shared primitives stay in `src/renderer/components/ui/`.
- **Worker:** `backend/src/modules/<domain>/`. Routes, schemas and data access, mounted in `backend/src/app.ts`. Protected routes use `requireAuth`. Schema changes go in `backend/src/db/schema.ts` followed by `npm run db:generate`.

## Development

Requirements: Node.js, npm and Git. The Worker needs a Cloudflare account only for remote deploys.

1. Set up and start the Worker, following [backend/README.md](backend/README.md). By default it listens on `http://localhost:8787`.
2. Copy `.env.example` to `.env` in the repository root. `VITE_API_ORIGIN` points the app at the Worker and must be https in packaged builds. Plain `http://localhost` or `http://127.0.0.1` is accepted only in unpackaged dev builds.
3. Install and start the app:

```bash
npm install
```

```bash
npm start
```

### Desktop commands

| Command             | What it does                                                                     |
| ------------------- | -------------------------------------------------------------------------------- |
| `npm start`         | Run the app in development with Vite hot reload (`electron-forge start`).        |
| `npm test`          | Run the desktop tests.                                                           |
| `npm run typecheck` | Type-check with `tsc --noEmit`.                                                  |
| `npm run lint`      | Lint with oxlint and check formatting with oxfmt. `npm run lint:fix` fixes both. |
| `npm run package`   | Package the app for the current platform.                                        |
| `npm run make`      | Build installers with the configured makers.                                     |

### Worker commands

Run these in `backend/`.

| Command                     | What it does                                                           |
| --------------------------- | ---------------------------------------------------------------------- |
| `npm run dev`               | Run the Worker locally (`wrangler dev`).                               |
| `npm test`                  | Run the Worker tests in the Workers runtime (`vitest run`).            |
| `npm run typecheck`         | Type-check with `tsc --noEmit`.                                        |
| `npm run cf-typegen`        | Regenerate `worker-configuration.d.ts` from `wrangler.jsonc`.          |
| `npm run db:generate`       | Generate a migration from `src/db/schema.ts` (`drizzle-kit generate`). |
| `npm run db:migrate:local`  | Apply migrations to the local D1 database.                             |
| `npm run db:migrate:remote` | Apply migrations to the remote D1 database.                            |
| `npm run deploy`            | Deploy the Worker (`wrangler deploy --minify`).                        |
