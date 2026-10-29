import { md5Hex } from '../channels/md5';
import { langfuseOtlpConfig } from './otlp-turns';

type Kv = Pick<DurableObjectStorage['kv'], 'get' | 'put'>;
type Env = Readonly<{ LANGFUSE_PUBLIC_KEY?: string; LANGFUSE_SECRET_KEY?: string; LANGFUSE_BASE_URL?: string; WALDO_ENVIRONMENT?: string }>;
type Send = (input: string, init: RequestInit) => Promise<Response>;

// An app owner turn's trace key (`app-<n>`) names its Langfuse trace through the owner's own random salt, so a rating made
// later finds the trace its reply was exported in. Keys repeat across owners and after an erase, which also wipes the salt,
// so the salt keeps one owner's traces apart from every other's. Other keys keep a random trace id.
const APP_TURN = /^app-\d+$/;
const SALT_KEY = 'langfuse_trace_salt_v1';
export const ownerTraceSalt = (kv: Kv): string => {
  const known = kv.get<string>(SALT_KEY);
  if (known) return known;
  const salt = crypto.randomUUID();
  kv.put(SALT_KEY, salt);
  return salt;
};
export const appTurnTraceId = (salt: string, traceKey: string): string | undefined => (APP_TURN.test(traceKey) ? md5Hex(`${salt}:${traceKey}`) : undefined);
// An owner turn's reply is saved as `<trace key>-reply`.
const replyTraceKey = (messageId: string): string | null => {
  const key = messageId.endsWith('-reply') ? messageId.slice(0, -'-reply'.length) : '';
  return APP_TURN.test(key) ? key : null;
};

export type RatingScoreChange = Readonly<{ messageId: string; removed: string | null; added: Readonly<{ id: string; value: 0 | 1 }> | null }>;
const TIMEOUT_MS = 10_000;

// One change to a reply's Like or Dislike, as Langfuse scores: the score it replaces is deleted and a new one is created under
// its own id, since Langfuse overwrites a score only within the day it was made. Each call is tried once and never retried
// (the API asks callers not to retry a 207). The score carries the value and its source only. Null when Langfuse is off.
export const syncRatingScore = async (env: Env, salt: string, change: RatingScoreChange, send: Send = fetch): Promise<Readonly<{ ok: boolean; code: string }> | null> => {
  const config = langfuseOtlpConfig(env);
  if (!config) return null;
  const base = env.LANGFUSE_BASE_URL!.replace(/\/+$/, '');
  const authorization = config.headers.authorization!;
  const traceKey = replyTraceKey(change.messageId);
  let failure: string | null = null;
  const attempt = async (path: string, init: RequestInit, accepted: (status: number) => boolean) => {
    try {
      const response = await send(`${base}${path}`, { ...init, headers: { authorization, ...(init.body ? { 'content-type': 'application/json' } : {}) }, signal: AbortSignal.timeout(TIMEOUT_MS) });
      void response.body?.cancel().catch(() => undefined);
      if (!accepted(response.status)) failure ??= `http_${response.status}`;
    } catch { failure ??= 'transport'; }
  };
  if (change.removed) await attempt(`/api/public/scores/${encodeURIComponent(change.removed)}`, { method: 'DELETE' }, status => status >= 200 && status < 300);
  if (change.added) {
    if (!traceKey) return { ok: failure === null, code: failure ?? 'unlinked' };
    const score = { id: change.added.id, traceId: appTurnTraceId(salt, traceKey)!, name: 'reply_rating', value: change.added.value, dataType: 'BOOLEAN', environment: env.WALDO_ENVIRONMENT ?? 'development', metadata: { source: 'app' } };
    // 207 means some score in the batch was rejected; with one score, that is this one.
    await attempt('/api/public/scores', { method: 'POST', body: JSON.stringify([score]) }, status => status >= 200 && status < 300 && status !== 207);
  }
  return { ok: failure === null, code: failure ?? (change.added ? 'scored' : 'cleared') };
};
