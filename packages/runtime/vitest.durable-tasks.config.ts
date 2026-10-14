// Isolated worker-pool config: durable task steps are on only here, so other DO tests keep the deployed default (off).
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/task-steps-do.test.ts'], fileParallelism: false,
    // The crash tests reset the owner object mid-step; workerd reports the alarm it cut off as unhandled. Only that is ignored.
    onUnhandledError: (error) => !String((error as { message?: unknown })?.message ?? error).includes('crash mid-step'),
  },
  plugins: [cloudflareTest({
    miniflare: { bindings: {
      WALDO_ENV: 'test', RUN_LOOP_PROVIDER_MODE: 'fake',
      RUN_LOOP_LOCAL_INGRESS_TOKEN: 'test-run-loop-local-token-000000000000',
      RESPONSIBILITY_INGRESS_HMAC_SECRET: 'test-responsibility-ingress-hmac-secret-000000000000',
      TELEGRAM_BOT_TOKEN: '7:hermetic-test-bot-token',
      TELEGRAM_WEBHOOK_SECRET: 'hermetic-test-webhook-secret',
      OPENAI_API_KEY: 'hermetic-test-model-key',
      SUPABASE_PROJECT_URL: 'https://directory.invalid',
      SUPABASE_PUBLISHABLE_KEY: 'fictional-publishable',
      WALDO_ROUTER_HMAC_SECRET: 'fictional-router-secret',
      WALDO_DURABLE_TASKS: '1',
    } },
    wrangler: { configPath: './wrangler.jsonc' },
  })],
});
