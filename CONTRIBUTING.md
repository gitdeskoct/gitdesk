# Contributing to gitdesk

## Before you start

Read [README.md](README.md) for setup and [DESIGN.md](DESIGN.md) for renderer direction. Do not commit `.env`, `backend/.dev.vars`, credentials, certificates, or generated local data.

## Local checks

Run the checks that cover your change:

```bash
npm run lint
npm run typecheck
npm test
```

For Worker changes:

```bash
cd backend
npm run typecheck
npm test
```

Changes that affect the desktop app and Worker should run both suites. Security-sensitive changes should also run the relevant smoke or release checks.

## Pull requests

- Keep changes focused and explain the user-visible result.
- Include tests for new behavior and regression fixes.
- Do not add secrets or private infrastructure details to source or documentation.
- Update documentation when setup, behavior, or release configuration changes.
- Wait for required checks and address review feedback before merging.

## Commit messages

Use a short imperative subject. Release automation recognizes `#minor`, `#major`, and `BREAKING CHANGE` when deciding the next stable version. To publish a beta, raise `package.json` to an explicit semver prerelease such as `1.1.0-beta.1`; the workflow routes prereleases to `BotCoder254/gitdesk-releases` and normal versions to `gitdeskoct/gitdesk`.
