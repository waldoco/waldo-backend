import { defineConfig } from 'vitest/config';

// Synthetic provider doubles and in-memory SQLite only; no Worker or provider bindings.
export default defineConfig({ test: { include: ['test/google-recovery-journey.test.ts'] } });
