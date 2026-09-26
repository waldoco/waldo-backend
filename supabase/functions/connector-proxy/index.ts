// Typed connector proxy. The only place a Google token is read, refreshed or used: the runtime
// sends a connection id and a typed operation, signed with the router secret, and gets data back.
import { exchangeGoogleCode, googleClient, googleHas, GoogleError, type GoogleClient } from '../../../packages/runtime/src/connectors/google.ts';
import { PROXY_METHODS, PROXY_METHOD_FEATURE, validateProxyArgs, validCorrelationTrace, type ProxyMethod } from '../../../packages/runtime/src/connectors/proxy-methods.ts';

const env = (name: string) => Deno.env.get(name) ?? '';
const [url, service, router, clientId, clientSecret] = ['SUPABASE_URL', 'SUPABASE_SERVICE_ROLE_KEY', 'WALDO_ROUTER_HMAC_SECRET', 'GOOGLE_CLIENT_ID', 'GOOGLE_CLIENT_SECRET'].map(env);
// The allowlist, arg bounds and scope-gate map come from the shared module - both sides must agree.
type Method = ProxyMethod;

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
// Whole-body cap: the args envelope is 2MB, so 2.5MB covers it plus op/connection framing.
const MAX_BODY_BYTES = 2_500_000;
const reply = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
const fail = (status: number, message: string) => reply({ error: { status, message } }, status === 401 || status === 403 || status === 404 ? 200 : 502);
const db = async (fn: string, args: Record<string, unknown>) => {
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

type Body = Readonly<{ do_name: string; op: 'exchange' | 'adopt' | 'call'; code?: string; code_verifier?: string; redirect_uri?: string; refresh_token?: string; email?: string; scopes?: string[]; connection?: string; method?: string; args?: unknown[]; intent?: string; trace?: string }>;

// One structured line per call: operation, method, outcome and duration. Never the code, verifier,
// token, account or arguments.
// Provider errors can carry Google response text (addresses, query details): EF sinks emit only
// bounded typed status/codes, never the provider message or body.
const logged = async (started: number, op: string, method: string | undefined, response: Response, trace?: string) => {
  const outcome = await response.clone().json().then((json: { error?: { status: number; message: string } }) => json.error ?? null).catch(() => ({ status: response.status, message: 'unreadable response' }));
  // trace is the opaque, shape-validated turn correlation key - it joins this call to the exact
  // Telegram/Langfuse turn. Still never do_name, connection, args, account, content or tokens.
  console.log(JSON.stringify({ hop: 'connector_proxy', op, ...(method ? { method } : {}), ok: !outcome, ms: Date.now() - started, ...(trace ? { trace } : {}), ...(outcome ? { status: outcome.status, error: outcome.message } : {}) }));
  return response;
};

Deno.serve(async (request) => {
  const started = Date.now();
  if (request.method !== 'POST' || !router || !clientId || !clientSecret || !service) return logged(started, 'unconfigured', undefined, fail(404, 'proxy_not_configured'));
  // Bound the bytes BEFORE any read and hash: the signature covers the whole body, so the cap
  // must come first. Content-Length is optional and untrusted, so the body is then read through
  // a byte-counted stream - the read itself is bounded, never buffered whole and measured after.
  const declared = Number(request.headers.get('content-length') ?? '0');
  if (declared > MAX_BODY_BYTES) return logged(started, 'oversize', undefined, fail(413, 'proxy_request_too_large'));
  const readBounded = async (): Promise<string | null> => {
    if (!request.body) return '';
    const reader = request.body.getReader();
    const decoder = new TextDecoder();
    let text = '';
    let total = 0;
    for (;;) {
      const { done, value } = await reader.read();
      if (done) return text;
      total += value.byteLength;
      if (total > MAX_BODY_BYTES) {
        await reader.cancel().catch(() => undefined);
        return null;
      }
      text += decoder.decode(value, { stream: true });
    }
  };
  const raw = await readBounded();
  if (raw === null) return logged(started, 'oversize', undefined, fail(413, 'proxy_request_too_large'));
  const at = Number(request.headers.get('x-waldo-at'));
  if (!Number.isFinite(at) || Math.abs(Date.now() / 1000 - at) > 300 || !same(request.headers.get('x-waldo-sig') ?? '', await hmac(`${at}.proxy.${await sha256(raw)}`))) return logged(started, 'unsigned', undefined, fail(401, 'unsigned_proxy_call'));
  const body = JSON.parse(raw) as Body;
  // Correlation key is optional but shape-enforced when present: an invalid trace is rejected,
  // never logged, so the correlation field can never smuggle free-form content into the sinks.
  const trace = validCorrelationTrace(body.trace);
  if (body.trace !== undefined && trace === undefined) return logged(started, body.op ?? 'call', undefined, fail(404, 'invalid_trace'));
  return logged(started, body.op, body.op === 'call' ? body.method : undefined, await handle(body), trace);
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
    if (body.op !== 'call' || !body.connection || !(PROXY_METHODS as readonly string[]).includes(body.method ?? '')) return fail(404, 'unknown operation');
    const method = body.method as Method;
    // Bounds before any token is touched; args are validated, never logged or stored here.
    const argsError = validateProxyArgs(method, body.args ?? []);
    if (argsError) return fail(404, argsError);
    // Owner gate (owner_id_for inside the SQL) plus scope gate: the stored grant must cover the
    // method's feature before the proxy spends the token on it.
    const access = await db('proxy_access', { p_do_name: body.do_name, p_connection: body.connection }) as { secret: string; scopes: string[] | null }[];
    const token = access[0]?.secret ?? null;
    if (!token) return fail(401, 'connection unavailable');
    if (!googleHas(access[0]!.scopes, PROXY_METHOD_FEATURE[method])) return fail(403, `scope_missing: ${PROXY_METHOD_FEATURE[method]}`);
    // Durable per-approved-intent idempotency at the send boundary: the signed HMAC call is
    // replayable inside its 5-minute window and Gmail Message-ID is not a provider idempotency
    // guarantee, so the proxy itself refuses a second send of one approved intent. The key is
    // the owner's unique immutable approval-intent id plus a content digest - two DISTINCT
    // approved identical emails are two intents and both send; a same-intent replay returns the
    // stored receipt; a pending (ambiguous) first attempt replays as 409 unknown-outcome.
    let idemKey: string | null = null;
    if (method === 'sendRaw') {
      if (typeof body.intent !== 'string' || body.intent.length === 0 || body.intent.length > 512) return fail(404, 'send_raw_requires_intent');
      idemKey = body.intent;
      const digest = await sha256(JSON.stringify(body.args ?? []));
      const claim = await db('proxy_idem_claim', { p_do_name: body.do_name, p_connection: body.connection, p_key: idemKey, p_digest: digest }) as { state: string; result?: unknown } | null;
      if (claim?.state === 'done') return reply({ data: claim.result ?? null });
      if (claim?.state === 'pending') return fail(409, 'send_in_flight_or_unknown_outcome');
      if (claim?.state === 'conflict') return fail(409, 'intent_reused_with_different_bytes');
      if (claim?.state !== 'new') return fail(401, 'connection unavailable');
    }
    let refreshError = '';
    const client = googleClient(app, { refresh_token: token }, fetch, (error) => { refreshError = error; });
    try {
      const data = await (client[method] as (...args: unknown[]) => Promise<unknown>)(...(body.args ?? []));
      if (idemKey !== null) {
        // The provider receipt must be durably confirmed BEFORE anything is reported: a failed
        // receipt write fails closed, never reported as sent. p_result passes the object itself;
        // PostgREST stores it as jsonb, so a replay returns { message_id }, not a JSON string.
        const stored = await db('proxy_idem_store', { p_do_name: body.do_name, p_connection: body.connection, p_key: idemKey, p_result: data ?? null }) as boolean;
        if (stored !== true) return fail(502, 'send_receipt_not_persisted');
      }
      // Health is best-effort bookkeeping: it never gates and never precedes the durable receipt.
      await db('proxy_health', { p_do_name: body.do_name, p_connection: body.connection, p_error: '' }).catch(() => undefined);
      return reply({ data: data ?? null });
    } catch (error) {
      if (refreshError) await db('proxy_health', { p_do_name: body.do_name, p_connection: body.connection, p_error: 'refresh_failed' }).catch(() => undefined);
      const status = refreshError ? 401 : error instanceof GoogleError ? error.status : 502;
      return fail(status, refreshError ? 'token_refresh_failed' : `google_error_${status}`);
    }
  } catch {
    return fail(502, 'proxy_internal_error');
  }
};
