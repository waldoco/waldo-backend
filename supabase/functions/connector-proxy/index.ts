// Typed connector proxy. The only place a Google token is read, refreshed or used: the runtime
// sends a connection id and a typed operation, signed with the router secret, and gets data back.
import { readGoogleCalendarPushToken, validGooglePushAddress } from '../../../packages/runtime/src/connectors/google-push.ts';
import { exchangeGoogleCode, GOOGLE_METHODS, googleClient, googleHas, GoogleError, type GoogleErrorReason, type GoogleClient, type GoogleMethod } from '../../../packages/runtime/src/connectors/google.ts';
import { driveRestClient, DRIVE_REST_METHODS, DriveRestError, type DriveRestMethod } from '../../../packages/runtime/src/connectors/drive-rest.ts';
import { googleAccessToken, GoogleTokenError } from '../../../packages/runtime/src/connectors/google.ts';
import { executeProxyIntent, ProxyIntentError, type IntentClaim } from '../../../packages/runtime/src/connectors/proxy-intent.ts';
import { callMcpTransport, McpAuthError, McpToolError } from '../../../packages/runtime/src/connectors/mcp-transport.ts';
import { safeMcpErrorDiagnostic, type McpErrorDiagnostic } from '../../../packages/runtime/src/connectors/mcp-error-diagnostic.ts';
// Edge-owned, exact read authority. Never accept a request-supplied registry or generic Google host match.
const isRegisteredMcpRead = (serverUrl: string | undefined, tool: string | undefined) =>
  serverUrl === 'https://drivemcp.googleapis.com/mcp/v1' &&
  ['list_recent_files', 'search_files', 'get_file_metadata'].includes(tool ?? '');

declare const Deno: {env:{get(name:string):string|undefined};serve(handler:(request:Request)=>Promise<Response>):unknown};

const env = (name: string) => Deno.env.get(name) ?? '';
const url=env('SUPABASE_URL'), service=env('SUPABASE_SERVICE_ROLE_KEY'), router=env('WALDO_ROUTER_HMAC_SECRET'), clientId=env('GOOGLE_CLIENT_ID'), clientSecret=env('GOOGLE_CLIENT_SECRET');
const METHODS = [...GOOGLE_METHODS, ...DRIVE_REST_METHODS];
type Method = GoogleMethod;
const driveRead = (body: Body) => body.op === 'call' && DRIVE_REST_METHODS.includes(body.method as DriveRestMethod);

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
const fail = (status: number, message: string, diagnostic?: McpErrorDiagnostic, reason?: GoogleErrorReason) => reply({ error: { status, message, ...(reason ? { reason } : {}), ...(diagnostic ? { provider_diagnostic: diagnostic } : {}) } }, status === 401 || status === 403 || status === 404 ? 200 : 502);
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

type Body = Readonly<{ intent_id?: string; read_only?: boolean; do_name: string; op: 'exchange' | 'adopt' | 'call' | 'mcp_call'; server_url?: string; tool?: string; code?: string; code_verifier?: string; redirect_uri?: string; refresh_token?: string; email?: string; scopes?: string[]; connection?: string; method?: string; args?: unknown[] }>;
const nonStoringRead = (body: Body): boolean => body.op === 'mcp_call' && body.read_only === true && /^mcpread:[0-9a-f]{64}$/.test(body.intent_id ?? '') && isRegisteredMcpRead(body.server_url, body.tool);
const READ_FAILURE_CODES = new Set(['intent_unavailable', 'insufficient scopes', 'google_refresh_failed', 'google_reauth_needed', 'google_scope_missing', 'mcp_read_rejected', 'mcp_read_failed']);

// One structured line per call: operation, method, outcome and duration. Never the code, verifier,
// token, account or arguments.
const logged = async (started: number, op: string, method: string | undefined, response: Response, read = false) => {
  const outcome = await response.clone().json().then(value => (value as {error?:{status:number;message:string;provider_diagnostic?:unknown}}).error ?? null).catch(() => ({ status: response.status, message: 'unreadable response' }));
  const message = outcome && read && !READ_FAILURE_CODES.has(outcome.message) ? 'mcp_read_failed' : outcome?.message;
  const diagnostic = read && outcome && 'provider_diagnostic' in outcome ? safeMcpErrorDiagnostic(outcome.provider_diagnostic) : undefined;
  console.log(JSON.stringify({ hop: 'connector_proxy', op, ...(method ? { method } : {}), ok: !outcome, ms: Date.now() - started, ...(outcome ? { status: outcome.status, error: message } : {}), ...(diagnostic ? { provider_diagnostic: diagnostic } : {}) }));
  return response;
};

Deno.serve(async (request) => {
  const started = Date.now();
  if (request.method !== 'POST' || !router || !clientId || !clientSecret || !service) return logged(started, 'unconfigured', undefined, fail(404, 'connector proxy is not configured'));
  const raw = await request.text();
  const at = Number(request.headers.get('x-waldo-at'));
  if (!Number.isFinite(at) || Math.abs(Date.now() / 1000 - at) > 300 || !same(request.headers.get('x-waldo-sig') ?? '', await hmac(`${at}.proxy.${await sha256(raw)}`))) return logged(started, 'unsigned', undefined, fail(401, 'unsigned proxy call'));
  const body = JSON.parse(raw) as Body;
  return logged(started, body.op, body.op === 'call' ? body.method : undefined, await handle(body), body.op === 'mcp_call' && body.read_only === true);
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
      // A non-retaining read request must never silently fall back to the retaining
      // effect rail. Ordinary calls (no read flag) keep their existing ledger.
      if (body.read_only === true && !nonStoringRead(body)) return fail(400, 'mcp_read_rejected');
      if (!body.connection || !body.server_url || !body.tool || !/^https:\/\/([a-z0-9-]+\.)?googleapis\.com\//.test(body.server_url)) return fail(404, 'unknown operation');
      // Each signed read is an independent observation on this explicit connection.
      // No exactly-once/result replay promise and no effect-ledger claim or result storage.
      const read = nonStoringRead(body);
      const access = read ? await db('proxy_access', { p_do_name: body.do_name, p_connection: body.connection }) as {secret:string;scopes:unknown}[] : undefined;
      const grant = Array.isArray(access) ? access[0] : undefined;
      if (read && (!grant || typeof grant.secret !== 'string' || !grant.secret)) return fail(503, 'intent_unavailable');
      if (read && !googleHas(Array.isArray(grant?.scopes) ? grant.scopes : undefined, 'drive')) return fail(403, 'insufficient scopes');
      const mcpToken = read ? grant?.secret : await db('proxy_secret', { p_do_name: body.do_name, p_connection: body.connection }) as string | null;
      if (!mcpToken) return fail(body.intent_id?503:401, body.intent_id?'intent_unavailable':'connection unavailable');
      try {
        const dispatch = async()=> {
          const access = await googleAccessToken(app, { refresh_token: mcpToken }, fetch);
          return (await callMcpTransport({ url: body.server_url! }, body.tool!, ((body.args ?? [])[0] ?? {}) as Record<string, unknown>, fetch, async () => access)).content ?? null;
        };
        const content = read ? await dispatch() : await intentDispatch(body, dispatch);
        await db('proxy_health', { p_do_name: body.do_name, p_connection: body.connection, p_error: '' }).catch(()=>{console.log(JSON.stringify({hop:'connector_proxy_health',ok:false,code:'unavailable'}));});
        return reply({ data: content ?? null });
      } catch (error) {
        if(error instanceof ProxyIntentError)return fail(error.code==='intent_conflict'?409:503,error.code);
        // Read failures are provider-controlled content too. Never put that content in
        // response errors or health telemetry: logged() persists the error message.
        if (read) {
          if (error instanceof GoogleTokenError && error.kind === 'auth') await db('proxy_health', { p_do_name: body.do_name, p_connection: body.connection, p_error: 'google_refresh_failed' }).catch(()=>{console.log(JSON.stringify({hop:'connector_proxy_health',ok:false,code:'unavailable'}));});
          return fail(error instanceof GoogleTokenError ? error.status : error instanceof McpAuthError ? error.status : error instanceof McpToolError ? 400 : 502,
            error instanceof GoogleTokenError ? 'google_refresh_failed' : error instanceof McpAuthError ? error.status === 401 ? 'google_reauth_needed' : 'google_scope_missing' : error instanceof McpToolError ? 'mcp_read_rejected' : 'mcp_read_failed', error instanceof McpToolError ? safeMcpErrorDiagnostic(error.diagnostic) : undefined);
        }
        if (error instanceof GoogleTokenError && error.kind === 'auth') await db('proxy_health', { p_do_name: body.do_name, p_connection: body.connection, p_error: 'google_refresh_failed' });
        return fail(error instanceof GoogleTokenError ? error.status : error instanceof McpAuthError ? error.status : 502, error instanceof Error ? error.message : String(error));
      }
    }
    if (body.op !== 'call' || !body.connection || !METHODS.includes(body.method as Method)) return fail(404, 'unknown operation');
    const access = await db('proxy_access', { p_do_name: body.do_name, p_connection: body.connection }) as {secret:string;scopes:unknown}[];
    const grant=Array.isArray(access)?access[0]:undefined;
    if(!grant||typeof grant.secret!=='string'||!grant.secret)return fail(body.intent_id?503:401,body.intent_id?'intent_unavailable':'connection unavailable');
    if (driveRead(body)) {
      const scopes = Array.isArray(grant.scopes) ? grant.scopes : [];
      const allowedScopes = body.method === 'driveReadFileContent' ? ['drive.readonly'] : ['drive.readonly','drive.metadata.readonly'];
      if (!allowedScopes.some(scope => scopes.includes(`https://www.googleapis.com/auth/${scope}`))) return fail(403, 'drive_scope_missing',undefined,'ACCESS_TOKEN_SCOPE_INSUFFICIENT');
      if (!Array.isArray(body.args) || body.args.length !== 1) return fail(400, 'drive_invalid_request');
      // Drive wraps bearer errors; retain the typed refresh failure before that boundary.
      let refreshFailure: GoogleTokenError | undefined;
      const client = driveRestClient(fetch, () => googleAccessToken(app, { refresh_token: grant.secret }, fetch).catch((error: unknown) => {
        if (error instanceof GoogleTokenError) refreshFailure = error;
        throw error;
      }));
      try {
        const data = await (client[body.method as DriveRestMethod] as (args: unknown) => Promise<unknown>)(body.args[0]);
        await db('proxy_health', { p_do_name: body.do_name, p_connection: body.connection, p_error: '' }).catch(() => { console.log(JSON.stringify({hop:'connector_proxy_health',ok:false,code:'unavailable'})); });
        return reply({ data });
      } catch (error) {
        if (refreshFailure?.kind === 'auth') await db('proxy_health', { p_do_name: body.do_name, p_connection: body.connection, p_error: 'google_refresh_failed' }).catch(() => { console.log(JSON.stringify({hop:'connector_proxy_health',ok:false,code:'unavailable'})); });
        return fail(refreshFailure ? refreshFailure.status : error instanceof DriveRestError ? error.status : 502, refreshFailure ? refreshFailure.kind === 'auth' ? 'drive_auth_failed' : 'google_refresh_failed' : error instanceof DriveRestError ? error.code : 'drive_read_failed');
      }
    }
    const scopes=Array.isArray(grant.scopes)?grant.scopes:undefined;
    const readFeature=['calendarPage','events','event','eventInCalendar','changedEvents','changedEventsPage','watchCalendarEvents'].includes(body.method!)?'calendar':body.method==='calendarListsPage'?'calendar_list':['taskListsPage','tasksPage','allTasksPage','taskList','task','tasks'].includes(body.method!)?'tasks':body.method==='freeBusy'?'availability':['mailPage','findDraftByMessageId','readDraft','findSentByMessageId','newMail','searchMail','readThread','threadPage','messageBodyPage','watchMail'].includes(body.method!)?'mail':null;
    if(readFeature&&!googleHas(scopes,readFeature))return fail(403,'insufficient scopes',undefined,'ACCESS_TOKEN_SCOPE_INSUFFICIENT');
    const required = body.method==='sendRaw' ? 'gmail.send' : body.method==='draft' ? 'gmail.compose' : ['createTask','patchTask'].includes(body.method!) ? 'tasks' : ['createEvent','moveEvent','cancelEvent'].includes(body.method!) ? 'calendar.events' : null;
    if(required && (!Array.isArray(grant.scopes)||!grant.scopes.includes(`https://www.googleapis.com/auth/${required}`)))return fail(body.intent_id?503:403,body.intent_id?'intent_unavailable':'insufficient scopes');
    // Subscription destinations are owned by server configuration. A signed runtime caller
    // cannot nominate a topic/URL or manufacture another owner's channel token.
    if (body.method === 'watchMail') {
      const topic = env('WALDO_GOOGLE_GMAIL_PUBSUB_TOPIC');
      if (!topic || !Array.isArray(body.args) || body.args.length !== 1 || body.args[0] !== topic) return fail(503, 'source_push_unavailable');
    }
    if (body.method === 'watchCalendarEvents') {
      const address = env('WALDO_GOOGLE_CALENDAR_PUSH_URL');
      const [calendarId, channel] = body.args ?? [];
      if (!address || !validGooglePushAddress(address) || body.args?.length !== 2 || typeof calendarId !== 'string' || !channel || typeof channel !== 'object' || Array.isArray(channel)) return fail(503, 'source_push_unavailable');
      const row = channel as Record<string, unknown>;
      const witness = typeof row.token === 'string' ? await readGoogleCalendarPushToken(router, row.token) : null;
      if (row.address !== address || !witness || witness.ownerKey !== body.do_name || witness.connectionId !== body.connection || witness.calendarId !== calendarId || witness.channelId !== row.id) return fail(403, 'source_push_rejected');
    }
    const token=grant.secret;
    const pushRegistration=body.method==='watchMail'||body.method==='watchCalendarEvents';
    const assertPushGrant=async()=>{
      const fresh=await db('proxy_access',{p_do_name:body.do_name,p_connection:body.connection}) as {secret:string;scopes:unknown}[];
      const latest=Array.isArray(fresh)?fresh[0]:undefined;
      if(!latest||latest.secret!==grant.secret||JSON.stringify(Array.isArray(latest.scopes)?[...latest.scopes].sort():null)!==JSON.stringify(Array.isArray(grant.scopes)?[...grant.scopes].sort():null))throw new GoogleError(403,'source_push_admission_changed');
    };
    // Refresh can await a network hop. Read current owner/connection grants again immediately
    // before the provider registration and after its receipt; an old bearer never bypasses
    // revocation. A post-dispatch rejection leaves the host's attempt unknown until expiry.
    const providerFetch:typeof fetch=pushRegistration?async(input,init)=>{const address=String(input),register=init?.method==='POST'&&(address.endsWith('/watch'));if(register)await assertPushGrant();const response=await fetch(input,init);if(register)await assertPushGrant();return response;}:fetch;
    const client = googleClient(app, { refresh_token: token }, providerFetch, undefined, {connection_id:body.connection,email:null});
    try {
      const dispatch=async()=> (await (client[body.method as Method] as (...args: unknown[]) => Promise<unknown>)(...(body.args ?? [])))??null;
      const data = ['draft','sendRaw','createEvent','moveEvent','cancelEvent','createTask','patchTask'].includes(body.method!) ? await intentDispatch(body,dispatch) : await dispatch();
      await db('proxy_health', { p_do_name: body.do_name, p_connection: body.connection, p_error: '' }).catch(()=>{console.log(JSON.stringify({hop:'connector_proxy_health',ok:false,code:'unavailable'}));});
      return reply({ data: data ?? null });
    } catch (error) {
      if(error instanceof ProxyIntentError)return fail(error.code==='intent_conflict'?409:503,error.code);
      if (error instanceof GoogleTokenError && error.kind === 'auth') await db('proxy_health', { p_do_name: body.do_name, p_connection: body.connection, p_error: 'google_refresh_failed' });
      return fail(error instanceof GoogleTokenError ? error.status : error instanceof GoogleError ? error.status : 502, error instanceof Error ? error.message : String(error), undefined, error instanceof GoogleError ? error.reason : undefined);
    }
  } catch (error) {
    if (driveRead(body)) return fail(502, 'drive_read_failed');
    if (body.op === 'mcp_call' && body.read_only === true) return fail(502, 'mcp_read_failed');
    return fail(502, error instanceof Error ? error.message : String(error));
  }
};
