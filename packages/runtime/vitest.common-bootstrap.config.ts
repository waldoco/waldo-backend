import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Match serving binding presence: common execution has its own registered provider,
// while legacy RunLoop provider configuration and local test seams are absent.
export default defineConfig({
  test: { include: ['test/common-run-loop-bootstrap.test.ts'], fileParallelism: false },
  plugins: [cloudflareTest({
    miniflare: { bindings: {
      WALDO_ENVIRONMENT: 'staging', COMMON_OWNER_TASKS: '1',
      SUPABASE_PROJECT_URL: 'https://common-bootstrap.fixture.invalid',
      SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key',
      WALDO_ROUTER_HMAC_SECRET: 'fictional-bootstrap-hmac',
    } },
    wrangler: { configPath: './wrangler.jsonc' },
  })],
});
