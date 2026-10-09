import { cloudflareTest } from '@cloudflare/vitest-pool-workers';
import { defineConfig } from 'vitest/config';

const url = process.env.COMPUTERD_HARNESS_URL;
if (!url) throw new Error('COMPUTERD_HARNESS_URL is required; start the actual local Docker computerd first.');
const parsed = new URL(url);
if (parsed.protocol !== 'http:' || !['127.0.0.1', 'localhost'].includes(parsed.hostname)) {
  throw new Error('Computer daemon test requires a loopback HTTP URL.');
}
export default defineConfig({
  plugins: [cloudflareTest({
    remoteBindings: false,
    wrangler: { configPath: './test/computer-daemon.wrangler.jsonc' },
    miniflare: { bindings: { COMPUTERD_HARNESS_URL: url } },
  })],
  test: { include: ['test/computer-daemon.test.ts'], fileParallelism: false, testTimeout: 60_000 },
});
