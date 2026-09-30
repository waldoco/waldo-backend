// Typed connector proxy. The only place a Google token is read, refreshed or used: the runtime
// sends a connection id and a typed operation, signed with the router secret, and gets data back.
import { exchangeGoogleCode, GOOGLE_METHODS, googleClient, GoogleError, type GoogleClient, type GoogleMethod } from '../../../packages/runtime/src/connectors/google.ts';
import { googleAccessToken } from '../../../packages/runtime/src/connectors/google.ts';
import { executeProxyIntent, ProxyIntentError, type IntentClaim } from '../../../packages/runtime/src/connectors/proxy-intent.ts';
import { callMcpTransport, McpAuthError } from '../../../packages/runtime/src/connectors/mcp-transport.ts';

declare const Deno: {env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):unknown};

const env = (name: string) => Deno.env.get(name) ?? '';
const url=env('SUPABASE_URL'), service=env('SUPABASE_SERVICE_ROLE_KEY'), router=env('WALDO_ROUTER_HMAC_SECRET'), clientId=env('GOOGLE_CLIENT_ID'), clientSecret=env('GOOGLE_CLIENT_SECRET');
const METHODS = GOOGLE_METHODS;
type Method = GoogleMethod;

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

type Body = Readonly<{ intent_id?: string; do_name: string; op: 'exchange' | 'adopt' | 'call' | 'mcp_call'; server_url?: string; tool?: string; code?: string; code_verifier?: string; redirect_uri?: string; refresh_token?: string; email?: string; scopes?: string[]; connection?: string; method?: string; args?: unknown[] }>;

// One structured line per call: operation, method, outcome and duration. Never the code, verifier,
// token, account or arguments.
const logged = async (started: number, op: string, method: string | undefined, response: Response) => {
  const outcome = await response.clone().json().then(value => (value as {error?:{status:number;message:string}}).error ?? null).catch(() => ({ status: response.status, message: 'unreadable response' }));
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

const intentDispatch = async (body: Body, dispatch: () => Promise<unknown>) => executeProxyIntent(
  body.intent_id ? {id:body.intent_id} : undefined,
  {do_name:body.do_name,connection:body.connection,op:body.op,method:body.method??null,server_url:body.server_url??null,tool:body.tool??null,args:body.args??[]},
  {
    claim: async(id,digest)=>await db('proxy_idem_claim',{p_do_name:body.do_name,p_connection:body.connection,p_key:id,p_digest:digest}) as IntentClaim|null,
    store: async(id,result)=>(await db('proxy_idem_store',{p_do_name:body.do_name,p_connection:body.connection,p_key:id,p_result:result}))===true,
  },dispatch);

const handle = async (body: Body): Promise<Response> => {
  const app = { clientId, clientSecret, redirectUri: body.redirect_uri ?? '' };
  try {
    if (body.op === 'exchange' && body.code) {
      const tokens = await exchangeGoogleCode(app, body.code, fetch, body.code_verifier);
      return store(body.do_name, tokens.email ?? 'google', tokens.scopes ?? [], tokens.refresh_token);
    }
    // One-time move of a token saved in the Durable Object before this proxy existed.
    if (body.op === 'adopt' && body.refresh_token) return store(body.do_name, body.email ?? 'google', body.scopes ?? [], body.refresh_token);
    // Google-auth MCP servers: the runtime names server/tool/args; the token never leaves the edge.
    if (body.op === 'mcp_call') {
      if (!body.connection || !body.server_url || !body.tool || !/^https:\/\/([a-z0-9-]+\.)?googleapis\.com\//.test(body.server_url)) return fail(404, 'unknown operation');
      const mcpToken = await db('proxy_secret', { p_do_name: body.do_name, p_connection: body.connection }) as string | null;
      if (!mcpToken) return fail(body.intent_id?503:401, body.intent_id?'intent_unavailable':'connection unavailable');
      let mcpRefreshError = '';
      try {
        const content = await intentDispatch(body, async()=> {
          const access = await googleAccessToken(app, { refresh_token: mcpToken }, fetch, (error) => { mcpRefreshError = error; });
          return (await callMcpTransport({ url: body.server_url! }, body.tool!, ((body.args ?? [])[0] ?? {}) as Record<string, unknown>, fetch, async () => access)).content ?? null;
        });
        await db('proxy_health', { p_do_name: body.do_name, p_connection: body.connection, p_error: '' }).catch(()=>{console.log(JSON.stringify({hop:'connector_proxy_health',ok:false,code:'unavailable'}));});
        return reply({ data: content ?? null });
      } catch (error) {
        if(error instanceof ProxyIntentError)return fail(error.code==='intent_conflict'?409:503,error.code);
        if (mcpRefreshError) await db('proxy_health', { p_do_name: body.do_name, p_connection: body.connection, p_error: mcpRefreshError });
        return fail(mcpRefreshError ? 401 : error instanceof McpAuthError ? error.status : 502, error instanceof Error ? error.message : String(error));
      }
    }
    if (body.op !== 'call' || !body.connection || !METHODS.includes(body.method as Method)) return fail(404, 'unknown operation');
    const access = await db('proxy_access', { p_do_name: body.do_name, p_connection: body.connection }) as {secret:string;scopes:unknown}[];
    const grant=Array.isArray(access)?access[0]:undefined;
    if(!grant||typeof grant.secret!=='string'||!grant.secret)return fail(body.intent_id?503:401,body.intent_id?'intent_unavailable':'connection unavailable');
    const required = body.method==='sendRaw' ? 'gmail.send' : body.method==='draft' ? 'gmail.compose' : ['createEvent','moveEvent','cancelEvent'].includes(body.method!) ? 'calendar.events' : null;
    if(required && (!Array.isArray(grant.scopes)||!grant.scopes.includes(`https://www.googleapis.com/auth/${required}`)))return fail(body.intent_id?503:403,body.intent_id?'intent_unavailable':'insufficient scopes');
    const token=grant.secret;
    let refreshError = '';
    const client = googleClient(app, { refresh_token: token }, fetch, (error) => { refreshError = error; });
    try {
      const dispatch=async()=> (await (client[body.method as Method] as (...args: unknown[]) => Promise<unknown>)(...(body.args ?? [])))??null;
      const data = ['draft','sendRaw','createEvent','moveEvent','cancelEvent'].includes(body.method!) ? await intentDispatch(body,dispatch) : await dispatch();
      await db('proxy_health', { p_do_name: body.do_name, p_connection: body.connection, p_error: '' }).catch(()=>{console.log(JSON.stringify({hop:'connector_proxy_health',ok:false,code:'unavailable'}));});
      return reply({ data: data ?? null });
    } catch (error) {
      if(error instanceof ProxyIntentError)return fail(error.code==='intent_conflict'?409:503,error.code);
      if (refreshError) await db('proxy_health', { p_do_name: body.do_name, p_connection: body.connection, p_error: refreshError });
      return fail(refreshError ? 401 : error instanceof GoogleError ? error.status : 502, error instanceof Error ? error.message : String(error));
    }
  } catch (error) {
    return fail(502, error instanceof Error ? error.message : String(error));
  }
};
