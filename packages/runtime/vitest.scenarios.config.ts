import { defineConfig } from 'vitest/config';

// L1 scenario harness runs in plain node: the scripted gateway replaces the live model and the
// sqlite shim replaces DO storage (same pattern as evals/run.ts via tsx), so no workers pool.
export default defineConfig({
  test: {
    include: ['test/scenario-harness.test.ts', 'test/waldo-native-suite.test.ts', 'test/reference-judgments.test.ts', 'test/grading-contract.test.ts', 'test/outcome-grader.test.ts', 'test/isolated-capture.test.ts', 'test/fixture-adapter-capture.test.ts', 'test/trial-provenance.test.ts', 'test/trial-result.test.ts', 'test/usage-reconciliation.test.ts', 'test/native-usage-receipts.test.ts', 'test/native-runner.test.ts', 'test/native-source-event.test.ts', 'test/native-selected-source.test.ts', 'test/native-provider-state.test.ts', 'test/native-case-bundle.test.ts', 'test/native-model-boundary.test.ts', 'test/native-manifest.test.ts', 'test/fixture-authority.test.ts', 'test/isolated-world-audit.test.ts', 'test/isolated-telegram-ingress.test.ts', 'test/isolated-source-world.test.ts', 'test/isolated-google-client.test.ts'],
  },
});
