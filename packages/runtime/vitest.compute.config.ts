import { defineConfig } from 'vitest/config';
// Adapter/service fakes here prove local invariants, never Cloudflare execution.
export default defineConfig({ test: { environment: 'node', include: ['test/compute-journal.test.ts', 'test/workspace-compute.test.ts', 'test/linux-container.test.ts'] } });
