// Typed connector proxy. The only place a Google token is read, refreshed or used: the runtime
// sends a connection id and a typed operation, signed with the router secret, and gets data back.
import { exchangeGoogleCode, googleClient, GoogleError, type GoogleClient } from '../../../packages/runtime/src/connectors/google.ts';

const env = (name: string) => Deno.env.get(name) ?? '';
const [url, service, router, clientId, clientSecret] = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'WALDO_ROUTER_HMAC_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].map(env);
const METHODS = ['events', 'draft', 'event', 'createEvent', 'moveEvent', 'cancelEvent', 'changedEvents', 'newMail'] as const;
type Method = (typeof METHODS)[number];

const hex = (bytes: ArrayBuffer) => [...new Uint8Array(bytes)].map((byte) => byte.toString(16).padStart(2, '0')).join('');
const sha256 = async (text: string) => hex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(text)));
const hmac = async (message: string) => {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(router), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return hex(await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(message)));
};
const same = (a: string, b: string) => {
  let diff = a.length ^ b.length;
  for (let i = 0; i < a.length; i += 1) diff |= a.charCodeAt(i) ^ (b.charCodeAt(i) || 0);
  return diff === 0;
};
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (status: number, message: string) => reply({ error: { status, message } }, status === 401 || status === 403 || status === 404 ? 200 : 502);
const db = async (fn: string, args: Record<string, string>) => {
  const response = await fetch(`${url}/rest/v1/rpc/${fn}`, {
    method: 'POST', headers: { apikey: service, authorization: `Bearer ${service}`, 'content-profile': 'waldo', 'content-type': 'application/json' }, body: JSON.stringify(args),
  });
  if (!response.ok) throw new Error(`db ${fn} ${response.status}`);
  return response.json();
};
const store = async (doName: string, email: string, scopes: readonly string[], token: string) => {
  const id = await db('proxy_store', { p_do_name: doName, p_provider: 'google', p_account: email, p_scopes: scopes.join(' '), p_secret: token }) as string | null;
  return id ? reply({ id, email: email.toLowerCase(), scopes }) : fail(404, 'unknown owner');
};

type Body = Readonly<{ do_name: string; op: 'exchange' | 'adopt' | 'call'; code?: string; code_verifier?: string; redirect_uri?: string; refresh_token?: string; email?: string; scopes?: string[]; connection?: string; method?: string; args?: unknown[] }>;

// One structured line per call: operation, method, outcome and duration. Never the code, verifier,
// token, account or arguments.
const logged = async (started: number, op: string, method: string | undefined, response: Response) => {
  const outcome = await response.clone().json().then((json: { error?: { status: number; message: string } }) => json.error ?? null).catch(() => ({ status: response.status, message: 'unreadable response' }));
  console.log(JSON.stringify({ hop: 'connector_proxy', op, ...(method ? { method } : {}), ok: !outcome, ms: Date.now() - started, ...(outcome ? { status: outcome.status, error: outcome.message } : {}) }));
  return response;
};

Deno.serve(async (request) => {
  const started = Date.now();
  if (request.method !== 'POST' || !router || !clientId || !clientSecret || !service) return logged(started, 'unconfigured', undefined, fail(404, 'connector proxy is not configured'));
  const raw = await request.text();
  const at = Number(request.headers.get('x-waldo-at'));
  if (!Number.isFinite(at) || Math.abs(Date.now() / 1000 - at) > 300 || !same(request.headers.get('x-waldo-sig') ?? '', await hmac(`${at}.proxy.${await sha256(raw)}`))) return logged(started, 'unsigned', undefined, fail(401, 'unsigned proxy call'));
  const body = JSON.parse(raw) as Body;
  return logged(started, body.op, body.op === 'call' ? body.method : undefined, await handle(body));
});

const handle = async (body: Body): Promise<Response> => {
  const app = { clientId, clientSecret, redirectUri: body.redirect_uri ?? '' };
  try {
    if (body.op === 'exchange' && body.code) {
      const tokens = await exchangeGoogleCode(app, body.code, fetch, body.code_verifier);
      return store(body.do_name, tokens.email ?? 'google', tokens.scopes ?? [], tokens.refresh_token);
    }
    // One-time move of a token saved in the Durable Object before this proxy existed.
    if (body.op === 'adopt' && body.refresh_token) return store(body.do_name, body.email ?? 'google', body.scopes ?? [], body.refresh_token);
    if (body.op !== 'call' || !body.connection || !METHODS.includes(body.method as Method)) return fail(404, 'unknown operation');
    const token = await db('proxy_secret', { p_do_name: body.do_name, p_connection: body.connection }) as string | null;
    if (!token) return fail(401, 'connection unavailable');
    let refreshError = '';
    const client = googleClient(app, { refresh_token: token }, fetch, (error) => { refreshError = error; });
    try {
      const data = await (client[body.method as Method] as (...args: unknown[]) => Promise<unknown>)(...(body.args ?? []));
      await db('proxy_health', { p_do_name: body.do_name, p_connection: body.connection, p_error: '' });
      return reply({ data: data ?? null });
    } catch (error) {
      if (refreshError) await db('proxy_health', { p_do_name: body.do_name, p_connection: body.connection, p_error: refreshError });
      return fail(refreshError ? 401 : error instanceof GoogleError ? error.status : 502, error instanceof Error ? error.message : String(error));
    }
  } catch (error) {
    return fail(502, error instanceof Error ? error.message : String(error));
  }
};
