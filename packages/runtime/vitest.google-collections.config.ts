import { defineConfig } from 'vitest/config';

// Connector + serving-handler tests with synthetic provider responses, no Worker or live resources.
export default defineConfig({ test: { include: ['test/google-collection-coverage.test.ts'], fileParallelism: false } });
