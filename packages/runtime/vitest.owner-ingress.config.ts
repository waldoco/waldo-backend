// Isolated worker-pool config: fictional credentials must not change other DO tests' defaults.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/owner-do-ingress-isolation.test.ts'] },
  plugins: [cloudflareTest({
    miniflare: { bindings: {
      WALDO_ENV: 'test', RUN_LOOP_PROVIDER_MODE: 'fake',
      RUN_LOOP_LOCAL_INGRESS_TOKEN: 'test-run-loop-local-token-000000000000',
      RESPONSIBILITY_INGRESS_HMAC_SECRET: 'test-responsibility-ingress-hmac-secret-000000000000',
      TELEGRAM_BOT_TOKEN: 'hermetic-test-bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'hermetic-test-webhook-secret',
      OPENAI_API_KEY: 'hermetic-test-model-key',
      GOOGLE_CLIENT_ID: 'hermetic-google-id',
      GOOGLE_CLIENT_SECRET: 'hermetic-google-secret',
    } },
    wrangler: { configPath: './wrangler.jsonc' },
  })],
});
