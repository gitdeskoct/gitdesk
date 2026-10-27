<p align="center">
  <img src="https://raw.githubusercontent.com/gitdeskoct/gitdesk/main/assets/logo.svg" alt="gitdesk logo" width="180">
</p>

<h1 align="center">gitdesk</h1>

<p align="center">
  A local-first desktop Git client for reviewing, editing, and shipping repositories.
</p>

<p align="center">
  <a href="https://github.com/gitdeskoct/gitdesk/releases"><img src="https://img.shields.io/github/v/release/gitdeskoct/gitdesk-releases?label=release" alt="Latest release"></a>
  <a href="https://github.com/gitdeskoct/gitdesk/actions/workflows/quality.yml"><img src="https://github.com/gitdeskoct/gitdesk/actions/workflows/quality.yml/badge.svg" alt="Quality checks"></a>
  <a href="https://github.com/gitdeskoct/gitdesk/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-MIT-2f5bea" alt="MIT license"></a>
</p>

## What it does

gitdesk brings Git work into a focused desktop workspace:

- inspect history, branches, diffs, and repository status
- stage files, write commits, fetch, push, and manage remotes
- review pull requests locally, including comments, conflicts, merges, and reverts
- sign in with Google through the system browser
- keep tokens out of the renderer and out of Git configuration
- run against a Cloudflare Worker backend for accounts, sessions, and hosted repositories

The app is built with Electron, React, TypeScript, Tailwind, Hono, D1, Drizzle, and `jose`.

## Security model

The renderer is sandboxed and untrusted. The privileged Electron main process owns Git, the filesystem, network access, and credentials. The Worker validates requests, owns sessions and token issuance, and treats all client input as untrusted.

Read the implementation details in [backend/README.md](backend/README.md), the design direction in [DESIGN.md](DESIGN.md), and the security reporting process in [SECURITY.md](SECURITY.md).

## Development

Requirements: Node.js `>=22.12`, npm, and Git.

```bash
npm install
npm start
```

Run the app checks:

```bash
npm run lint
npm run typecheck
npm test
```

Run the Worker locally:

```bash
cd backend
npm install
npm run dev
```

Copy `.env.example` to `.env` for the desktop API origin. Copy `backend/.dev.vars.example` to `backend/.dev.vars` for local-only Worker secrets. Never commit either file.

## Project map

```text
src/main       privileged Electron services
src/preload    typed IPC bridge
src/renderer   React interface
src/shared     shared types and schemas
backend        Cloudflare Worker and D1 backend
.github        CI, release automation, and repository policy
```

## Releases

Stable releases and their update metadata are published in [`gitdeskoct/gitdesk`](https://github.com/gitdeskoct/gitdesk). Beta releases are published in [`BotCoder254/gitdesk-releases`](https://github.com/BotCoder254/gitdesk-releases), and are selected in Settings › Updates.

The release workflow runs after pushes to `main`, checks the full app and Worker, builds Windows and Linux packages, runs packaged-app smoke tests, writes checksums and Nix metadata, and publishes only after artifact verification. A normal `x.y.z` version is stable; an explicit `x.y.z-beta.N` version is beta and is marked as a prerelease automatically.

Required Actions configuration:

| Name                   | Type     | Purpose                                                                              |
| ---------------------- | -------- | ------------------------------------------------------------------------------------ |
| `API_ORIGIN`           | Variable | HTTPS origin baked into packaged builds                                              |
| `RELEASES_TOKEN`       | Secret   | Fine-grained token with Contents write access only to `BotCoder254/gitdesk-releases` for beta releases |
| `WIN_SIGNING`          | Variable | Set to `required` to enforce Windows signing                                         |
| `WIN_PUBLISHER_NAME`   | Variable | Expected Windows certificate subject                                                 |
| `WIN_CSC_LINK`         | Secret   | Signing certificate input for electron-builder                                       |
| `WIN_CSC_KEY_PASSWORD` | Secret   | Signing certificate password                                                         |

Create and rotate `RELEASES_TOKEN` outside the repository. Do not use a personal all-repositories token for releases.

## Contributing

Please read [CONTRIBUTING.md](CONTRIBUTING.md) before opening a pull request. Changes to source, backend, workflows, and security-sensitive configuration require review and passing CI.

## License

gitdesk is released under the [MIT License](LICENSE). The logo and bundled Noto Emoji artwork retain the attribution and license described in [assets/brand/NOTICE.md](assets/brand/NOTICE.md).
