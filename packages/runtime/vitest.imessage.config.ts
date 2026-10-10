import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// Dedicated iMessage connector suite. Every credential is fictional; the connector is enabled only
// here. Runtime traffic in these tests is in-isolate: signed RPCs go to an in-memory fixture model,
// the model is a scripted OpenAI mock and the host is simulated.
export default defineConfig({
  test: { include: ['test/imessage-bridge-store.test.ts', 'test/imessage-bridge-do.test.ts', 'test/imessage-e2e.test.ts'], fileParallelism: false },
  plugins: [cloudflareTest({
    miniflare: { bindings: {
      WALDO_ENV: 'test', RUN_LOOP_PROVIDER_MODE: 'fake', WALDO_ENVIRONMENT: 'test',
      OPENAI_API_KEY: 'fictional-imessage-model-key', COMMON_OWNER_TASKS: '0', WALDO_TOOL_OFFLOAD: '0', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_EGRESS_ALLOWLIST: '',
      SUPABASE_PROJECT_URL: 'https://imessage-directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-imessage-publishable',
      WALDO_ROUTER_HMAC_SECRET: 'fictional-imessage-router-secret-0000000000',
      IMESSAGE_CONNECTOR_ENABLED: '1', // Pinned equal to PROPOSED_LOCAL_TEST_POLICY by test/imessage-bridge-do.test.ts.
      IMESSAGE_CONNECTOR_POLICY: '{"signatureMaxAgeMs":60000,"heartbeatMaxAgeMs":90000,"capabilityMaxAgeMs":90000,"maxRequestBytes":131072,"maxRetainedBytes":16777216,"maxRecords":4096,"pullMaxWaitMs":0,"deliveryDeadlineMs":20000,"mutationDeadlineMs":30000,"commitmentMaxAgeMs":30000,"setupLifetimeMs":600000,"replyHandoffMaxAgeMs":600000,"source":"handoff-2026-10-10-proposed-local-test-profile"}',
      IMESSAGE_CREDENTIAL_WRAPPING_KEY: 'f'.repeat(64),
    } },
    wrangler: { configPath: './wrangler.jsonc' },
  })],
});
