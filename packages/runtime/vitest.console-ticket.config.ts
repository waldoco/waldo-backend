import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/console-member-ticket-routing.test.ts'], fileParallelism: false },
  plugins: [cloudflareTest({
    miniflare: { bindings: {
      WALDO_ENV: 'test', RUN_LOOP_PROVIDER_MODE: 'fake',
      WALDO_ROUTER_HMAC_SECRET: 'synthetic-console-routing-secret',
      TELEGRAM_BOT_TOKEN: '7:hermetic-console-test-bot-token',
      OPENAI_API_KEY: 'hermetic-console-test-model-key',
      RUN_LOOP_LOCAL_INGRESS_TOKEN: 'test-run-loop-local-token-000000000000',
      RESPONSIBILITY_INGRESS_HMAC_SECRET: 'test-responsibility-ingress-hmac-secret-000000000000',
    } },
    wrangler: { configPath: './wrangler.jsonc' },
  })],
});
