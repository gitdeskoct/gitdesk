import { createApp } from './app';
import { getDb } from './db/client';
import { purgeExpired } from './jobs/cleanup';
import { gitHostFor } from './lib/git-host';
import { googleProvider } from './modules/auth/google';
import { resumeLifecycle } from './modules/repositories/repositories';

const app = createApp({ google: googleProvider, gitHost: gitHostFor });

export default {
  fetch: app.fetch,
  scheduled(_controller, env, ctx) {
    const db = getDb(env.DB);
    ctx.waitUntil(purgeExpired(db, Date.now()));
    const storage = { bucket: env.REPO_STORAGE, git: gitHostFor(env) };
    ctx.waitUntil(resumeLifecycle(db, storage, Date.now()));
  },
} satisfies ExportedHandler<CloudflareBindings>;
