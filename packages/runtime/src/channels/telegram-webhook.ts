import { ownerDirectory, type OwnerDirectory, type OwnerDirectoryEnv } from '../identity/owner-directory';
import {parseCodedSetup} from './telegram-link-command';
import { OWNER_TRACE_HEADER } from '../observability/owner-trace-identity';
import {linkCodeHash} from '../identity/owner-directory';

export type TelegramWebhookEnv = Readonly<{
  TELEGRAM_OWNER_DO?: DurableObjectNamespace;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  WALDO_OWNER_TELEGRAM_ID?: string;
  WALDO_OWNER_TIMEZONE?: string;
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL?: string;
  LANGFUSE_CAPTURE_TEXT?: string;
  WALDO_ENVIRONMENT?: string;
  WALDO_OWNER_DO_NAMESPACE?: string;
  WALDO_RELEASE?: string;
  OPENAI_API_KEY?: string;
  SMALLEST_AI_API_KEY?: string;
  BRAVE_SEARCH_API_KEY?: string;
  // A5 artifact bodies; absent in tests/local, bound in wrangler (r2_buckets).
  ARTIFACTS?: R2Bucket;
  RESPONSIBILITY_RATE_LIMITER?: RateLimit;
  BROWSERBASE_API_KEY?: string;
  // Type-only optional capability. No deployment binding is added here.
  BROWSER?: import('@cloudflare/playwright').BrowserWorker;
  BROWSERBASE_PROJECT_ID?: string;
  ELEVENLABS_API_KEY?: string;
  WALDO_STT_PROVIDER?: string;
  WALDO_TOOL_OFFLOAD?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  WALDO_MCP_SERVERS?: string;
  MCP_READ_INTENTS?: string;
  DRIVE_READS?: string;
  // Opt-in only after mixed-inbox privacy and live usefulness acceptance.
  MAIL_SOURCE_FOLLOWUPS?: string;
  // Calendar-only prep remains off until controlled owner-path acceptance.
  CALENDAR_GROUNDED_PREP?: string;
  WALDO_EGRESS_ALLOWLIST?: string;
}> & OwnerDirectoryEnv;

export const TELEGRAM_WEBHOOK_PATH = '/telegram/webhook';

export const sameSecret = (given: string, expected: string): boolean => {
  const a = new TextEncoder().encode(given);
  const b = new TextEncoder().encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < Math.max(a.length, b.length); i += 1) diff |= (a[i] ?? 0) ^ (b[i] ?? 0);
  return diff === 0;
};

type SenderUpdate = {
  message?: { from?: { id?: number }; chat?: { id?: number; type?: string }; text?: string };
  callback_query?: { from?: { id?: number } };
};

const sender = (update: SenderUpdate): string | null => {
  const id = update.message?.from?.id ?? update.callback_query?.from?.id;
  return id === undefined ? null : String(id);
};

// The webhook resolves which owner a Telegram sender belongs to and wakes only that owner's Durable Object.
// A sender with no owner can only redeem a one-time link code issued from the console.
// One status word per inbound update, no ids or text: lets an operator tell routed from dropped without reading a tenant's DO.
// "routed" means the owner DO accepted the HTTP request, not that a turn was admitted (the DO also answers 200 for ignored updates).
// The inner handler names its outcome; the wrapper below logs exactly one line, including when the handler throws.
const outcomes = new WeakMap<Response, string>();
const outcome = (status: string, response: Response): Response => { outcomes.set(response, status); return response; };
const log = (status: string, http: number) => console.log(JSON.stringify({ hop: 'telegram_webhook', ok: http > 0 && http < 400, status, http }));

const handle = async (
  request: Request,
  env: TelegramWebhookEnv,
  waitUntil: (work: Promise<unknown>) => void,
  directory: OwnerDirectory = ownerDirectory(env),
): Promise<Response> => {
  const secret = env.TELEGRAM_WEBHOOK_SECRET;
  if (request.method !== 'POST' || !secret || !env.TELEGRAM_OWNER_DO) {
    return outcome(request.method !== 'POST' ? 'not_post' : 'not_configured', new Response('not found', { status: 404 }));
  }
  if (!sameSecret(request.headers.get('x-telegram-bot-api-secret-token') ?? '', secret)) {
    return outcome('bad_secret', new Response('forbidden', { status: 403 }));
  }
  const body = await request.text();
  let update: SenderUpdate;
  try { update = JSON.parse(body) as SenderUpdate; } catch { return outcome('bad_json', new Response('bad request', { status: 400 })); }
  if (!update || typeof update !== 'object') return outcome('ignored_shape', new Response('ok'));
  const subject = sender(update);
  if (!subject) return outcome('no_sender', new Response('ok'));
  const owners = env.TELEGRAM_OWNER_DO;
  const origin = new URL(request.url).origin;
  const coded = parseCodedSetup(update);
  if (coded) {
    const bot = env.TELEGRAM_BOT_TOKEN?.split(':')[0];
    if (!bot || !/^\d+$/.test(bot) || !env.RESPONSIBILITY_RATE_LIMITER) return outcome('setup_unavailable', new Response('admission unavailable', { status: 503 }));
    try {
      // Edge guard necessarily precedes durable duplicate lookup/DO allocation.
      const senderOk = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `telegram-link-sender:${bot}:${coded.subject}` })).success;
      const botOk = (await env.RESPONSIBILITY_RATE_LIMITER.limit({ key: `telegram-link-bot:${bot}` })).success;
      if (!senderOk || !botOk) return outcome('setup_rate_limited', new Response('too many requests', { status: 429 }));
      const name = `telegram-link:${bot}:${coded.subject}`;
      const digest = [...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(body)))].map(x=>x.toString(16).padStart(2,'0')).join(''); // exact full-update digest
      const hash = await linkCodeHash(coded.code);
      const admission = await owners.get(owners.idFromName(name)).fetch('https://telegram-link/enqueue-link', {
        method: 'POST', signal: AbortSignal.timeout(10_000),
        headers: { 'x-waldo-inbox-secret': secret },
        body: JSON.stringify({ bot, subject: coded.subject, name, id: coded.updateId, digest, hash }),
      });
      return outcome(admission.ok ? 'setup_admitted' : `setup_refused_${admission.status}`, new Response(admission.ok ? 'ok' : 'admission unavailable', { status: admission.ok ? 200 : admission.status === 409 ? 409 : 503 }));
    } catch { return outcome('setup_unavailable', new Response('admission unavailable', { status: 503 })); }
  }
  let route;
  try { route = await directory.byPresence('telegram', subject); }
  catch { return outcome('route_lookup_failed', new Response('route unavailable', { status: 503 })); }
  if (route) {
    const headers: Record<string, string> = { 'x-waldo-origin': origin, 'x-waldo-telegram-subject': route.subject,
      'x-waldo-do-name': route.doName, 'x-waldo-inbox-secret': secret };
    if (route.timezone) headers['x-waldo-timezone'] = route.timezone;
    if (route.traceIdentity) headers[OWNER_TRACE_HEADER] = encodeURIComponent(JSON.stringify(route.traceIdentity));
    try {
      const admission = await owners.get(owners.idFromName(route.doName)).fetch('https://telegram-owner/enqueue', { method: 'POST', body, headers, signal: AbortSignal.timeout(10_000) });
      return outcome(admission.ok ? 'routed' : `owner_refused_${admission.status}`, new Response(admission.ok ? 'ok' : 'admission unavailable', { status: admission.ok ? 200 : admission.status === 409 ? 409 : 503 }));
    } catch { return outcome('owner_unreachable', new Response('admission unavailable', { status: 503 })); }
  }
  // Unknown non-coded/unsupported setup is ignored, never model input.
  return outcome('no_route', new Response('ok'));
};

export const handleTelegramWebhook = async (
  request: Request,
  env: TelegramWebhookEnv,
  waitUntil: (work: Promise<unknown>) => void,
  directory: OwnerDirectory = ownerDirectory(env),
): Promise<Response> => {
  let response: Response;
  try { response = await handle(request, env, waitUntil, directory); }
  catch (error) { log('handler_threw', 0); throw error; }
  log(outcomes.get(response) ?? 'unnamed', response.status);
  return response;
};
