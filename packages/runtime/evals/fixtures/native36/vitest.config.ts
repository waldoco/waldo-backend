import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['evals/fixtures/native36/*.test.ts'] } });
