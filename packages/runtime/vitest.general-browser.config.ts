import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['test/general-browser*.test.ts'], fileParallelism: false } });
