// Isolated worker-pool config: fictional credentials must not change other DO tests' defaults.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/owner-do-ingress-isolation.test.ts'], name: 'synthetic-common-caller' },
  plugins: [cloudflareTest({
    miniflare: { bindings: {
      COMMON_TEST_SKILL_LOAD:process.env.COMMON_TEST_SKILL_LOAD??'0',
      COMMON_TEST_FINAL_EXPIRED:process.env.COMMON_TEST_FINAL_EXPIRED??'0',
      COMMON_TEST_WORKSPACE_RESULT_FAULT:process.env.COMMON_TEST_WORKSPACE_RESULT_FAULT??'0',
      COMMON_TEST_FIRST_FINAL_FAULT:process.env.COMMON_TEST_FIRST_FINAL_FAULT??'0',
      COMMON_TEST_STOP_DURING_ACQUIRE:process.env.COMMON_TEST_STOP_DURING_ACQUIRE??'0',
      WALDO_ENV: 'test', RUN_LOOP_PROVIDER_MODE: 'fake', COMMON_OWNER_TASKS:'1', WALDO_EGRESS_ALLOWLIST:'public-pages.fixture.invalid',
      SUPABASE_PROJECT_URL:'https://common-source.fixture.invalid', SUPABASE_PUBLISHABLE_KEY:'common-source-fixture', WALDO_ROUTER_HMAC_SECRET:'common-source-fictional-hmac',
      // The verified owner email follows the text-capture switch (trace-privacy-owner-email.test.ts); this config models the staging vars in wrangler.jsonc (WALDO_ENVIRONMENT staging, capture true); the wrangler default is production, capture off.
      WALDO_ENVIRONMENT: 'staging', WALDO_OWNER_DO_NAMESPACE:'hermetic-owner-host', LANGFUSE_CAPTURE_TEXT: 'true',
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
