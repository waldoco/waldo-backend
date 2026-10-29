import { describe, expect, it } from 'vitest';
import { LANGFUSE_RETENTION_CUTOFF_MS, LANGFUSE_RETENTION_LIMITS, langfuseSweepLogLine, sweepLangfuseRetention } from '../src/observability/langfuse-retention';

const NOW = Date.parse('2026-10-28T03:17:00Z');
const CUTOFF = new Date(NOW - LANGFUSE_RETENTION_CUTOFF_MS).toISOString();
const DAY = 86_400_000;
const KEYS = { LANGFUSE_PUBLIC_KEY: 'pk-lf-synthetic', LANGFUSE_SECRET_KEY: 'sk-lf-synthetic', LANGFUSE_BASE_URL: 'https://langfuse.test/' };
const LIVE = { ...KEYS, LANGFUSE_RETENTION_SWEEP: '1' };
const DRY = { ...KEYS, LANGFUSE_RETENTION_SWEEP: 'dry' };

type Obs = { id: string; traceId: string; projectId: string; startTime: string; root: boolean };
type Call = { method: string; path: string; params: Record<string, string>; body: unknown };
const ago = (days: number) => new Date(NOW - days * DAY).toISOString();

// A fake Langfuse project that answers like the API: the keys' project, observations newest first under the query, a
// cursor of `page` rows, and deletes that remove a trace's observations. `answer` can override any request.
type Score = { id: string; projectId: string; timestamp: string };
const project = (rows: Obs[], options: { page?: number; answer?: (call: Call, n: number) => Response | null; scores?: Score[] } = {}) => {
  let store = [...rows];
  let scores = [...(options.scores ?? [])];
  const calls: Call[] = [];
  const send = async (input: string | URL, init: RequestInit = {}) => {
    const url = new URL(String(input));
    const call = { method: init.method ?? 'GET', path: url.pathname, params: Object.fromEntries(url.searchParams), body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    expect(new Headers(init.headers).get('authorization')).toBe(`Basic ${btoa('pk-lf-synthetic:sk-lf-synthetic')}`);
    const override = options.answer?.(call, calls.length);
    if (override) return override;
    if (call.path === '/api/public/projects') return Response.json({ data: [{ id: 'proj-keys', name: 'waldo' }] });
    if (call.path === '/api/public/v3/scores') {
      const found = scores.filter(score => call.params.name === 'reply_rating' && score.timestamp < call.params.toTimestamp!);
      return Response.json({ data: found.slice(0, Number(call.params.limit)), meta: { limit: Number(call.params.limit), ...(found.length > Number(call.params.limit) ? { cursor: 'more' } : {}) } });
    }
    if (call.method === 'DELETE' && call.path.startsWith('/api/public/scores/')) { scores = scores.filter(score => score.id !== decodeURIComponent(call.path.split('/').pop()!)); return Response.json({ message: 'ok' }); }
    if (call.path === '/api/public/v2/metrics') {
      const query = JSON.parse(call.params.query!) as { fromTimestamp: string; toTimestamp: string };
      return Response.json({ data: [{ count_count: String(store.filter(row => row.root && row.startTime >= query.fromTimestamp && row.startTime < query.toTimestamp).length) }] });
    }
    if (call.method === 'DELETE') { const ids = new Set((call.body as { traceIds: string[] }).traceIds); store = store.filter(row => !ids.has(row.traceId)); return Response.json({ message: 'ok' }); }
    let found = [...store].sort((a, b) => b.startTime.localeCompare(a.startTime));
    if (call.params.filter) {
      const filter = JSON.parse(call.params.filter) as { column: string; operator: string; value: string | string[] }[];
      for (const f of filter) found = found.filter(row => f.column === 'traceId' ? (f.value as string[]).includes(row.traceId) : f.operator === '>=' ? row.startTime >= (f.value as string) : true);
    } else {
      if (call.params.isRootObservation === 'true') found = found.filter(row => row.root);
      if (call.params.toStartTime) found = found.filter(row => row.startTime < call.params.toStartTime!);
    }
    const page = options.page ?? Number(call.params.limit);
    const at = Number(call.params.cursor ?? '0');
    return Response.json({ data: found.slice(at, at + page).map(({ root: _root, ...row }) => row), meta: at + page < found.length ? { cursor: String(at + page) } : {} });
  };
  return { calls, send, left: () => store, scoresLeft: () => scores };
};
const trace = (id: string, rootDaysAgo: number, childDaysAgo?: number, projectId = 'proj-keys'): Obs[] => [
  { id: `${id}-root`, traceId: id, projectId, startTime: ago(rootDaysAgo), root: true },
  ...(childDaysAgo === undefined ? [] : [{ id: `${id}-child`, traceId: id, projectId, startTime: ago(childDaysAgo), root: false }]),
];
const noWait = async () => undefined;
const run = (env: object, send: Parameters<typeof sweepLangfuseRetention>[1], waits: number[] = []) =>
  sweepLangfuseRetention(env, send, { now: () => NOW, sleep: async (ms) => { waits.push(ms); } });
const deleted = (calls: Call[]) => calls.filter(call => call.method === 'DELETE').flatMap(call => (call.body as { traceIds: string[] }).traceIds);

describe('the Langfuse retention sweep', () => {
  it('is off by default: no request unless the flag is exactly "1" or "dry"', async () => {
    for (const flag of [undefined, '', '0', 'true', 'on', ' 1', 'DRY']) {
      const { calls, send } = project(trace('t-old', 40));
      expect(await sweepLangfuseRetention({ ...KEYS, LANGFUSE_RETENTION_SWEEP: flag }, send, { now: () => NOW, sleep: noWait })).toMatchObject({ mode: 'off', state: 'off' });
      expect(calls).toEqual([]);
    }
  });

  it('reports unconfigured, and asks nothing, when a Langfuse key is missing', async () => {
    const { calls, send } = project([]);
    expect(await run({ ...LIVE, LANGFUSE_SECRET_KEY: '' }, send)).toMatchObject({ state: 'unconfigured' });
    expect(calls).toEqual([]);
  });

  it('selects traces by their root\'s start before the cutoff, and never one newer or with recent activity', async () => {
    const { calls, send, left } = project([...trace('t-old', 40), ...trace('t-edge', 29.5), ...trace('t-new', 10), ...trace('t-old-active', 45, 3), ...trace('t-old-quiet', 50, 35)]);
    const outcome = await run(LIVE, send);
    expect(outcome).toMatchObject({ mode: 'live', state: 'complete', candidates: 4, deleted: 3, skipped_recent: 1, skipped_project: 0 });
    expect(deleted(calls).sort()).toEqual(['t-edge', 't-old', 't-old-quiet']);
    expect(left().map(row => row.traceId)).toEqual(expect.arrayContaining(['t-new', 't-old-active']));
    const list = calls.find(call => call.params.isRootObservation)!;
    expect(list.params).toMatchObject({ fields: 'core', isRootObservation: 'true', toStartTime: CUTOFF, limit: '1000' });
    const guard = calls.find(call => call.params.filter)!;
    expect(JSON.parse(guard.params.filter!)).toEqual([
      { type: 'stringOptions', column: 'traceId', operator: 'any of', value: expect.arrayContaining(['t-old', 't-old-active']) },
      { type: 'datetime', column: 'startTime', operator: '>=', value: CUTOFF },
    ]);
    expect(LANGFUSE_RETENTION_CUTOFF_MS).toBe(29 * DAY);
  });

  it('in dry-run lists and guards exactly as live, counts what it would delete, and deletes nothing', async () => {
    const { calls, send, left } = project([...trace('t-old', 40), ...trace('t-old-active', 45, 3), ...trace('t-new', 2)]);
    expect(await run(DRY, send)).toMatchObject({ mode: 'dry', state: 'complete', candidates: 2, deleted: 0, would_delete: 1, skipped_recent: 1 });
    expect(calls.filter(call => call.method !== 'GET')).toEqual([]);
    expect(left()).toHaveLength(4);
  });

  it('deletes only traces in the project the keys belong to', async () => {
    const { calls, send } = project([...trace('t-ours', 40), ...trace('t-theirs', 40, undefined, 'proj-other')]);
    expect(await run(LIVE, send)).toMatchObject({ deleted: 1, skipped_project: 1 });
    expect(deleted(calls)).toEqual(['t-ours']);
    const unscoped = project(trace('t-ours', 40), { answer: call => (call.path === '/api/public/projects' ? Response.json({ data: [] }) : null) });
    expect(await run(LIVE, unscoped.send)).toMatchObject({ state: 'failed', deleted: 0 });
    expect(deleted(unscoped.calls)).toEqual([]);
  });

  it('pages through candidates, deletes in batches inside Langfuse\'s advice, and spaces requests under the Hobby rate', async () => {
    const rows = Array.from({ length: 120 }, (_, i) => trace(`t${String(i).padStart(3, '0')}`, 31 + i / 10)).flat();
    const waits: number[] = [];
    const { calls, send } = project(rows, { page: 50 });
    expect(await run(LIVE, send, waits)).toMatchObject({ state: 'complete', candidates: 120, deleted: 120 });
    const deletes = calls.filter(call => call.method === 'DELETE');
    expect(Math.max(...deletes.map(call => (call.body as { traceIds: string[] }).traceIds.length))).toBeLessThanOrEqual(LANGFUSE_RETENTION_LIMITS.deleteBatch);
    expect(LANGFUSE_RETENTION_LIMITS.deleteBatch).toBeLessThanOrEqual(50);
    expect(calls.filter(call => call.params.cursor).length).toBeGreaterThan(0);
    // One request per pause at least: at most 30 a minute on the Hobby general bucket.
    expect(waits.filter(ms => ms >= LANGFUSE_RETENTION_LIMITS.spacingMs)).toHaveLength(calls.length - 1);
    expect(60_000 / LANGFUSE_RETENTION_LIMITS.spacingMs).toBeLessThanOrEqual(30);
  });

  it('stops at its daily delete budget and resumes the rest on the next run', async () => {
    const budget = LANGFUSE_RETENTION_LIMITS.deletesPerRun * LANGFUSE_RETENTION_LIMITS.deleteBatch;
    const rows = Array.from({ length: budget + 7 }, (_, i) => trace(`t${i}`, 31 + i / 1000)).flat();
    const fake = project(rows);
    expect(await run(LIVE, fake.send)).toMatchObject({ state: 'incomplete', deleted: budget });
    expect(LANGFUSE_RETENTION_LIMITS.deletesPerRun).toBeLessThan(50);
    const next = await run(LIVE, fake.send);
    expect(next).toMatchObject({ state: 'complete', deleted: 7 });
    expect(fake.left()).toEqual([]);
    const dry = project(rows);
    expect(await run(DRY, dry.send)).toMatchObject({ state: 'incomplete', would_delete: budget, deleted: 0 });
  });

  it('waits out a 429 by its Retry-After, retries, and resumes next run when the limit holds', async () => {
    const waits: number[] = [];
    let refused = 0;
    const once = project(trace('t-old', 40), { answer: call => (call.method === 'DELETE' && refused++ === 0 ? new Response('slow down', { status: 429, headers: { 'retry-after': '7' } }) : null) });
    expect(await run(LIVE, once.send, waits)).toMatchObject({ state: 'complete', deleted: 1 });
    expect(waits).toContain(7_000);
    const always = project(trace('t-old', 40), { answer: call => (call.method === 'DELETE' ? new Response('daily limit', { status: 429 }) : null) });
    expect(await run(LIVE, always.send)).toMatchObject({ state: 'incomplete', deleted: 0, last_status: 429 });
    expect(always.left()).toHaveLength(1);
  });

  it('reports a partial failure honestly: what was deleted before the failure, and the status that stopped it', async () => {
    const rows = Array.from({ length: LANGFUSE_RETENTION_LIMITS.deleteBatch * 2 }, (_, i) => trace(`t${i}`, 31 + i / 1000)).flat();
    let deletes = 0;
    const { send } = project(rows, { answer: call => (call.method === 'DELETE' && ++deletes === 2 ? new Response('broken', { status: 500 }) : null) });
    expect(await run(LIVE, send)).toMatchObject({ state: 'partial', deleted: LANGFUSE_RETENTION_LIMITS.deleteBatch, last_status: 500 });
    for (const [label, answer] of Object.entries({
      malformed: (call: Call) => (call.params.isRootObservation ? Response.json({ items: [] }) : null),
      refused: (call: Call) => (call.params.isRootObservation ? new Response('no', { status: 401 }) : null),
    })) expect([label, (await run(LIVE, project(trace('t-old', 40), { answer }).send)).state]).toEqual([label, 'failed']);
    expect(await sweepLangfuseRetention(LIVE, async () => { throw new Error('down'); }, { now: () => NOW, sleep: noWait })).toMatchObject({ state: 'failed', deleted: 0 });
  });

  it('logs counts and status codes only, never a trace id', async () => {
    const { send } = project([...trace('t-secret-id', 40), ...trace('t-active-id', 40, 1)]);
    const line = langfuseSweepLogLine(await run(LIVE, send));
    expect(line).toBe('langfuse retention sweep live complete backlog=2 overdue=2 daily_new=0 days_to_clear=1 candidates=2 deleted=1 would_delete=0 skipped_recent=1 skipped_project=0 scores_deleted=0 would_delete_scores=0 requests=8 last_status=200');
    expect(line).not.toMatch(/t-secret-id|t-active-id|proj-keys/);
  });

  it('reports the backlog it found, the daily inflow and the days to clear it, so a dry run shows whether the cap keeps up', async () => {
    const budget = LANGFUSE_RETENTION_LIMITS.deletesPerRun * LANGFUSE_RETENTION_LIMITS.deleteBatch;
    const old = Array.from({ length: 2 * budget + 10 }, (_, i) => trace(`o${i}`, 29.5 + i / 10_000)).flat();
    const today = Array.from({ length: 300 }, (_, i) => trace(`n${i}`, 0.5)).flat();
    const { calls, send } = project([...old, ...today]);
    const outcome = await run(DRY, send);
    expect(outcome).toMatchObject({ backlog: 2 * budget + 10, daily_new: 300, overdue: 0, days_to_clear: Math.ceil((2 * budget + 10) / (budget - 300)) });
    const queries = calls.filter(call => call.path === '/api/public/v2/metrics').map(call => JSON.parse(call.params.query!));
    expect(queries[0]).toEqual({ view: 'observations', metrics: [{ measure: 'count', aggregation: 'count' }], filters: [{ column: 'isRootObservation', operator: '=', value: true, type: 'boolean' }], fromTimestamp: '2020-01-01T00:00:00.000Z', toTimestamp: CUTOFF });
  });

  it('says the sweep can never catch up when more traces arrive a day than one run may delete', async () => {
    const budget = LANGFUSE_RETENTION_LIMITS.deletesPerRun * LANGFUSE_RETENTION_LIMITS.deleteBatch;
    const today = Array.from({ length: budget + 1 }, (_, i) => trace(`n${i}`, 0.5)).flat();
    expect(await run(DRY, project([...trace('o1', 40), ...today]).send)).toMatchObject({ daily_new: budget + 1, days_to_clear: 'never' });
  });

  it('counts traces already past the thirty days promised, whatever left them there', async () => {
    const { send } = project([...trace('t-31', 31), ...trace('t-29-5', 29.5), ...trace('t-45', 45)]);
    const outcome = await run(DRY, send);
    expect(outcome).toMatchObject({ backlog: 3, overdue: 2 });
    expect(langfuseSweepLogLine(outcome)).toContain('overdue=2');
  });

  it('still sweeps when Langfuse will not count, and says the counts are unknown', async () => {
    const { send } = project(trace('t-old', 40), { answer: call => (call.path === '/api/public/v2/metrics' ? new Response('bad query', { status: 400 }) : null) });
    expect(await run(LIVE, send)).toMatchObject({ state: 'complete', deleted: 1, backlog: null, overdue: null, daily_new: null, days_to_clear: null });
  });

  it('deletes rating scores older than the cutoff even when their trace never reached Langfuse, and only in the keys\' project', async () => {
    const scores = [{ id: 's-old', projectId: 'proj-keys', timestamp: ago(31) }, { id: 's-new', projectId: 'proj-keys', timestamp: ago(3) }, { id: 's-theirs', projectId: 'proj-other', timestamp: ago(40) }];
    const dry = project([], { scores });
    expect(await run(DRY, dry.send)).toMatchObject({ would_delete_scores: 1, scores_deleted: 0 });
    expect(dry.scoresLeft()).toHaveLength(3);
    const live = project([], { scores });
    expect(await run(LIVE, live.send)).toMatchObject({ state: 'complete', scores_deleted: 1 });
    expect(live.scoresLeft().map(score => score.id)).toEqual(['s-new', 's-theirs']);
    const list = live.calls.find(call => call.path === '/api/public/v3/scores')!;
    expect(list.params).toEqual({ name: 'reply_rating', toTimestamp: CUTOFF, limit: String(LANGFUSE_RETENTION_LIMITS.scoresPerRun) });
  });

  it('counts score deletes in the same daily deletion budget as trace deletes, so scores wait when traces spent it', async () => {
    const budget = LANGFUSE_RETENTION_LIMITS.deletesPerRun * LANGFUSE_RETENTION_LIMITS.deleteBatch;
    const rows = Array.from({ length: budget }, (_, i) => trace(`t${i}`, 31 + i / 10_000)).flat();
    const fake = project(rows, { scores: [{ id: 's-old', projectId: 'proj-keys', timestamp: ago(40) }] });
    expect(await run(LIVE, fake.send)).toMatchObject({ state: 'incomplete', deleted: budget, scores_deleted: 0 });
    expect(fake.calls.filter(call => call.method === 'DELETE')).toHaveLength(LANGFUSE_RETENTION_LIMITS.deletesPerRun);
    expect(await run(LIVE, fake.send)).toMatchObject({ state: 'complete', scores_deleted: 1 });
  });

  it('leaves the rest of a long score backlog to the next run', async () => {
    const scores = Array.from({ length: LANGFUSE_RETENTION_LIMITS.scoresPerRun + 3 }, (_, i) => ({ id: `s${i}`, projectId: 'proj-keys', timestamp: ago(40) }));
    const fake = project([], { scores });
    expect(await run(LIVE, fake.send)).toMatchObject({ state: 'incomplete', scores_deleted: LANGFUSE_RETENTION_LIMITS.scoresPerRun });
    expect(await run(LIVE, fake.send)).toMatchObject({ state: 'complete', scores_deleted: 3 });
  });
});
