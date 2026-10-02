// Synthetic local UI only: no provider, directory, session or credential access.
import { createServer } from 'node:http';
import { handleConsole } from '../../src/channels/console-signin';
import type { ConsoleAuth } from '../../src/identity/console-auth';
const delay = process.argv.includes('--slow') ? 15_000 : 400;
let sends = 0;
let verifies = 0;
const auth = {
  sendCode: async () => { sends++; await new Promise(resolve => setTimeout(resolve, delay)); return true; },
  verify: async () => { verifies++; await new Promise(resolve => setTimeout(resolve, delay)); return null; },
  throttle: async () => true,
  readOwnerCookie: async () => null,
} as unknown as ConsoleAuth;
const env = {
  TELEGRAM_OWNER_DO: {} as DurableObjectNamespace,
  RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
};
createServer(async (req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url === '/fixture-counts') { res.end(JSON.stringify({ sends, verifies })); return; }
  if (req.url === '/away') { res.end('<a href="/console/signin">Return to sign-in</a>'); return; }
  if (!['/console/signin', '/console/verify'].includes(req.url ?? '')) { res.writeHead(404); res.end(); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const request = new Request(`http://127.0.0.1:4316${req.url}`, {
    method: req.method === 'HEAD' ? 'GET' : req.method, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    ...(req.method === 'POST' ? { body: Buffer.concat(chunks).toString() } : {}),
  });
  const response = await handleConsole(request, env, auth);
  res.writeHead(response?.status ?? 404, response ? Object.fromEntries(response.headers) : {});
  res.end(response ? await response.text() : 'Not found');
}).listen(4316, '127.0.0.1', () => console.log('Synthetic sign-in fixture: http://127.0.0.1:4316/console/signin'));
