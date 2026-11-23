import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  healthScoresHistoryDayV1Schema, healthScoresHistoryResponseV1Schema, healthScoresResponseV1Schema, healthScoresV1Schema,
  healthPartsV1Schema, healthUsualListV1Schema,
} from '../../contracts/src/app/health-ingest';
import fixture from '../../contracts/src/app/fixtures/health-scores-parts.v13.json';
import { handleApp } from '../src/channels/app-api';
import { healthScoresView } from '../src/channels/app-health';
import type { ConsoleAuth } from '../src/identity/console-auth';

// Health revision 13: the parts of each score and the owner's usual, served only to a build that names it and only while the
// switch for each is on; every earlier revision gets exactly the bytes it had. Synthetic values only.
const SECRET = 'fictional-router-secret-00000000000000000';
const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;
const env = (over: Record<string, string> = {}) => ({
  OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ error: 'unavailable' }, { status: 503 }) }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET, ...over,
}) as never;

const rpcs: Array<{ fn: string; body: Record<string, unknown> }> = [];
let answers: Record<string, unknown> = {};
beforeEach(() => {
  rpcs.length = 0; answers = {};
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const fn = url.split('/rpc/')[1]!;
    rpcs.push({ fn, body: JSON.parse(String(init.body)) });
    return Response.json(answers[fn] ?? {});
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const contracts = (revision: string): Record<string, string> => ({ 'x-waldo-app-contract': revision });
const call = (path: string, header: Record<string, string>, over: Record<string, string> = {}) =>
  handleApp(new Request(`https://w.test${path}`, { headers: { authorization: `Bearer ${CREDENTIAL}`, ...header } }), env(over), auth) as Promise<Response>;
const text = async (path: string, header: Record<string, string>, over: Record<string, string> = {}) => { const response = await call(path, header, over); return [response.status, await response.text()] as const; };
const SCORES = '/app/v1/health/scores', HISTORY = '/app/v1/health/scores/history?days=7';

const { scores: served, history: servedHistory } = fixture as unknown as { scores: Record<string, any>; history: Record<string, any> };
// The database's rows: its own zone words, and the two new columns beside the pillars.
const stored = (zone: string, score: number, version: string, over: Record<string, unknown> = {}) => ({ score, zone, algorithm_version: version, activation: 'accepted', confidence: 0.8, hrv_method: null, ...over });
const pillars = {
  recovery: stored('good', 71, 'recovery.v5', { hrv_method: 'rmssd', baseline: served.recovery.baseline }),
  form: stored('good', 64, 'form.v9', { baseline: served.form.baseline }),
  weight: stored('moderate', 51, 'weight.v5', { baseline: served.weight.baseline }),
};
const row = (over: Record<string, unknown> = {}) => ({ day: served.day, timezone: served.timezone, compiled_at: served.compiled_at, freshness: 'fresh', ...pillars, ...over });
const withExtras = row({ components: served.components, usual: served.usual });
const histRow = (over: Record<string, unknown> = {}) => ({ day: servedHistory.days[0].day, recovery: pillars.recovery, form: { reason: 'intraday_inputs_unavailable' }, weight: { reason: 'calendar_demand_unavailable' }, components: servedHistory.days[0].components, ...over });
const answerOf = (rows: unknown[]) => ({ history: { from: servedHistory.from, to: servedHistory.to, days: rows } });
const REVISIONS_BELOW = ['', 'health=1', 'health=2', 'health=3', 'health=4', 'health=5', 'health=6', 'health=7', 'health=8', 'health=9', 'health=10', 'health=11', 'health=12', 'approvals=4,health=12'];
const header = (revision: string) => (revision === '' ? {} : contracts(revision));

describe('scores at health revision 13', () => {
  it('serves every earlier build exactly the bytes it had, with a row that holds both columns', async () => {
    for (const revision of REVISIONS_BELOW) {
      answers = { health_scores_read: { scores: row() } };
      const before = await text(SCORES, header(revision));
      answers = { health_scores_read: { scores: withExtras } };
      const after = await text(SCORES, header(revision));
      expect(after, revision).toEqual(before);
      expect(after[1], revision).not.toMatch(/components|usual/);
    }
  });
  it('shows a build that names revision 13 or later the parts and the bands, in the contract\'s shape', async () => {
    answers = { health_scores_read: { scores: withExtras } };
    for (const revision of ['health=13', 'health=14', 'approvals=4,health=13']) {
      const [status, body] = await text(SCORES, contracts(revision));
      const parsed = JSON.parse(body);
      expect(status).toBe(200);
      expect(healthScoresResponseV1Schema.safeParse(parsed).success, revision).toBe(true);
      expect(parsed.components).toEqual(served.components);
      expect(parsed.usual).toEqual(served.usual);
      expect(parsed.recovery.score).toBe(71);
    }
  });
  it('leaves both keys out for a row that has neither, never as nulls, and the keys of the body are the ones it had', async () => {
    answers = { health_scores_read: { scores: row() } };
    const body = JSON.parse((await text(SCORES, contracts('health=13')))[1]);
    expect(Object.keys(body)).toEqual(['day', 'timezone', 'compiled_at', 'freshness', 'recovery', 'form', 'weight', ...(body.drivers ? ['drivers'] : [])]);
  });
  it('makes one database call with the owner\'s own scope, the same as before', async () => {
    answers = { health_scores_read: { scores: withExtras } };
    await text(SCORES, contracts('health=13'));
    await text(`${SCORES}?day=${served.day}`, contracts('health=13'));
    expect(rpcs.map(r => r.fn)).toEqual(['health_scores_read', 'health_scores_read']);
    expect(rpcs.map(r => r.body.p_do_name)).toEqual(['owner-1', 'owner-1']);
    expect(rpcs.map(r => r.body.p_payload)).toEqual(['{}', JSON.stringify({ day: served.day })]);
  });
  it('is additive only: a pin from before revision 13 parses every earlier answer and refuses the new one, strictly', async () => {
    const pinned = healthScoresV1Schema.omit({ components: true, usual: true });
    answers = { health_scores_read: { scores: withExtras } };
    for (const revision of REVISIONS_BELOW) expect(pinned.safeParse(JSON.parse((await text(SCORES, header(revision)))[1])).success, revision).toBe(true);
    expect(pinned.safeParse(JSON.parse((await text(SCORES, contracts('health=13')))[1])).success).toBe(false);
    expect(healthScoresV1Schema.safeParse(JSON.parse((await text(SCORES, contracts('health=13')))[1])).success).toBe(true);
  });
  it('leaves out a stored column that does not read, with a tag that holds no value, and costs the owner nothing else', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const damaged = [{ recovery: [{ ...served.components.recovery[0], share: 7 }] }, { cardio: [] }, 'parts', 7, []];
    for (const components of damaged) {
      answers = { health_scores_read: { scores: row({ components, usual: served.usual }) } };
      const body = JSON.parse((await text(SCORES, contracts('health=13')))[1]);
      expect(body.components, JSON.stringify(components)).toBeUndefined();
      expect(body.usual).toEqual(served.usual);
      expect(body.recovery.score).toBe(71);
    }
    answers = { health_scores_read: { scores: row({ components: served.components, usual: [{ ...served.usual[0], low: 999 }] }) } };
    const body = JSON.parse((await text(SCORES, contracts('health=13')))[1]);
    expect(body.usual).toBeUndefined();
    expect(body.components).toEqual(served.components);
    expect(error).toHaveBeenCalledWith('app health scores components shape');
    expect(error).toHaveBeenCalledWith('app health scores usual shape');
    expect(error.mock.calls.map(args => JSON.stringify(args)).join('\n')).not.toMatch(/share|centre|above_usual|\d/);
  });
  it('never gives back a score the view withholds as the sum of its parts', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const damaged = { ...pillars.recovery, baseline: { state: 'provisional', personal_days: 5 } };
    answers = { health_scores_read: { scores: row({ recovery: damaged, components: served.components, usual: served.usual }) } };
    const body = JSON.parse((await text(SCORES, contracts('health=13')))[1]);
    expect(body.recovery).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
    expect(Object.keys(body.components).sort()).toEqual(['form', 'groups', 'weight']);
    expect(body.components.groups.map((group: { key: string }) => group.key)).toEqual(['circadian']);
    expect(JSON.stringify(body)).not.toContain('"hrv"');
    expect(body.usual).toEqual(served.usual);
    // A row whose pillar is unavailable and still holds parts for it shows no parts for it either, and none at all when none is left.
    answers = { health_scores_read: { scores: row({ form: { reason: 'intraday_inputs_unavailable' }, weight: { reason: 'calendar_demand_unavailable' }, components: { form: served.components.form, weight: served.components.weight } }) } };
    const bare = JSON.parse((await text(SCORES, contracts('health=13')))[1]);
    expect(bare.components).toBeUndefined();
    expect(healthScoresResponseV1Schema.safeParse(bare).success).toBe(true);
  });
  it('never shows the owner\'s console either, which reads at revision 4 with no extras', () => {
    for (const revision of [4, 7, 12, 13, 14]) {
      const view = healthScoresView({ scores: withExtras }, null, Date.parse(served.compiled_at), revision) as { body: Record<string, unknown> };
      expect(Object.keys(view.body), String(revision)).not.toEqual(expect.arrayContaining(['components']));
      expect(JSON.stringify(view.body)).not.toMatch(/components|usual/);
    }
    const shown = healthScoresView({ scores: withExtras }, null, Date.parse(served.compiled_at), 13, { scoreParts: true, usual: true }) as { body: Record<string, unknown> };
    expect(shown.body.components).toEqual(served.components);
  });
});

describe('score history at health revision 13', () => {
  const days = async (revision: string, over: Record<string, string> = {}, rows: unknown[] = [histRow()]) => {
    answers = { health_scores_history: answerOf(rows) };
    const [status, body] = await text(HISTORY, header(revision), over);
    return [status, JSON.parse(body)] as const;
  };
  it('serves builds from revision 4 up to 12 exactly the bytes they had', async () => {
    for (const revision of ['health=4', 'health=5', 'health=6', 'health=7', 'health=12']) {
      answers = { health_scores_history: answerOf([histRow({ components: undefined })]) };
      const before = await text(HISTORY, contracts(revision));
      answers = { health_scores_history: answerOf([histRow()]) };
      const after = await text(HISTORY, contracts(revision));
      expect(after, revision).toEqual(before);
      expect(after[1]).not.toMatch(/components/);
    }
  });
  it('keeps the route absent below revision 4, as it was', async () => {
    for (const revision of ['', 'health=1', 'health=3']) {
      answers = { health_scores_history: answerOf([histRow()]) };
      expect(await text(HISTORY, header(revision)), revision).toEqual([404, JSON.stringify({ error: 'invalid_request' })]);
    }
    expect(rpcs).toEqual([]);
  });
  it('gives a build that names revision 13 each day\'s parts while the parts switch is on, and never the bands', async () => {
    const [status, body] = await days('health=13');
    expect(status).toBe(200);
    expect(healthScoresHistoryResponseV1Schema.safeParse(body).success).toBe(true);
    expect(body.days[0].components).toEqual(servedHistory.days[0].components);
    expect(JSON.stringify(body)).not.toMatch(/"usual":/);
  });
  it('asks the database for parts only when it will show them, so every other read carries none', async () => {
    const asked = async (revision: string) => { rpcs.length = 0; await days(revision); return rpcs.map(r => r.body.p_payload); };
    expect(await asked('health=13')).toEqual([JSON.stringify({ days: 7, parts: true })]);
    for (const revision of ['health=12', 'health=7', 'health=4']) expect(await asked(revision), revision).toEqual([JSON.stringify({ days: 7 })]);
  });
  it('shows a day\'s parts only for the pillars the day shows as available', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const damaged = { ...pillars.recovery, baseline: { state: 'provisional', personal_days: 5 } };
    const [, body] = await days('health=13', {}, [histRow({ recovery: damaged })]);
    expect(body.days[0].recovery).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
    expect(body.days[0].components).toBeUndefined();
    expect(healthScoresHistoryResponseV1Schema.safeParse(body).success).toBe(true);
  });
  it('is additive only: a pin from before revision 13 parses the earlier days and refuses the new one', async () => {
    const pinnedDay = healthScoresHistoryDayV1Schema.omit({ components: true });
    for (const revision of ['health=4', 'health=7', 'health=12']) for (const day of (await days(revision))[1].days) expect(pinnedDay.safeParse(day).success, revision).toBe(true);
    for (const day of (await days('health=13'))[1].days) expect(pinnedDay.safeParse(day).success).toBe(false);
  });
  it('leaves out one day\'s parts that do not read and keeps the day, and every day without parts as it was', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const second = { ...histRow(), day: '2026-11-02', components: { recovery: [{ ...servedHistory.days[0].components.recovery[0], score: 400 }] } };
    const third = { ...histRow(), day: '2026-10-31', components: undefined };
    const [, body] = await days('health=13', {}, [third, histRow(), second]);
    expect(body.days.map((entry: { day: string }) => entry.day)).toEqual(['2026-10-31', '2026-11-01', '2026-11-02']);
    expect(body.days.map((entry: { components?: unknown }) => entry.components !== undefined)).toEqual([false, true, false]);
    expect(error).toHaveBeenCalledWith('app health scores history parts shape');
    expect(error.mock.calls.map(args => JSON.stringify(args)).join('\n')).not.toMatch(/400|share/);
  });
});

describe('the contract and the served pieces agree', () => {
  it('serves the fixture\'s parts and bands as the contract reads them', () => {
    expect(healthPartsV1Schema.safeParse(served.components).success).toBe(true);
    expect(healthUsualListV1Schema.safeParse(served.usual).success).toBe(true);
  });
});

describe('an upload recomputes the rows with the parts and bands', () => {
  const today = new Date().toISOString().slice(0, 10);
  const day = (back: number) => new Date(Date.parse(`${today}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
  const receipt = { request_id: 'health-upload-001', source: 'apple', consent_epoch: 3, accepted: 1, deleted: 0, ignored: 0, anchor_after: 'opaque-anchor-1', replayed: false };
  const batch = {
    request_id: 'health-upload-001', source: 'apple', consent_epoch: 3, timezone: 'UTC', anchor_before: null, anchor_after: 'opaque-anchor-1', deletions: [],
    samples: [{ sample_id: 'steps-1', revision: 1_760_000_000, signal: 'steps_window', unit: 'count', value: 1200, start_at: `${today}T08:00:00Z`, end_at: `${today}T09:00:00Z`, day: today, utc_offset_minutes: 0 }],
  };
  const series = {
    access: 'granted', read_at: '2026-10-11T08:00:00.000123Z',
    sources: [{ source: 'apple', consent_epoch: 3, truncated: false, samples: Array.from({ length: 25 }, (_, i) => [
      { signal: 'sleep_duration', day: day(i), start_at: `${day(i + 1)}T23:00:00.000Z`, end_at: `${day(i)}T07:00:00.000Z`, timezone: 'UTC', value: 450 + (i % 5), method: 'asleep_duration' },
      { signal: 'sleep_midpoint', day: day(i), start_at: `${day(i + 1)}T23:00:00.000Z`, end_at: `${day(i)}T07:00:00.000Z`, timezone: 'UTC', value: 180 + (i % 3) },
      { signal: 'overnight_hrv', day: day(i), start_at: `${day(i + 1)}T23:00:00.000Z`, end_at: `${day(i)}T07:00:00.000Z`, timezone: 'UTC', value: 55 + (i % 4), method: 'rmssd' },
      { signal: 'resting_heart_rate', day: day(i), start_at: `${day(i)}T03:00:00.000Z`, end_at: `${day(i)}T04:00:00.000Z`, timezone: 'UTC', value: 56 + (i % 2) },
    ]).flat() }],
  };
  const upload = async (over: Record<string, string>) => {
    answers = { health_ingest: receipt, health_series_read: series, health_context_write: { written: true }, health_settings_read: { sleep_need_minutes: null, updated_at: null } };
    const work: Promise<unknown>[] = [];
    const response = await handleApp(new Request('https://w.test/app/v1/health/ingest', {
      method: 'POST', headers: { authorization: `Bearer ${CREDENTIAL}`, 'content-type': 'application/json' }, body: JSON.stringify(batch),
    }), env(over), auth, p => { work.push(p); }) as Response;
    await Promise.all(work);
    expect(response.status).toBe(200);
    return rpcs.filter(r => r.fn === 'health_context_write').map(r => JSON.parse(String(r.body.p_payload)) as Record<string, any>);
  };
  it('writes the parts and the bands on the live rows, and neither on a backfilled one', async () => {
    const rows = await upload({});
    const written = rows.filter(row => row.backfilled === undefined);
    expect(written.length).toBeGreaterThan(0);
    for (const row of written) {
      expect(healthPartsV1Schema.safeParse(row.components).success).toBe(true);
      expect(healthUsualListV1Schema.safeParse(row.usual).success).toBe(true);
    }
    for (const row of rows.filter(entry => entry.backfilled === true)) expect(Object.keys(row)).not.toEqual(expect.arrayContaining(['components']));
  });
});
