import { defineConfig } from 'vitest/config';
export default defineConfig({ test: { environment: 'node', include: ['test/cloudflare-public-read.test.ts', 'test/browser-owner-host.test.ts', 'test/public-fixture-browser.test.ts', 'test/browser-task-continuity.test.ts', 'test/browser-task-handler.test.ts'], fileParallelism: false } });
