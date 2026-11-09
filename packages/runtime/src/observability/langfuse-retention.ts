import { langfuseOtlpConfig } from './otlp-turns';

// The privacy notice promises that traces are deleted after thirty days, and the Langfuse Hobby plan has no retention
// setting. This sweep ages a trace by its root observation's start (Langfuse retired the trace list for the observation
// list, GET /api/public/traces is served only until 16 Nov 2026) and deletes it only when nothing in it started after the
// cutoff. Langfuse deletes a trace's observations and scores with it, asynchronously, usually within fifteen minutes. It
// runs once a day, so the cutoff sits a day inside the promise. "dry" makes every read and deletes nothing, so the owner
// sees the count before saying yes to "1". It logs counts and status codes, never a trace id.
type Env = Readonly<{ LANGFUSE_PUBLIC_KEY?: string; LANGFUSE_SECRET_KEY?: string; LANGFUSE_BASE_URL?: string; LANGFUSE_RETENTION_SWEEP?: string }>;
type Send = (input: string | URL, init?: RequestInit) => Promise<Response>;
export type LangfuseSweepOutcome = Readonly<{
  mode: 'off' | 'dry' | 'live';
  // incomplete: a budget or a held rate limit stopped the run, and the next one continues. partial: a failure after deletes.
  state: 'off' | 'unconfigured' | 'complete' | 'incomplete' | 'partial' | 'failed';
  // What the run found before it deleted anything, counted by Langfuse: root traces older than the cutoff, those already
  // past the thirty days promised, those that arrived in the last day, and how many daily runs would clear the backlog at
  // that inflow ('never' when the inflow alone fills a run). Null when Langfuse would not count.
  backlog: number | null; overdue: number | null; daily_new: number | null; days_to_clear: number | 'never' | null;
  candidates: number; deleted: number; would_delete: number; skipped_recent: number; skipped_project: number;
  // Like and Dislike scores older than the cutoff, deleted on their own: a score outlives a trace that never reached Langfuse.
  scores_deleted: number; would_delete_scores: number;
  requests: number; last_status: number | null;
}>;

const DAY_MS = 86_400_000;
export const LANGFUSE_RETENTION_CUTOFF_MS = 29 * DAY_MS;
const PROMISE_MS = 30 * DAY_MS;
// Before any trace Waldo could have exported; the count needs a lower bound.
const COUNT_FROM = '2020-01-01T00:00:00.000Z';
// Langfuse Cloud Hobby limits (faq/all/api-limits, read 28 Oct 2026): 30 requests a minute on the general bucket, which the
// observation list is in; 50 trace-data deletion requests a day for the organization, a bucket that covers traces and scores
// alike, with 30 to 50 trace ids advised per delete; and 100 Metrics API v2 requests a day. A run's trace and score deletes
// share one budget of 40, which keeps ten a day for rating changes and people, and every request is paced under the minute
// rate.
export const LANGFUSE_RETENTION_LIMITS = {
  pageSize: 1000, deleteBatch: 40, deletesPerRun: 40, spacingMs: 2_100, maxPages: 20, retries: 3, maxRetryWaitMs: 60_000, scoresPerRun: 5,
} as const;

class RateLimited extends Error {}
class Refused extends Error { constructor(readonly status: number) { super('refused'); } }

const rowsOf = (answer: unknown): { rows: { traceId: string; projectId: unknown }[]; cursor: string | null } | null => {
  if (!answer || typeof answer !== 'object') return null;
  const { data, meta } = answer as { data?: unknown; meta?: unknown };
  if (!Array.isArray(data) || !meta || typeof meta !== 'object') return null;
  const cursor = (meta as { cursor?: unknown }).cursor;
  if (cursor !== undefined && cursor !== null && typeof cursor !== 'string') return null;
  const rows = data.flatMap(item => (item && typeof item === 'object' && typeof (item as { traceId?: unknown }).traceId === 'string' && (item as { traceId: string }).traceId
    ? [{ traceId: (item as { traceId: string }).traceId, projectId: (item as { projectId?: unknown }).projectId }] : []));
  return { rows, cursor: cursor || null };
};

const modeOf = (flag: string | undefined): LangfuseSweepOutcome['mode'] => (flag === '1' ? 'live' : flag === 'dry' ? 'dry' : 'off');

export const sweepLangfuseRetention = async (env: Env, send: Send = fetch, clock: Readonly<{ now(): number; sleep(ms: number): Promise<void> }> = { now: Date.now, sleep: ms => new Promise(resolve => setTimeout(resolve, ms)) }): Promise<LangfuseSweepOutcome> => {
  const mode = modeOf(env.LANGFUSE_RETENTION_SWEEP);
  const tally = { backlog: null as number | null, overdue: null as number | null, daily_new: null as number | null, days_to_clear: null as number | 'never' | null, candidates: 0, deleted: 0, would_delete: 0, skipped_recent: 0, skipped_project: 0, scores_deleted: 0, would_delete_scores: 0, requests: 0, last_status: null as number | null };
  const outcome = (state: LangfuseSweepOutcome['state']): LangfuseSweepOutcome => ({ mode, state, ...tally });
  if (mode === 'off') return outcome('off');
  const config = langfuseOtlpConfig(env);
  if (!config) return outcome('unconfigured');
  const base = env.LANGFUSE_BASE_URL!.replace(/\/+$/, '');
  const authorization = config.headers.authorization!;
  const L = LANGFUSE_RETENTION_LIMITS;
  const cutoff = new Date(clock.now() - LANGFUSE_RETENTION_CUTOFF_MS).toISOString();

  // Every request is paced; a 429 waits for its Retry-After (or backs off) and is retried, and one that holds ends the run
  // for the next day to resume. Answer bodies are read only for their shape and never logged: they name traces.
  const call = async (url: URL | string, init: RequestInit = {}): Promise<unknown> => {
    for (let attempt = 0; ; attempt += 1) {
      if (tally.requests > 0) await clock.sleep(L.spacingMs);
      tally.requests += 1;
      const response = await send(url, { ...init, headers: { authorization, ...(init.body ? { 'content-type': 'application/json' } : {}) } });
      tally.last_status = response.status;
      if (response.status === 429) {
        void response.body?.cancel().catch(() => undefined);
        if (attempt >= L.retries) throw new RateLimited();
        const after = Number(response.headers.get('retry-after'));
        await clock.sleep(Number.isFinite(after) && after > 0 ? Math.min(after * 1000, L.maxRetryWaitMs) : Math.min(L.spacingMs * 2 ** (attempt + 1), L.maxRetryWaitMs));
        continue;
      }
      if (!response.ok) { void response.body?.cancel().catch(() => undefined); throw new Refused(response.status); }
      return response.json();
    }
  };
  const list = async (params: Record<string, string>) => {
    const url = new URL(`${base}/api/public/v2/observations`);
    for (const [key, value] of Object.entries({ fields: 'core', limit: String(L.pageSize), ...params })) url.searchParams.set(key, value);
    const page = rowsOf(await call(url));
    if (!page) throw new Refused(0);
    return page;
  };

  try {
    // Project-scoped keys answer with exactly their own project; a trace from any other is never touched.
    const projects = await call(`${base}/api/public/projects`) as { data?: unknown };
    const own = Array.isArray(projects?.data) && projects.data.length === 1 ? (projects.data[0] as { id?: unknown }).id : undefined;
    if (typeof own !== 'string' || !own) return outcome('failed');
    // The counts are what the owner weighs the daily cap against; a count Langfuse refuses is reported unknown, not fatal.
    const count = async (from: string, to: string): Promise<number | null> => {
      const query = { view: 'observations', metrics: [{ measure: 'count', aggregation: 'count' }], filters: [{ column: 'isRootObservation', operator: '=', value: true, type: 'boolean' }], fromTimestamp: from, toTimestamp: to };
      const url = new URL(`${base}/api/public/v2/metrics`);
      url.searchParams.set('query', JSON.stringify(query));
      let answer: unknown;
      try { answer = await call(url); } catch (error) { if (error instanceof RateLimited) throw error; return null; }
      const row = (answer as { data?: unknown })?.data;
      const value = Array.isArray(row) && row[0] && typeof row[0] === 'object' ? (row[0] as Record<string, unknown>).count_count : undefined;
      const n = typeof value === 'number' ? value : typeof value === 'string' && /^\d+$/.test(value) ? Number(value) : NaN;
      return Number.isSafeInteger(n) && n >= 0 ? n : null;
    };
    const now = clock.now();
    tally.backlog = await count(COUNT_FROM, cutoff);
    tally.overdue = await count(COUNT_FROM, new Date(now - PROMISE_MS).toISOString());
    tally.daily_new = await count(new Date(now - DAY_MS).toISOString(), new Date(now).toISOString());
    if (tally.backlog !== null && tally.daily_new !== null) {
      const net = L.deletesPerRun * L.deleteBatch - tally.daily_new;
      tally.days_to_clear = tally.backlog === 0 ? 0 : net <= 0 ? 'never' : Math.ceil(tally.backlog / net);
    }
    // Every candidate is read before anything is deleted, so a delete can never shift a page the run has yet to read. A run,
    // dry or live, takes no more than one day's delete budget (about three minutes of paced requests, inside a cron's
    // fifteen); what it leaves, the next day's run reads again, and "incomplete" says more remain.
    const capacity = L.deletesPerRun * L.deleteBatch;
    let deletes = 0;
    const seen = new Set<string>(), candidates: string[] = [];
    let cursor: string | null = null, listed = false;
    for (let pages = 0; pages < L.maxPages && candidates.length < capacity; pages += 1) {
      const page = await list({ isRootObservation: 'true', toStartTime: cutoff, ...(cursor ? { cursor } : {}) });
      for (const row of page.rows) {
        if (seen.has(row.traceId)) continue;
        seen.add(row.traceId);
        if (row.projectId === own) candidates.push(row.traceId); else tally.skipped_project += 1;
      }
      cursor = page.cursor;
      if (!cursor) { listed = true; break; }
    }
    const work = candidates.slice(0, capacity);
    tally.candidates = work.length;
    for (let at = 0; at < work.length; at += L.deleteBatch) {
      const batch = work.slice(at, at + L.deleteBatch);
      // Anything in these traces that started after the cutoff keeps the trace. A guard answer with more than one page
      // keeps the whole batch: never delete on a partial read.
      const recent = await list({ filter: JSON.stringify([
        { type: 'stringOptions', column: 'traceId', operator: 'any of', value: batch },
        { type: 'datetime', column: 'startTime', operator: '>=', value: cutoff },
      ]) });
      const kept = recent.cursor ? new Set(batch) : new Set(recent.rows.map(row => row.traceId));
      const eligible = batch.filter(id => !kept.has(id));
      tally.skipped_recent += batch.length - eligible.length;
      if (mode === 'dry') { tally.would_delete += eligible.length; continue; }
      if (!eligible.length) continue;
      await call(`${base}/api/public/traces`, { method: 'DELETE', body: JSON.stringify({ traceIds: eligible }) });
      deletes += 1;
      tally.deleted += eligible.length;
    }
    const scoresUrl = new URL(`${base}/api/public/v3/scores`);
    for (const [key, value] of Object.entries({ name: 'reply_rating', toTimestamp: cutoff, limit: String(L.scoresPerRun) })) scoresUrl.searchParams.set(key, value);
    const scored = await call(scoresUrl) as { data?: unknown; meta?: { cursor?: unknown } };
    if (!Array.isArray(scored?.data)) throw new Refused(0);
    const stale = scored.data.flatMap((item: { id?: unknown; projectId?: unknown }) => (typeof item?.id === 'string' && item.id && item.projectId === own ? [item.id] : []));
    // Score deletes take what the trace deletes left of the run's budget.
    const allowed = mode === 'dry' ? stale.length : Math.min(stale.length, L.deletesPerRun - deletes);
    if (mode === 'dry') tally.would_delete_scores = stale.length;
    else for (const id of stale.slice(0, allowed)) { await call(`${base}/api/public/scores/${encodeURIComponent(id)}`, { method: 'DELETE' }); deletes += 1; tally.scores_deleted += 1; }
    const scoresLeft = allowed < stale.length || (typeof scored.meta?.cursor === 'string' && scored.meta.cursor.length > 0);
    return outcome(listed && work.length === candidates.length && !scoresLeft ? 'complete' : 'incomplete');
  } catch (error) {
    if (error instanceof RateLimited) return outcome('incomplete');
    return outcome(tally.deleted + tally.scores_deleted > 0 ? 'partial' : 'failed');
  }
};

export const langfuseSweepLogLine = (o: LangfuseSweepOutcome): string =>
  `langfuse retention sweep ${o.mode} ${o.state} backlog=${o.backlog} overdue=${o.overdue} daily_new=${o.daily_new} days_to_clear=${o.days_to_clear} candidates=${o.candidates} deleted=${o.deleted} would_delete=${o.would_delete} skipped_recent=${o.skipped_recent} skipped_project=${o.skipped_project} scores_deleted=${o.scores_deleted} would_delete_scores=${o.would_delete_scores} requests=${o.requests} last_status=${o.last_status}`;
