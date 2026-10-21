import { createApp } from './app';
import { getDb } from './db/client';
import { purgeExpired } from './jobs/cleanup';
import { googleProvider } from './modules/auth/google';

const app = createApp({ google: googleProvider });

export default {
  fetch: app.fetch,
  scheduled(_controller, env, ctx) {
    ctx.waitUntil(purgeExpired(getDb(env.DB), Date.now()));
  },
} satisfies ExportedHandler<CloudflareBindings>;
