import { md5Hex } from '../channels/md5';
import { langfuseOtlpConfig } from './otlp-turns';

type Kv = Pick<DurableObjectStorage['kv'], 'get' | 'put'>;
type Env = Readonly<{ LANGFUSE_PUBLIC_KEY?: string; LANGFUSE_SECRET_KEY?: string; LANGFUSE_BASE_URL?: string; WALDO_ENVIRONMENT?: string }>;
type Send = (input: string, init: RequestInit) => Promise<Response>;

// A trace key that names one owner turn (`app-12`, `tg-12`, an iMessage event key) or one scheduled occurrence
// (`card:brief:<ms>`) names its Langfuse trace through the owner's own random salt, so a rating made later finds the trace
// the row came from. Keys repeat across owners and after an erase, which also wipes the salt, so the salt keeps one owner's
// traces apart from every other's. A key shared by unrelated work (`telegram-unlinked`) keeps a random trace id, or every
// such trace would become one.
const ONE_TURN_OR_OCCURRENCE = /^[a-z]+-\d+$|^\["imessage",|:\d+$/;
const SALT_KEY = 'langfuse_trace_salt_v1';
export const ownerTraceSalt = (kv: Kv): string => {
  const known = kv.get<string>(SALT_KEY);
  if (known) return known;
  const salt = crypto.randomUUID();
  kv.put(SALT_KEY, salt);
  return salt;
};
export const ownerTraceId = (salt: string, traceKey: string): string | undefined => (ONE_TURN_OR_OCCURRENCE.test(traceKey) ? md5Hex(`${salt}:${traceKey}`) : undefined);

// Langfuse keeps a trace thirty days, so a row's link to its job's trace is kept as long.
const ROW_TRACE_KEPT_MS = 30 * 24 * 60 * 60 * 1000;
// The trace a rated row came from. An owner turn's reply is saved as `<trace key>-reply`; a row a scheduled job wrote into
// the app chat (`scheduled-<uuid>`) is linked to that job's trace key when it is delivered.
export const rowTraces = (sql: SqlStorage) => {
  sql.exec('CREATE TABLE IF NOT EXISTS app_row_traces (row_id TEXT PRIMARY KEY, trace_key TEXT NOT NULL, at INTEGER NOT NULL)');
  return {
    link(rowId: string, traceKey: string, at: number): void {
      sql.exec('DELETE FROM app_row_traces WHERE at < ?', at - ROW_TRACE_KEPT_MS);
      sql.exec('INSERT INTO app_row_traces (row_id, trace_key, at) VALUES (?, ?, ?) ON CONFLICT (row_id) DO NOTHING', rowId, traceKey, at);
    },
    traceKey(rowId: string): string | null {
      const reply = rowId.endsWith('-reply') ? rowId.slice(0, -'-reply'.length) : '';
      if (ONE_TURN_OR_OCCURRENCE.test(reply)) return reply;
      return sql.exec<{ trace_key: string }>('SELECT trace_key FROM app_row_traces WHERE row_id = ?', rowId).toArray()[0]?.trace_key ?? null;
    },
  };
};

export type RatingScoreChange = Readonly<{ messageId: string; removed: string | null; added: Readonly<{ id: string; value: 0 | 1 }> | null }>;
const TIMEOUT_MS = 10_000;

// One change to a row's Like or Dislike, as Langfuse scores on the trace the row came from (none when it has no trace): the
// score it replaces is deleted and a new one is created under its own id, since Langfuse overwrites a score only within the
// day it was made. Each call is tried once and never retried
// (the API asks callers not to retry a 207). The score carries the value and its source only. Null when Langfuse is off.
export const syncRatingScore = async (env: Env, traceId: string | null, change: RatingScoreChange, send: Send = fetch): Promise<Readonly<{ ok: boolean; code: string }> | null> => {
  const config = langfuseOtlpConfig(env);
  if (!config) return null;
  const base = env.LANGFUSE_BASE_URL!.replace(/\/+$/, '');
  const authorization = config.headers.authorization!;
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
    if (!traceId) return { ok: failure === null, code: failure ?? 'unlinked' };
    const score = { id: change.added.id, traceId, name: 'reply_rating', value: change.added.value, dataType: 'BOOLEAN', environment: env.WALDO_ENVIRONMENT ?? 'development', metadata: { source: 'app' } };
    // 207 means some score in the batch was rejected; with one score, that is this one.
    await attempt('/api/public/scores', { method: 'POST', body: JSON.stringify([score]) }, status => status >= 200 && status < 300 && status !== 207);
  }
  return { ok: failure === null, code: failure ?? (change.added ? 'scored' : 'cleared') };
};
