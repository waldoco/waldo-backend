import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: { include: ['test/linux-container.test.ts'], environment: 'node' },
});
