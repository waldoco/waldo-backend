import { DurableObject } from 'cloudflare:workers';
import {
  canonicalizeResponsibilityCaptureTrustedEnvelopeForDigest,
  canonicalizeResponsibilityCaptureTrustedEnvelopeV02ForDigest,
  canonicalizeWorkUnitPlanningTurnTrustedEnvelopeV03ForDigest,
  canonicalizeWorkUnitPlanningCancelRequestV03ForDigest,
  canonicalizeWorkUnitExecutionStartRequestV04ForDigest,
  canonicalizeJudgmentAnswerRequestV05ForDigest,
  responsibilityHttpProblemV01,
} from '@waldo/contracts';
import { armAlarm } from './scheduler/alarm-slot';
import { handleTelegramWebhook, TELEGRAM_WEBHOOK_PATH } from './channels/telegram-webhook';
import { handleProbeTurn, PROBE_TURN_PATH } from './channels/probe-turn';
import { handleWhatsAppWebhook, WHATSAPP_WEBHOOK_PATH } from './channels/whatsapp-webhook';
import { EVENT_INGRESS_PREFIX, handleEventIngress } from './channels/event-ingress';
import { handleGoogleCallback } from './channels/google-oauth';
import { CONNECT_LINK_PREFIX, handleConnectTicket } from './channels/connect-link';
import { GOOGLE_CALLBACK_PATH } from './connectors/google';
import { CONSOLE_PATH } from './channels/console';
import { ownerDirectory } from './identity/owner-directory';
import { downloadReturnTarget, handleConsole, CONSOLE_SIGNIN_PATH } from './channels/console-signin';
import { consoleAuth, OWNER_COOKIE } from './identity/console-auth';
import { readConsoleTicket } from './identity/console-ticket';
import { serveDashboard } from './channels/dashboard-static';
import { consoleLog, consoleTrace, withConsoleTrace } from './observability/console-correlation';
import type { GatewaySecretBinding } from './llm/gateway';
import { createSupabaseResponsibilityAuthority } from './responsibility/supabase-authority';
import {
  canonicalizeResponsibilityProjectionIngressForDigest,
  canonicalizePlanningProjectionIngressForDigest,
  canonicalizeJudgmentProjectionIngressForDigest,
  signResponsibilityIngress,
} from './responsibility/ingress-signature';
import {
  createResponsibilityWorkerAdapter,
  type ResponsibilityOwnerRoot,
  type TrustedResponsibilityContext,
} from './responsibility/worker-adapter';

// The entry exports only Durable Object classes and the default handler. `wrangler dev --local`
// rejects constants or arrays exported from the Worker entry, so helpers are imported from their
// own modules, never re-exported here (pinned by test/worker-entry-exports.test.ts).
export { RunLoopDO } from './run-loop/do';
export { TelegramOwnerDO } from './channels/telegram-owner-do';
export { TracerDO } from './tracer/tracer-do';
import type { RunLoopDO } from './run-loop/do';
import type { TracerDO } from './tracer/tracer-do';

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
      RESPONSIBILITY_PUBLIC_API_ENABLED?: string;
      RESPONSIBILITY_RATE_LIMITER?: RateLimit;
      RESPONSIBILITY_INGRESS_HMAC_SECRET?: string;
      SUPABASE_PROJECT_URL?: string;
      SUPABASE_PUBLISHABLE_KEY?: string;
      WALDO_ROUTER_HMAC_SECRET?: string;
      RUN_LOOP_LOCAL_INGRESS_TOKEN?: string;
      TRACER_DO: DurableObjectNamespace<TracerDO>;
      TELEGRAM_OWNER_DO?: DurableObjectNamespace;
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

// Test-only probe DO for the hermetic Gate-5 runtime substrate. No product logic:
// it exercises DO SQLite durability, the alarm slot via the alarm-slot seam, and
// eviction survival. `tick` is synthetic neutral state, not a physiological value.
export class RuntimeProbeDO extends DurableObject<Env> {
  // In-memory flag (not persisted). Reset to false when the instance is reconstructed
  // after eviction — the test reads this to prove eviction actually tore down the
  // instance rather than returning a still-live one.
  inMemoryTouched = false;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.storage.sql.exec('CREATE TABLE IF NOT EXISTS probe_state(id TEXT PRIMARY KEY, tick INTEGER)');
  }

  async seed(): Promise<void> {
    this.ctx.storage.sql.exec(
      "INSERT INTO probe_state (id, tick) VALUES ('probe', 1) ON CONFLICT(id) DO UPDATE SET tick = 1",
    );
    this.inMemoryTouched = true;
    await armAlarm(this.ctx.storage, Date.now() + 1000);
  }

  async readTick(): Promise<number> {
    return this.ctx.storage.sql
      .exec<{ tick: number }>("SELECT tick FROM probe_state WHERE id = 'probe'")
      .one().tick;
  }

  override async alarm(): Promise<void> {
    this.ctx.storage.sql.exec("UPDATE probe_state SET tick = 2 WHERE id = 'probe'");
    this.inMemoryTouched = true;
  }
}

const forwardTicketConsole = async (request: Request, env: Env, issuer?: string): Promise<Response> => {
  if (!env.TELEGRAM_OWNER_DO || (!issuer && !env.WALDO_OWNER_TELEGRAM_ID)) return new Response('unauthorized', { status: 401 });
  const ownerRoute = issuer ? { doName: issuer } : await ownerDirectory(env).byPresence('telegram', env.WALDO_OWNER_TELEGRAM_ID!);
  if (!ownerRoute) return new Response('owner unavailable', { status: 503 });
  const doName = ownerRoute.doName;
  const forwarded = new Request(request);
  forwarded.headers.set('x-waldo-do-name', doName);
  return env.TELEGRAM_OWNER_DO.get(env.TELEGRAM_OWNER_DO.idFromName(doName)).fetch(forwarded);
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
    if (new URL(request.url).pathname.startsWith(CONSOLE_PATH) && env.TELEGRAM_OWNER_DO && env.WALDO_OWNER_TELEGRAM_ID) {
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
        consoleLog(consoleRequestTrace, 'console_route', response.ok, response.ok ? 'forwarded' : 'forward_failed');
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
    if (env.RESPONSIBILITY_PUBLIC_API_ENABLED !== 'true') {
      return new Response('not found', {
        status: 404,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'text/plain; charset=utf-8',
          'vary': 'Authorization, Accept',
        },
      });
    }
    try {
      return await createResponsibilityPublicHandler(env).fetch(request);
    } catch (error) {
      reportResponsibilityFailure('handler_unavailable', error);
      return new Response(JSON.stringify(responsibilityHttpProblemV01(503)), {
        status: 503,
        headers: {
          'cache-control': 'no-store',
          'content-type': 'application/problem+json; charset=utf-8',
          'vary': 'Authorization, Accept',
        },
      });
    }
  },
} satisfies ExportedHandler<Env>;

export function createResponsibilityPublicHandler(env: Env) {
  const projectUrl = env.SUPABASE_PROJECT_URL;
  const publishableKey = env.SUPABASE_PUBLISHABLE_KEY;
  if (typeof projectUrl !== 'string' || typeof publishableKey !== 'string') {
    throw new Error('responsibility public authority is unconfigured');
  }
  if (env.RESPONSIBILITY_RATE_LIMITER === undefined) {
    throw new Error('responsibility public rate limiter is unconfigured');
  }
  const ingressSecret = responsibilityIngressSecret(env);
  return createResponsibilityWorkerAdapter({
    authority: createSupabaseResponsibilityAuthority({ projectUrl, publishableKey }),
    edgeRateLimit: {
      async admit(request) {
        const key = await responsibilityEdgeRateKey(request);
        return (await env.RESPONSIBILITY_RATE_LIMITER!.limit({ key })).success;
      },
    },
    failureReporter: { report: reportResponsibilityFailure },
    async ownerRootFor(context) {
      return ownerRootFor(env.RUN_LOOP_DO, context, ingressSecret);
    },
    now: () => new Date().toISOString(),
    newId: (kind) => `${kind}_${crypto.randomUUID()}`,
  });
}

function reportResponsibilityFailure(code: string, error: unknown): void {
  const cause = error instanceof Error ? error.cause : undefined;
  console.error(JSON.stringify({
    event: 'responsibility_public_failure',
    code,
    error_name: error instanceof Error ? error.name : 'UnknownError',
    cause_name: cause instanceof Error ? cause.name : null,
  }));
}

export async function responsibilityEdgeRateKey(request: Request): Promise<string> {
  const source = request.headers.get('cf-connecting-ip');
  if (source === null || source.length < 3 || source.length > 64 || /[\s\0]/.test(source)) {
    throw new Error('responsibility edge source unavailable');
  }
  return sha256Hex(`edge-source\0${source}`);
}

async function ownerRootFor(
  namespace: DurableObjectNamespace<RunLoopDO>,
  context: TrustedResponsibilityContext,
  ingressSecret: string,
): Promise<ResponsibilityOwnerRoot> {
  const stub = namespace.get(namespace.idFromName(await responsibilityOwnerRootName(
    context.ownerId,
  )));
  return {
    async capture(input, ingress) {
      const requestDigest = (input.trustedEnvelope as { requestDigest?: unknown }).requestDigest;
      if (typeof requestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(requestDigest)) {
        throw new Error('responsibility ingress digest unavailable');
      }
      return stub.captureResponsibilityFromWorker(input, await signResponsibilityIngress({
        context: { ...ingress, ...authorityForIngress(context) },
        operation: 'capture',
        requestDigest: requestDigest as `sha256:${string}`,
        operationDigest: `sha256:${await sha256Hex(
          (input.trustedEnvelope as { protocolVersion?: unknown }).protocolVersion === '0.1'
            ? canonicalizeResponsibilityCaptureTrustedEnvelopeForDigest(input.trustedEnvelope)
            : canonicalizeResponsibilityCaptureTrustedEnvelopeV02ForDigest(input.trustedEnvelope),
        )}`,
        issuedAt: Date.now(),
        secret: ingressSecret,
      }));
    },
    async readProjection(input, ingress) {
      const projectionDigest = `sha256:${await sha256Hex(
        canonicalizeResponsibilityProjectionIngressForDigest(input),
      )}` as const;
      return stub.readResponsibilityProjectionFromWorker(input, await signResponsibilityIngress({
        context: { ...ingress, ...authorityForIngress(context) },
        operation: 'projection',
        requestDigest: projectionDigest,
        operationDigest: projectionDigest,
        issuedAt: Date.now(),
        secret: ingressSecret,
      }));
    },
    async plan(input, ingress) {
      const requestDigest = (input.trustedEnvelope as { requestDigest?: unknown }).requestDigest;
      if (typeof requestDigest !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(requestDigest)) {
        throw new Error('planning ingress digest unavailable');
      }
      return stub.executePlanningTurnFromWorker(input, await signResponsibilityIngress({
        context: { ...ingress, ...authorityForIngress(context) },
        operation: 'planning_turn',
        requestDigest: requestDigest as `sha256:${string}`,
        operationDigest: `sha256:${await sha256Hex(
          canonicalizeWorkUnitPlanningTurnTrustedEnvelopeV03ForDigest(input.trustedEnvelope),
        )}`,
        issuedAt: Date.now(),
        secret: ingressSecret,
      }));
    },
    async cancelPlanning(input, ingress) {
      const digest = `sha256:${await sha256Hex(
        canonicalizeWorkUnitPlanningCancelRequestV03ForDigest(input.request),
      )}` as const;
      return stub.cancelPlanningTurnFromWorker(input, await signResponsibilityIngress({
        context: { ...ingress, ...authorityForIngress(context) },
        operation: 'planning_cancel', requestDigest: digest, operationDigest: digest,
        issuedAt: Date.now(), secret: ingressSecret,
      }));
    },
    async readPlanningProjection(input, ingress) {
      const digest = `sha256:${await sha256Hex(
        canonicalizePlanningProjectionIngressForDigest(input),
      )}` as const;
      return stub.readPlanningProjectionFromWorker(input, await signResponsibilityIngress({
        context: { ...ingress, ...authorityForIngress(context) },
        operation: 'planning_projection', requestDigest: digest, operationDigest: digest,
        issuedAt: Date.now(), secret: ingressSecret,
      }));
    },
    async startExecution(input, ingress) {
      const digest = `sha256:${await sha256Hex(
        canonicalizeWorkUnitExecutionStartRequestV04ForDigest(input.request),
      )}` as const;
      return stub.startExecutionFromWorker(input, await signResponsibilityIngress({
        context: { ...ingress, ...authorityForIngress(context) },
        operation: 'execution_start',
        requestDigest: digest,
        operationDigest: digest,
        issuedAt: Date.now(),
        secret: ingressSecret,
      }));
    },
    async answerJudgment(input, ingress) {
      const digest = `sha256:${await sha256Hex(
        canonicalizeJudgmentAnswerRequestV05ForDigest(input.request),
      )}` as const;
      return stub.answerJudgmentFromWorker(input, await signResponsibilityIngress({
        context: { ...ingress, ...authorityForIngress(context) },
        operation: 'judgment_answer',
        requestDigest: digest,
        operationDigest: digest,
        issuedAt: Date.now(),
        secret: ingressSecret,
      }));
    },
    async readJudgmentProjection(input, ingress) {
      const digest = `sha256:${await sha256Hex(
        canonicalizeJudgmentProjectionIngressForDigest(input),
      )}` as const;
      return stub.readJudgmentProjectionFromWorker(input, await signResponsibilityIngress({
        context: { ...ingress, ...authorityForIngress(context) },
        operation: 'judgment_projection',
        requestDigest: digest,
        operationDigest: digest,
        issuedAt: Date.now(),
        secret: ingressSecret,
      }));
    },
  };
}

function authorityForIngress(context: TrustedResponsibilityContext) {
  return {
    ownerId: context.ownerId,
    authenticatedSubjectRef: context.authenticatedSubjectRef,
    presenceId: context.presenceId,
    presenceRegistrationId: context.presenceRegistrationId,
    ownerRootRoutingVersion: context.ownerRootRoutingVersion,
  };
}

function responsibilityIngressSecret(env: Env): string {
  const secret = env.RESPONSIBILITY_INGRESS_HMAC_SECRET;
  if (typeof secret !== 'string' || secret.length < 32) {
    throw new Error('responsibility ingress signing is unconfigured');
  }
  return secret;
}

export async function responsibilityOwnerRootName(
  ownerId: string,
): Promise<string> {
  const digest = await sha256Hex(`waldo-owner-root\0${ownerId}`);
  return `owner-root:sha256:${digest}`;
}

async function sha256Hex(value: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, '0'),
  ).join('');
}
