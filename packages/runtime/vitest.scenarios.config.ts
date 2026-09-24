import { defineConfig } from 'vitest/config';

// L1 scenario harness runs in plain node: the scripted gateway replaces the live model and the
// sqlite shim replaces DO storage (same pattern as evals/run.ts via tsx), so no workers pool.
export default defineConfig({
  test: {
    include: ['test/scenario-harness.test.ts'],
  },
});
