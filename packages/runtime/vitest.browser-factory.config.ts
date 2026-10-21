import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['test/browser-production-factory.test.ts', 'test/browser-trial-consent.test.ts'], fileParallelism: false } });
