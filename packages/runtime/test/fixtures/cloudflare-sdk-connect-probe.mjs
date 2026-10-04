const calls = [];
const binding = { fetch: async (url, init) => {
  calls.push({ url: String(url), method: init?.method ?? 'GET', body: init?.body ?? null });
  if (init?.method === 'POST') return new Response(JSON.stringify({ sessionId: 'unexpected-allocation' }), { status: 200 });
  return new Response('Mock transport stops before CDP', { status: Number(process.argv[2] ?? 503) });
} };
globalThis.__fixtureWorkerEnv = { BROWSER: binding };
const sdk = await import('@cloudflare/playwright');
const endpoint = new URL(sdk.endpointURLString(binding, { sessionId: 'retained-session' }));
endpoint.searchParams.set('persistent', 'true');
try { await sdk.connect(endpoint); } catch { /* intentional closed transport */ }
process.stdout.write(JSON.stringify(calls));
