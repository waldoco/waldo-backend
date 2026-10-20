import { handleDeviceRedeem } from './devices/redeem-route';
import { handleDeviceConnect } from './devices/connect-route';
import { genericReject } from './devices/generic-reject';
import type { DeviceBridgeDO } from './devices/device-bridge-do';
import { handleTelegramWebhook, TELEGRAM_WEBHOOK_PATH } from './channels/telegram-webhook';
import { handleProbeTurn, PROBE_TURN_PATH } from './channels/probe-turn';
import { handleWhatsAppWebhook, WHATSAPP_WEBHOOK_PATH } from './channels/whatsapp-webhook';
import { EVENT_INGRESS_PREFIX, handleEventIngress } from './channels/event-ingress';
import { handleGoogleCallback } from './channels/google-oauth';
import { CONNECT_LINK_PREFIX, handleConnectTicket } from './channels/connect-link';
import { GOOGLE_CALLBACK_PATH } from './connectors/google';
import { CONSOLE_PATH } from './channels/console';
import { handleApp } from './channels/app-api';
import { handleConsoleChat } from './channels/console-chat';
import { ownerDirectory, signedRpc } from './identity/owner-directory';
import { sweepHealthRetention } from './health/retention-sweep';
import { downloadReturnTarget, handleConsole, CONSOLE_SIGNIN_PATH } from './channels/console-signin';
import { consoleAuth, OWNER_COOKIE } from './identity/console-auth';
import { readConsoleTicket } from './identity/console-ticket';
import { serveDashboard } from './channels/dashboard-static';
import { consoleLog, consoleTrace, withConsoleTrace } from './observability/console-correlation';
import type { GatewaySecretBinding } from './llm/gateway';

// The entry exports only Durable Object classes and the default handler. `wrangler dev --local`
// rejects constants or arrays exported from the Worker entry, so helpers are imported from their
// own modules, never re-exported here (pinned by test/worker-entry-exports.test.ts).
export { RunLoopDO, RuntimeProbeDO } from './retired-durable-objects';
export { DeviceBridgeDO } from './devices/device-bridge-do';
export { IMessageBridgeDO } from './channels/imessage/bridge-do';
export { OwnerDO } from './channels/owner-do';
export { TracerDO } from './tracer/tracer-do';
import type { RunLoopDO, RuntimeProbeDO } from './retired-durable-objects';
import type { TracerDO } from './tracer/tracer-do';
import type { IMessageBridgeDO } from './channels/imessage/bridge-do';
import { handleIMessageHost, isIMessageHostPath } from './channels/imessage/http';

// Augment the ambient worker env so both the DO base (typed on Cloudflare.Env)
// and the test's `env` import (also Cloudflare.Env) see the DO bindings.
declare global {
  namespace Cloudflare {
    interface Env {
      ASSETS?: Fetcher;
      RUNTIME_DO: DurableObjectNamespace<RuntimeProbeDO>;
      RUN_LOOP_DO: DurableObjectNamespace<RunLoopDO>;
      AI_GATEWAY_ID?: string;
      AI_GATEWAY_API_TOKEN?: GatewaySecretBinding;
      CLOUDFLARE_ACCOUNT_ID?: string;
      RUN_LOOP_PROVIDER_LIVE?: string;
      RUN_LOOP_PROVIDER_MODE?: string;
      RESPONSIBILITY_RATE_LIMITER?: RateLimit;
      SUPABASE_PROJECT_URL?: string;
      SUPABASE_PUBLISHABLE_KEY?: string;
      WALDO_ROUTER_HMAC_SECRET?: string;
      TRACER_DO: DurableObjectNamespace<TracerDO>;
      OWNER_DO?: DurableObjectNamespace;
      DEVICE_BRIDGE_DO?: DurableObjectNamespace<DeviceBridgeDO>;
      IMESSAGE_BRIDGE_DO?: DurableObjectNamespace<IMessageBridgeDO>;
      IMESSAGE_CONNECTOR_ENABLED?: string;
      IMESSAGE_CONNECTOR_POLICY?: string;
      IMESSAGE_CREDENTIAL_WRAPPING_KEY?: string;
      WALDO_ENVIRONMENT?: string;
      TELEGRAM_BOT_TOKEN?: string;
      TELEGRAM_WEBHOOK_SECRET?: string;
      GOOGLE_CLIENT_ID?: string;
      GOOGLE_CLIENT_SECRET?: string;
      WALDO_OWNER_TELEGRAM_ID?: string;
      OPENAI_API_KEY?: string;
      WALDO_ENV?: string;
      WALDO_RELEASE?: string;
    }
  }
}

type Env = Cloudflare.Env;

const forwardTicketConsole = async (request: Request, env: Env, issuer?: string): Promise<Response> => {
  if (!env.OWNER_DO || (!issuer && !env.WALDO_OWNER_TELEGRAM_ID)) return new Response('unauthorized', { status: 401 });
  const ownerRoute = issuer ? { doName: issuer } : await ownerDirectory(env).byPresence('telegram', env.WALDO_OWNER_TELEGRAM_ID!);
  if (!ownerRoute) return new Response('owner unavailable', { status: 503 });
  const doName = ownerRoute.doName;
  const forwarded = new Request(request);
  forwarded.headers.set('x-waldo-do-name', doName);
  return env.OWNER_DO.get(env.OWNER_DO.idFromName(doName)).fetch(forwarded);
};

const routedConsoleTicket = async (request: Request, env: Env): Promise<Response | null> => {
  const url = new URL(request.url);
  if (url.pathname !== CONSOLE_PATH || !['GET', 'POST'].includes(request.method)) return null;
  let value: string | null;
  try { value = request.method === 'GET' ? url.searchParams.get('t') : String((await request.clone().formData()).get('t') ?? ''); }
  catch { return new Response('invalid console request', { status: 400, headers: { 'cache-control': 'no-store' } }); }
  if (!value || /^[a-f0-9]{64}$/.test(value)) return null;
  const rejected = () => new Response('This console link is invalid or expired. Request a new link. If another account is signed in, sign out first.', { status: 403, headers: { 'cache-control': 'no-store' } });
  if (!value.startsWith('c1.') || !env.WALDO_ROUTER_HMAC_SECRET) return rejected();
  const ticket = await readConsoleTicket(value, env.WALDO_ROUTER_HMAC_SECRET);
  const auth = consoleAuth(env);
  if (!ticket || !auth) return rejected();
  const hasOwner = (request.headers.get('cookie') ?? '').split(';').some(part => part.trim().startsWith(`${OWNER_COOKIE}=`));
  try { if (hasOwner && await auth.readOwnerCookie(request) !== ticket.owner) return rejected(); }
  catch { return new Response('Sign-in is temporarily unavailable.', { status: 503, headers: { 'cache-control': 'no-store' } }); }
  const response = await forwardTicketConsole(request, env, ticket.owner);
  if (request.method !== 'POST' || response.status !== 303 || !response.headers.get('set-cookie')) return response;
  let ownerCookie: string | null;
  try { ownerCookie = await auth.ownerCookie(ticket.owner); }
  catch { ownerCookie = null; }
  if (!ownerCookie) return new Response('Sign-in is temporarily unavailable. Request a new link and try again.', { status: 503, headers: { 'cache-control': 'no-store' } });
  const headers = new Headers(response.headers);
  headers.append('set-cookie', `${OWNER_COOKIE}=${ownerCookie}; Path=${CONSOLE_PATH}; HttpOnly; Secure; SameSite=Strict; Max-Age=43200`);
  headers.set('cache-control', 'no-store');
  return new Response(response.body, { status: response.status, headers });
};

export default {
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    const ticketResponse = await routedConsoleTicket(request, env);
    if (ticketResponse) return ticketResponse;
    const appResponse = await handleApp(request, env, undefined, (work) => ctx?.waitUntil(work));
    if (appResponse) return appResponse;
    const consoleChat = await handleConsoleChat(request, env);
    if (consoleChat) return consoleChat;
    const devicePath = new URL(request.url).pathname;
    // iMessage host profile waldo-imessage-http-v1: registered before generic routes/assets; 404 unless composed.
    if (isIMessageHostPath(devicePath)) return handleIMessageHost(request, env as never);
    if (devicePath === '/devices/redeem') return request.method === 'POST' ? handleDeviceRedeem(request, env) : genericReject();
    if (devicePath === '/devices/connect') return request.method === 'GET' ? handleDeviceConnect(request, env) : genericReject();
    if (new URL(request.url).pathname === '/healthz') {
      return Response.json({ ok: true, release: env.WALDO_RELEASE ?? null });
    }
    if (new URL(request.url).pathname === TELEGRAM_WEBHOOK_PATH) {
      return handleTelegramWebhook(request, env, (work) => ctx?.waitUntil(work));
    }
    if (new URL(request.url).pathname === WHATSAPP_WEBHOOK_PATH) {
      return handleWhatsAppWebhook(request, env, (work) => ctx?.waitUntil(work));
    }
    if (new URL(request.url).pathname.startsWith(EVENT_INGRESS_PREFIX)) {
      return handleEventIngress(request, env, (work) => ctx?.waitUntil(work));
    }
    if (new URL(request.url).pathname === PROBE_TURN_PATH) {
      return handleProbeTurn(request, env);
    }
    // The authenticated dashboard API is still owned by handleConsole/owner DO.
    // This adapter handles only the read-only shell and content-hashed static assets.
    const dashboard = await serveDashboard(request, env.ASSETS, (authRequest) => handleConsole(authRequest, env).then((result) => result ?? forwardTicketConsole(authRequest, env)));
    if (dashboard) return dashboard;
    const consoleRequest = new URL(request.url).pathname.startsWith(CONSOLE_PATH);
    const consoleRequestTrace = consoleRequest ? consoleTrace() : null;
    if (consoleRequestTrace) {
      const signedIn = await handleConsole(request, env, undefined, consoleRequestTrace);
      if (signedIn) return signedIn;
    }
    if (new URL(request.url).pathname.startsWith(CONSOLE_PATH) && env.OWNER_DO && env.WALDO_OWNER_TELEGRAM_ID) {
      // The console must land on the owner's REAL DO - the one the Telegram webhook routes his
      // turns to. With Supabase configured that name comes from the owner directory (e.g.
      // 'owner-<uuid>' from console signup), not the env telegram id. Routing by the env id
      // served an empty shell DO: one-time links minted in the turn DO never redeemed (403),
      // and account.delete would have wiped the wrong DO. Directory failures stay fail-closed; the shell adapter logs a content-free failure class.
      // No fallback to a possibly-wrong DO beyond the designed no-directory single-owner path.
      const response = await forwardTicketConsole(request, env);
      // A ticket-only session uses this existing owner route. Preserve file intent
      // on expiry only when the email sign-in route is available.
      const resume = request.method === 'GET' ? downloadReturnTarget([new URL(request.url).pathname + new URL(request.url).search]) : null;
      if (response.status === 401 && resume && consoleAuth(env)) {
        return withConsoleTrace(new Response(null, { status: 303, headers: { location: `${CONSOLE_SIGNIN_PATH}?return_to=${encodeURIComponent(resume)}` } }), consoleRequestTrace ?? consoleTrace());
      }
      if (consoleRequestTrace) {
        const routed = response.ok || (response.status >= 300 && response.status < 400);
        consoleLog(consoleRequestTrace, 'console_route', routed, routed ? 'forwarded' : 'forward_failed');
        return withConsoleTrace(response, consoleRequestTrace);
      }
      return response;
    }
    if (new URL(request.url).pathname.startsWith(CONNECT_LINK_PREFIX)) {
      return handleConnectTicket(request, env);
    }
    if (new URL(request.url).pathname === GOOGLE_CALLBACK_PATH) {
      return handleGoogleCallback(request, env);
    }
    return new Response('not found', {
      status: 404,
      headers: {
        'cache-control': 'no-store',
        'content-type': 'text/plain; charset=utf-8',
        'vary': 'Authorization, Accept',
      },
    });
  },
  // Declared only under env.staging in wrangler.jsonc; the production Worker has no cron trigger.
  async scheduled(_controller: ScheduledController, env: Env, ctx: ExecutionContext): Promise<void> {
    ctx.waitUntil(sweepHealthRetention(signedRpc(env)).then((outcome) => console.log(`health retention sweep ${outcome.state} owners=${outcome.owners} rounds=${outcome.rounds}`)));
  },
} satisfies ExportedHandler<Env>;
