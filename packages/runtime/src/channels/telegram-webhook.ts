import type { EmbeddingRunner } from '../memory/semantic-recall';
import { ownerDirectory, type OwnerDirectory } from '../identity/owner-directory';
import type { PhoneSmsEnv } from '../identity/phone-sms';
import {parseCodedSetup} from './telegram-link-command';
import { OWNER_TRACE_HEADER } from '../observability/owner-trace-identity';
import {linkCodeHash} from '../identity/owner-directory';
import { publicOrigin, type PublicOriginEnv } from '../connectors/public-origin';

export type TelegramWebhookEnv = PublicOriginEnv & Readonly<{
  OWNER_DO?: DurableObjectNamespace;
  // Held off until connected common-task execution and recovery acceptance.
  COMMON_BROWSER_REGISTRATION?: string;
  COMMON_OWNER_TASKS?: string;
  DEVICE_BRIDGE_DO?: DurableObjectNamespace<import('../devices/device-bridge-do').DeviceBridgeDO>;
  TASK_WORKER_DO?: DurableObjectNamespace<import('../tasks/worker-do').TaskWorkerDO>;
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  // Signs connector OAuth state (Google, MCP). Without it connector sign-in is off; it never falls back to another secret.
  WALDO_OAUTH_STATE_SECRET?: string;
  WALDO_OWNER_TELEGRAM_ID?: string;
  WALDO_OWNER_TIMEZONE?: string;
  LANGFUSE_PUBLIC_KEY?: string;
  LANGFUSE_SECRET_KEY?: string;
  LANGFUSE_BASE_URL?: string;
  LANGFUSE_CAPTURE_TEXT?: string;
  // 'on' sends per-day spend to waldo.cost_ledger_daily after each turn; anything else keeps it off.
  WALDO_COST_LEDGER_SYNC?: string;
  // 'on' turns conversation compaction on for the app chat; anything else keeps the plain window.
  WALDO_COMPACTION?: string;
  WALDO_ENVIRONMENT?: string;
  WALDO_OWNER_DO_NAMESPACE?: string;
  WALDO_RELEASE?: string;
  OPENAI_API_KEY?: string;
  ANTHROPIC_API_KEY?: string;
  // 'on' loads the brain's core tools up front and the rest through the provider's tool search, with strict OpenAI
  // schemas; anything else (the default, and every environment until a staging smoke passes) sends every tool up front.
  WALDO_TOOL_SEARCH?: string;
  WALDO_TOOL_LOADER?: string;
  // 'on' shows owner replies while they are written (Telegram drafts, the app's receipt draft). Off when unset.
  WALDO_STREAM_REPLIES?: string;
  // "1" scores from the owner's first day against the shared baseline and writes the provisional versions; anything else keeps
  // the earlier engine. Apply the derived-row migration that admits the new keys before turning it on.
  HEALTH_PROVISIONAL_SCORES?: string;
  // "1" lets the health trigger, on a day with nothing coming, send one short note as an update card when the model judges
  // it worth it; anything else keeps such a day silent.
  HEALTH_SOLO_NOTICE?: string;
  HEALTH_TRAINING_LOAD?: string;
  HEALTH_COACHING?: string;
  // "1" offers track/log/list/stop_medication on owner turns and words medicine reminders in the harness from a health-plane
  // read. Off unless "1".
  MEDICATIONS?: string;
  // 'on' cuts only the forgotten words and items from the model's view while a forget finishes; anything else keeps the
  // earlier rule, which withholds a whole read that mentions the topic.
  WALDO_FORGET_BARRIER?: string;
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
  // Expo's access token for app push. Missing means push is not configured.
  EXPO_ACCESS_TOKEN?: string;
  WALDO_STT_PROVIDER?: string;
  WALDO_TOOL_OFFLOAD?: string;
  // The domain of each owner's Waldo address (<handle>@AGENT_MAIL_DOMAIN); agent mail is off without it.
  AGENT_MAIL_DOMAIN?: string;
  // '0' turns off progress notes on long iMessage turns.
  WALDO_IMESSAGE_PROGRESS?: string;
  GOOGLE_CLIENT_ID?: string;
  GOOGLE_CLIENT_SECRET?: string;
  WHOOP_CLIENT_ID?: string;
  WHOOP_CLIENT_SECRET?: string;
  WHOOP_REDIRECT_URI?: string;
  WHATSAPP_VERIFY_TOKEN?: string;
  WHATSAPP_APP_SECRET?: string;
  WHATSAPP_ACCESS_TOKEN?: string;
  WHATSAPP_PHONE_NUMBER_ID?: string;
  // Waldo's WhatsApp number as E.164 digits without the plus, for the one-tap wa.me link; unset or malformed links by code alone.
  WHATSAPP_WALDO_NUMBER?: string;
  // The approved re-engagement template (WhatsApp Manager) sent when the 24-hour window is closed; unset holds without knocking.
  WHATSAPP_REENGAGE_TEMPLATE?: string;
  WHATSAPP_REENGAGE_TEMPLATE_LANGUAGE?: string;
  WALDO_MCP_SERVERS?: string;
  // The Google Cloud project holding Waldo's Gmail push topic in this environment; unset keeps Gmail push off.
  GMAIL_PUSH_PROJECT?: string;
  MCP_READ_INTENTS?: string;
  DRIVE_READS?: string;
  // "1" with Workers AI bound adds the meaning leg to memory recall; anything else keeps recall to words.
  MEMORY_SEMANTIC_RECALL?: string;
  // "1" shows the model the memory it chose (pins, what is new since the nightly review, recall stubs) instead of the newest facts.
  MEMORY_SELECTION?: string;
  AI?: EmbeddingRunner;
  // "1" offers the in-app terms and privacy notice; anything else holds them back, until the owner approves their copy.
  APP_AGREEMENTS?: string;
  // "1" offers the owner look-up; anything else keeps it off, until the privacy notice that discloses it is published.
  OWNER_LOOKUP?: string;
  // "1" gives every owner turn the owner profile view (memory/owner-profile.ts) in place of the pinned blocks; anything else keeps them.
  OWNER_PROFILE?: string;
  MEMORY_NIGHTLY_SOURCE_UPDATES?: string;
  // "1" with MEMORY_NIGHTLY_SOURCE_UPDATES also "1": mail and calendar changes reach memory the same day (memory/consolidator.ts).
  MEMORY_DAYTIME_CONSOLIDATOR?: string;
  // Opt-in only after mixed-inbox privacy and live usefulness acceptance.
  MAIL_SOURCE_FOLLOWUPS?: string;
  // Calendar-only prep remains off until controlled owner-path acceptance.
  CALENDAR_GROUNDED_PREP?: string;
  // '1' lets a prep note's app push name the meeting and its start; anything else sends the fixed line.
  PREP_PUSH_NAMES?: string;
  // '1' turns on the day state: the update sweep keeps what each event was, reads two weeks ahead, and its apply turn may
  // revise a delivered day card or push. Anything else keeps the update card as it was.
  WALDO_DAY_STATE?: string;
  // '1' lets an update push say what changed (titles, times, names), checked at the send; anything else sends the fixed line.
  UPDATE_PUSH_NAMES?: string;
  WALDO_EGRESS_ALLOWLIST?: string;
}> & PhoneSmsEnv;

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
  if (request.method !== 'POST' || !secret || !env.OWNER_DO) {
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
  const owners = env.OWNER_DO;
  const origin = publicOrigin(env, request.url);
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
