# gitdesk

## Finishing a feature: end-to-end test first

A feature is done only after a full end-to-end run on the local stack, as a real user would use it, on top of the unit tests. Report what the run covered, what it found and what it couldn't reach. Never call something done from unit tests alone.

**The local stack**

1. `cd backend && npm run db:migrate:local`
2. `npm run git-host:local` (local Git hosting; Artifacts has no local simulator) and `npm run dev:hosted`, each in its own terminal, logs kept. Plain `npm run dev` has hosting off.
3. The desktop app on a throwaway profile, pointed at the local Worker: `VITE_API_ORIGIN=http://localhost:8787 GITDESK_USER_DATA=<temp dir> HOME=<temp home> npx electron-forge start -- --remote-debugging-port=<port>`. The temp home's `.gitconfig` trusts the local host's certificate (see backend/README.md) and sets a test user name and email.
4. Drive the window over CDP (Playwright `connectOverCDP`). Use a local test account seeded into the local D1, never real sign-in credentials, and never production.

**What a run covers**

- Every screen the feature touches, from a new user's first step: sign in, create, add and clone a repository, then the feature's own flows.
- The failure paths: refused push, conflicts, signed out, hosting off, a remote that moved, app restart in the middle.
- Light and dark, a narrow window, keyboard only, and that every async button shows its spinner.
- Git's and the Worker's own record of what happened (git log, the local D1, the host log), not only what the screen says.

Afterwards rerun the affected test suites and the full ones, delete the test account and data, and stop every process you started.
