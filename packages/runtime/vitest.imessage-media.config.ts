import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

// iMessage with IMESSAGE_MEDIA on: photos and files are fetched from Photon for the model. Same fictional fixtures as
// vitest.imessage.config.ts; kept apart because the flag changes what every media message does. Photon is answered
// in-isolate by each test; the project secret is fictional.
export default defineConfig({
  test: { include: ['test/imessage-media.test.ts'], fileParallelism: false },
  plugins: [cloudflareTest({
    miniflare: { bindings: {
      WALDO_ENV: 'test', RUN_LOOP_PROVIDER_MODE: 'fake', WALDO_ENVIRONMENT: 'test',
      OPENAI_API_KEY: 'fictional-imessage-model-key', COMMON_OWNER_TASKS: '0', WALDO_TOOL_OFFLOAD: '0', WALDO_OWNER_TIMEZONE: 'UTC', WALDO_EGRESS_ALLOWLIST: '',
      SUPABASE_PROJECT_URL: 'https://imessage-directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-imessage-publishable',
      WALDO_ROUTER_HMAC_SECRET: 'fictional-imessage-router-secret-0000000000',
      IMESSAGE_CONNECTOR_ENABLED: '1',
      IMESSAGE_CONNECTOR_POLICY: '{"signatureMaxAgeMs":60000,"heartbeatMaxAgeMs":90000,"capabilityMaxAgeMs":90000,"maxRequestBytes":131072,"maxRetainedBytes":16777216,"maxRecords":4096,"pullMaxWaitMs":0,"deliveryDeadlineMs":20000,"mutationDeadlineMs":30000,"commitmentMaxAgeMs":30000,"setupLifetimeMs":600000,"replyHandoffMaxAgeMs":600000,"source":"handoff-2026-10-10-proposed-local-test-profile"}',
      IMESSAGE_CREDENTIAL_WRAPPING_KEY: 'f'.repeat(64),
      IMESSAGE_MEDIA: '1', PHOTON_PROJECT_ID: 'proj-fixture', PHOTON_PROJECT_SECRET: 'fictional-photon-project-secret-e2e-4d1b',
    } },
    wrangler: { configPath: './wrangler.jsonc' },
  })],
});
