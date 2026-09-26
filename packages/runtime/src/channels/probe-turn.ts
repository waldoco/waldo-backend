import { ownerDirectory, type OwnerDirectory, type OwnerDirectoryEnv } from '../identity/owner-directory';
import { sameSecret } from './telegram-webhook';

// Staging-only synthetic turn trigger: lets the probe harness run one real owner turn on
// waldo-runtime-staging without the Telegram webhook secret and without touching the update-id
// dedupe offset. The DO side (telegram-owner-do.ts) builds the synthetic update.
export const PROBE_TURN_PATH = '/probe/turn';
export const PROBE_TURN_DO_URL = 'https://telegram-owner/probe-turn';
const PROBE_TOKEN_HEADER = 'x-waldo-probe-token';

// Capture mode (the default): outbound Telegram calls are collected into the probe response
// instead of hitting the Bot API. A slot lives on the owner runtime; probeTurn fills it for
// the duration of one serialized probe and clears it after, so real turns are never affected.
export type ProbeCapturedCall = Readonly<{ method: string; request: unknown }>;
export type ProbeCapture = Readonly<{ calls: ProbeCapturedCall[]; record(method: string, request: unknown): Promise<unknown> }>;
export type ProbeCaptureSlot = { current: ProbeCapture | null };
export const newProbeCapture = (): ProbeCapture => {
  const calls: ProbeCapturedCall[] = [];
  return {
    calls,
    record: (method, request) => {
      calls.push({ method, request });
      // Shape mirrors a Bot API success so callers reading result.message_id keep working.
      return Promise.resolve({ ok: true, result: { message_id: 0 } });
    },
  };
};
const MAX_PROBE_TEXT = 4_000;

export type ProbeTurnEnv = Readonly<{
  WALDO_ENVIRONMENT?: string;
  WALDO_PROBE_TOKEN?: string;
  WALDO_OWNER_TELEGRAM_ID?: string;
  WALDO_OWNER_TIMEZONE?: string;
  TELEGRAM_OWNER_DO?: DurableObjectNamespace;
}> & OwnerDirectoryEnv;

export const handleProbeTurn = async (
  request: Request,
  env: ProbeTurnEnv,
  directory: OwnerDirectory = ownerDirectory(env),
): Promise<Response> => {
  // Hidden outside staging: same 404 shape the worker gives unknown paths.
  if ((env.WALDO_ENVIRONMENT ?? 'development') !== 'staging') return new Response('not found', { status: 404 });
  if (request.method !== 'POST' || !env.WALDO_PROBE_TOKEN || !env.TELEGRAM_OWNER_DO) {
    return new Response('not found', { status: 404 });
  }
  if (!sameSecret(request.headers.get(PROBE_TOKEN_HEADER) ?? '', env.WALDO_PROBE_TOKEN)) {
    return new Response('forbidden', { status: 403 });
  }
  let payload: { text?: unknown; live?: unknown };
  try {
    payload = (await request.json()) as { text?: unknown; live?: unknown };
  } catch {
    return new Response('bad request', { status: 400 });
  }
  const text = payload.text;
  if (typeof text !== 'string' || text.trim().length === 0 || text.length > MAX_PROBE_TEXT) {
    return new Response('bad request', { status: 400 });
  }
  // Capture mode is the default; live:true opts into real Telegram sends for receipt probes.
  const live = payload.live === undefined ? false : payload.live;
  if (typeof live !== 'boolean') return new Response('bad request', { status: 400 });
  const subject = env.WALDO_OWNER_TELEGRAM_ID;
  if (!subject) return new Response('owner unavailable', { status: 503 });
  const route = await directory.byPresence('telegram', subject).catch(() => null);
  const doName = route?.doName ?? subject;
  const headers: Record<string, string> = {
    'content-type': 'application/json',
    'x-waldo-origin': new URL(request.url).origin,
    'x-waldo-telegram-subject': route?.subject ?? subject,
  };
  const timezone = route?.timezone ?? env.WALDO_OWNER_TIMEZONE;
  if (timezone) headers['x-waldo-timezone'] = timezone;
  return env.TELEGRAM_OWNER_DO.get(env.TELEGRAM_OWNER_DO.idFromName(doName))
    .fetch(PROBE_TURN_DO_URL, { method: 'POST', body: JSON.stringify({ text: text.trim(), live }), headers });
};
