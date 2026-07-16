import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: [
      'test/context-composer.test.ts',
      'test/context-composer-sqlite.test.ts',
      'test/recall-gateway.test.ts',
    ],
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
