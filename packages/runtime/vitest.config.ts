import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    // scenario-harness belongs to vitest.scenarios.config.ts (plain node): its run-l1 import of
    // node:sqlite externalizes mid-load in the workers pool and workerd can segfault under CI.
    exclude: ['test/console-signin-browser.test.ts', 'test/telegram-link-routing-do.test.ts', 'test/run-fence-owner-do.test.ts', 'test/google-account-projection.test.ts', 'test/communication-coverage.test.ts', 'test/browser-workspace-fixture.test.ts', 'test/owner-do-ingress-isolation.test.ts', 'test/scenario-harness.test.ts', 'test/waldo-native-suite.test.ts', 'test/reference-judgments.test.ts', 'test/grading-contract.test.ts', 'test/outcome-grader.test.ts', 'test/isolated-capture.test.ts', 'test/trial-provenance.test.ts', 'test/trial-result.test.ts', 'test/native-manifest.test.ts', 'test/isolated-telegram-ingress.test.ts', 'test/isolated-source-world.test.ts', 'test/isolated-google-client.test.ts', 'test/native-core-w06.test.ts', 'test/native-core-w03.test.ts', 'test/native-source-event.test.ts', 'test/native-selected-source.test.ts', 'test/native-provider-state.test.ts', 'test/native-case-bundle.test.ts', 'test/native-model-boundary.test.ts', 'test/native-runner.test.ts', 'test/native-usage-receipts.test.ts'],
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
          RESPONSIBILITY_INGRESS_HMAC_SECRET: 'test-responsibility-ingress-hmac-secret-000000000000',
        },
      },
      wrangler: { configPath: './wrangler.jsonc' },
    }),
  ],
});
