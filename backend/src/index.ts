import { createApp } from './app';
import { getDb } from './db/client';
import { purgeExpired } from './jobs/cleanup';
import { gitHostFor } from './lib/git-host';
import { googleProvider } from './modules/auth/google';
import { purgeMcp } from './modules/mcp/grants';
import { authorizationServer } from './modules/mcp/oauth';
import { resumeLifecycle } from './modules/repositories/repositories';

const app = createApp({ google: googleProvider, gitHost: gitHostFor });

export default {
  fetch: app.fetch,
  scheduled(_controller, env, ctx) {
    const db = getDb(env.DB);
    ctx.waitUntil(purgeExpired(db, Date.now()));
    ctx.waitUntil(purgeMcp(db, Date.now()));
    // KV expires OAuth records itself; this sweep removes what a half-finished revoke left behind.
    // Each night continues where the last one stopped.
    ctx.waitUntil(
      (async () => {
        const cursor = (await env.OAUTH_KV.get('purge-cursor')) ?? undefined;
        const result = await authorizationServer(env).purgeExpiredData(env, { batchSize: 100, cursor });
        if (result.cursor) await env.OAUTH_KV.put('purge-cursor', result.cursor);
        else await env.OAUTH_KV.delete('purge-cursor');
      })(),
    );
    const storage = { bucket: env.REPO_STORAGE, git: gitHostFor(env) };
    ctx.waitUntil(resumeLifecycle(db, storage, Date.now()));
  },
} satisfies ExportedHandler<CloudflareBindings>;
