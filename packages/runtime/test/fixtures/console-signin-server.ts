// Synthetic local UI only: no provider, directory, session or credential access.
import { createServer } from 'node:http';
import { handleConsole } from '../../src/channels/console-signin';
import type { ConsoleAuth } from '../../src/identity/console-auth';
const delay = process.argv.includes('--slow') ? 15_000 : 400;
let sends = 0;
let verifies = 0;
let consoleGets = 0;
let consoleCookieAccepted = false;
const requests: { method: string | undefined; path: string | undefined }[] = [];
const auth = {
  sendCode: async () => { sends++; await new Promise(resolve => setTimeout(resolve, delay)); return true; },
  verify: async (_email: string, code: string) => { verifies++; await new Promise(resolve => setTimeout(resolve, delay)); return code === '000000' ? 'fixture-owner' : null; },
  ownerCookie: async () => 'fixture-owner-cookie',
  throttle: async () => true,
  readOwnerCookie: async () => null,
} as unknown as ConsoleAuth;
const env = {
  TELEGRAM_OWNER_DO: { idFromName: (name: string) => name, get: () => ({ fetch: async () => new Response('fixture-console-cookie') }) } as unknown as DurableObjectNamespace,
  RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) } as RateLimit,
};
createServer(async (req, res) => {
  res.setHeader('content-type', 'text/html; charset=utf-8');
  if (req.url === '/fixture-counts') { res.end(JSON.stringify({ sends, verifies, consoleGets, consoleCookieAccepted, requests })); return; }
  requests.push({ method: req.method, path: req.url });
  if (req.url === '/console') {
    if (req.method === 'GET') consoleGets++;
    consoleCookieAccepted = (req.headers.cookie ?? '').includes('waldo_console=fixture-console-cookie') && (req.headers.cookie ?? '').includes('waldo_owner=fixture-owner-cookie');
    res.writeHead(consoleCookieAccepted ? 200 : 401);
    res.end(consoleCookieAccepted ? '<h1>Fixture authenticated console</h1>' : '<h1>Fixture session missing</h1>');
    return;
  }
  if (req.url === '/away') { res.end('<a href="/console/signin">Return to sign-in</a>'); return; }
  if (!['/console/signin', '/console/verify'].includes(req.url ?? '')) { res.writeHead(404); res.end(); return; }
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(Buffer.from(chunk));
  const request = new Request(`http://127.0.0.1:4316${req.url}`, {
    method: req.method === 'HEAD' ? 'GET' : req.method, headers: { 'content-type': 'application/x-www-form-urlencoded' },
    ...(req.method === 'POST' ? { body: Buffer.concat(chunks).toString() } : {}),
  });
  const response = await handleConsole(request, env, auth);
  const headers = response ? Object.fromEntries(response.headers) : {};
  delete headers['set-cookie'];
  // Node's Headers exposes separate Set-Cookie values; the Worker type omits this Node API.
  const cookies = (response?.headers as (Headers & { getSetCookie(): string[] }) | undefined)?.getSetCookie() ?? [];
  if (cookies.length) res.setHeader('set-cookie', cookies);
  res.writeHead(response?.status ?? 404, headers);
  res.end(response ? await response.text() : 'Not found');
}).listen(4316, '127.0.0.1', () => console.log('Synthetic sign-in fixture: http://127.0.0.1:4316/console/signin'));
