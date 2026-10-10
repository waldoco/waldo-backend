import { defineConfig } from 'vitest/config';
// Exact provider-shaped doubles and per-test in-memory SQLite, no live effects.
export default defineConfig({ test: { include: ['test/google-task-writes.test.ts'] } });
