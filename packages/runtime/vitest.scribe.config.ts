import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: [
      'test/scribe-sanitiser.test.ts',
      'test/scribe-sanitiser.property.test.ts',
    ],
    fileParallelism: false,
  },
});
