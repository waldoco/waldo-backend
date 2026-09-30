// Explicit opt-in only. Never included in CI or the normal test suite.
import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';
import { validModelCredential } from './src/llm/credential-shape';

const key = process.env.WALDO_SMOKE_OPENAI_KEY;
if (process.env.WALDO_RUN_LIVE_SMOKE !== 'reviewed' || !key?.trim())
  throw new Error('live smoke needs reviewed opt-in and a supervisor-supplied model key');
if (!validModelCredential(key))
  throw new Error('live smoke model credential has an invalid format; replace it through the secret store');
export default defineConfig({
  test: {
    include: ['test/owner-do-live-smoke.ts'], testTimeout: 180_000,
    reporters: ['default', 'json'], outputFile: { json: process.env.WALDO_SMOKE_REPORT_PATH ?? '/tmp/waldo-live-smoke.json' },
  },
  plugins: [cloudflareTest({
    miniflare: { bindings: {
      WALDO_ENV: 'test', RUN_LOOP_PROVIDER_MODE: 'fake',
      RUN_LOOP_LOCAL_INGRESS_TOKEN: 'test-run-loop-local-token-000000000000',
      RESPONSIBILITY_INGRESS_HMAC_SECRET: 'test-responsibility-ingress-hmac-secret-000000000000',
      TELEGRAM_BOT_TOKEN: 'fictional-smoke-bot', TELEGRAM_WEBHOOK_SECRET: 'fictional-smoke-secret',
      OPENAI_API_KEY: key, GOOGLE_CLIENT_ID: 'fictional-smoke-google', GOOGLE_CLIENT_SECRET: 'fictional-smoke-google',
    } }, wrangler: { configPath: './wrangler.jsonc' },
  })],
});
