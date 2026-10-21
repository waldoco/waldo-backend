import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['test/live-memory.test.ts'], fileParallelism: false } });
