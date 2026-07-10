import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Runtime fakes intentionally keep process-local state across DO eviction; keep files serial
    // so per-test resets cannot race another file's fake-sink assertions.
    fileParallelism: false,
  },
  plugins: [
    cloudflareTest({
      miniflare: {
        bindings: {
          WALDO_ENV: 'test',
          RUN_LOOP_PROVIDER_MODE: 'fake',
          RUN_LOOP_LOCAL_INGRESS_TOKEN: 'test-run-loop-local-token-000000000000',
        },
      },
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
});
