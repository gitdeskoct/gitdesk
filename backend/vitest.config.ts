import path from 'node:path';
import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  plugins: [
    cloudflareTest(async () => ({
      wrangler: { configPath: './wrangler.jsonc' },
      remoteBindings: false,
      miniflare: {
        bindings: {
          TEST_MIGRATIONS: await readD1Migrations(
            path.join(import.meta.dirname, 'drizzle/migrations'),
          ),
          // Tests run as local development, whatever origin production uses.
          PUBLIC_ORIGIN: 'http://localhost:8787',
          GOOGLE_CLIENT_ID: 'test-client.apps.googleusercontent.com',
          GOOGLE_CLIENT_SECRET: 'test-client-secret',
          JWT_SIGNING_KEY: 'dGVzdC1zaWduaW5nLWtleS10aGF0LWlzLWxvbmctZW5vdWdo',
        },
      },
    })),
  ],
  test: { setupFiles: ['./test/apply-migrations.ts'] },
});
