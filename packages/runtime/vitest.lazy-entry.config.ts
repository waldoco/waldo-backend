import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// The deployed entry as main: Durable Object bindings resolve to its forwarding classes, not the full Worker's.
export default defineConfig({
  test: { include: ['test/lazy-entry.test.ts'] },
  plugins: [cloudflareTest({ main: './src/entry.ts', miniflare: { bindings: { WALDO_ENV: 'test', RUN_LOOP_PROVIDER_MODE: 'fake' } }, wrangler: { configPath: './wrangler.jsonc' } })],
});
