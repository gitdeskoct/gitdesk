# Security policy

## Supported versions

Security fixes target the latest version on the `main` branch and the latest published release.

## Reporting a vulnerability

Do not open a public issue for a suspected vulnerability. Report it privately through the repository's GitHub security advisory page:

https://github.com/gitdeskoct/gitdesk/security/advisories/new

Include the affected component, reproduction steps, impact, and any suggested mitigation. Please do not include live credentials, access tokens, or production data.

If GitHub's private reporting flow is unavailable, contact the repository maintainers through the organization profile before sharing sensitive details.

## MCP file privacy

Desktop and hosted MCP tools refuse file contents for credential names such as `.env`, `id_rsa` and `.docker/config.json`, even in a commit. For uncommitted renames, the desktop checks both names Git reports. A direct worktree read must name a tracked file or an untracked file Git does not ignore. Current ignore rules do not restrict reads at an explicit branch or commit, or change what you can open in the Files tab.

These rules check paths, not contents. An ordinary source file can still expose a secret to an agent with read access.

## Secret exposure

If a credential may have entered Git history, revoke it first, then report the exposure privately. Never paste the credential into an issue, pull request, log, or chat message.
