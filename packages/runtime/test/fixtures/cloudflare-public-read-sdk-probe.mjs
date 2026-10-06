import { cloudflarePublicRead } from '../../src/channels/cloudflare-public-read.ts';
const calls = [];
const binding = { fetch: async (url, init) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET' });
  if (init?.method === 'POST') return Response.json({ sessionId: 'private-id' });
  return new Response('secret provider diagnostic', { status: 503 });
} };
globalThis.__fixtureWorkerEnv = { BROWSER: binding };
const sdk = await import('@cloudflare/playwright');
const result = await cloudflarePublicRead({ binding, loadSdk: async () => sdk })(
  { url: 'https://example.com/menu', instruction: 'Read menu', provider: 'cloudflare_playwright' },
  { authenticatedUserId: 'owner-a', egressAllowlist: ['*'], assertTaskSourceCurrent: async () => {} },
);
process.stdout.write(JSON.stringify({ calls, result }));
