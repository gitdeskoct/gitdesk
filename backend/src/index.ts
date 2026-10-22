import { createApp } from './app';
import { getDb } from './db/client';
import { purgeExpired } from './jobs/cleanup';
import { googleProvider } from './modules/auth/google';
import { resumeLifecycle } from './modules/repositories/repositories';

const app = createApp({ google: googleProvider });

export default {
  fetch: app.fetch,
  scheduled(_controller, env, ctx) {
    const db = getDb(env.DB);
    ctx.waitUntil(purgeExpired(db, Date.now()));
    ctx.waitUntil(resumeLifecycle(db, env.REPO_STORAGE, Date.now()));
  },
} satisfies ExportedHandler<CloudflareBindings>;
