import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthScoresResponseV1Schema, healthScoresV1Schema } from '../../contracts/src/app/health-ingest';
import fixture from '../../contracts/src/app/fixtures/health-body-day.v10.json';
import { handleApp } from '../src/channels/app-api';
import type { ConsoleAuth } from '../src/identity/console-auth';

// Health revision 10: the day's load, today's Form curve and today's stress curve, served only to a build that names it and only
// while the switch for each is on; every earlier revision gets exactly the bytes it had. Synthetic values only.
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
const ON = { HEALTH_DAY_LOAD: '1', HEALTH_FORM_CURVE: '1', HEALTH_STRESS_CURVE: '1' };
const SCORES = '/app/v1/health/scores', HISTORY = '/app/v1/health/scores/history?days=7';
const NEW_KEYS = ['day_load', 'form_curve', 'stress_curve'];

const { scores: served } = fixture as unknown as { scores: Record<string, any> };
// The database's row: its own zone words, and the three new columns beside the pillars.
const stored = (zone: string, score: number, version: string, over: Record<string, unknown> = {}) => ({ score, zone, algorithm_version: version, activation: 'accepted', confidence: 0.8, hrv_method: null, ...over });
const pillars = {
  recovery: stored('good', 71, 'recovery.v5', { hrv_method: 'rmssd', baseline: served.recovery.baseline }),
  form: stored('good', 64, 'form.v9', { baseline: served.form.baseline }),
  weight: stored('moderate', 51, 'weight.v5', { baseline: served.weight.baseline }),
};
const row = (over: Record<string, unknown> = {}) => ({ day: served.day, timezone: served.timezone, compiled_at: served.compiled_at, freshness: 'fresh', ...pillars, ...over });
const withExtras = row({ day_load: served.day_load, form_curve: served.form_curve, stress_curve: served.stress_curve });
const REVISIONS_BELOW = ['', 'health=1', 'health=2', 'health=3', 'health=4', 'health=5', 'health=6', 'health=7', 'health=8', 'health=9', 'approvals=4,health=9'];
const header = (revision: string) => (revision === '' ? {} : contracts(revision));
const keysOf = async (revision: string, over: Record<string, string>) => Object.keys(JSON.parse((await text(SCORES, contracts(revision), over))[1])).filter(key => NEW_KEYS.includes(key));

describe('scores at health revision 10', () => {
  it('serves every earlier build exactly the bytes it had, with all three switches on and a row that holds all three columns', async () => {
    for (const revision of REVISIONS_BELOW) {
      answers = { health_scores_read: { scores: row() } };
      const before = await text(SCORES, header(revision), ON);
      answers = { health_scores_read: { scores: withExtras } };
      const after = await text(SCORES, header(revision), ON);
      expect(after, revision).toEqual(before);
      expect(after[1], revision).not.toMatch(/day_load|form_curve|stress_curve/);
    }
  });
  it('shows a build that names revision 10 or later each of the three, in the contract\'s shape, with the switches on', async () => {
    answers = { health_scores_read: { scores: withExtras } };
    for (const revision of ['health=10', 'health=11', 'approvals=4,health=10']) {
      const [status, body] = await text(SCORES, contracts(revision), ON);
      const parsed = JSON.parse(body);
      expect(status).toBe(200);
      expect(healthScoresResponseV1Schema.safeParse(parsed).success, revision).toBe(true);
      expect(parsed.day_load).toEqual(served.day_load);
      expect(parsed.form_curve).toEqual(served.form_curve);
      expect(parsed.stress_curve).toEqual(served.stress_curve);
      expect(parsed.recovery.score).toBe(71);
    }
  });
  it('shows each only while its own switch is on, and none with all off, which is exactly the revision-9 answer', async () => {
    answers = { health_scores_read: { scores: withExtras } };
    const nine = await text(SCORES, contracts('health=9'), ON);
    expect(await keysOf('health=10', ON)).toEqual(NEW_KEYS);
    expect(await keysOf('health=10', { HEALTH_DAY_LOAD: '1' })).toEqual(['day_load']);
    expect(await keysOf('health=10', { HEALTH_FORM_CURVE: '1' })).toEqual(['form_curve']);
    expect(await keysOf('health=10', { HEALTH_STRESS_CURVE: '1' })).toEqual(['stress_curve']);
    expect(await keysOf('health=10', { HEALTH_DAY_LOAD: '0', HEALTH_FORM_CURVE: '0', HEALTH_STRESS_CURVE: '0' })).toEqual([]);
    expect(await keysOf('health=10', {})).toEqual([]);
    for (const value of ['', 'true', 'on', ' 1', '01']) expect(await keysOf('health=10', { HEALTH_DAY_LOAD: value, HEALTH_FORM_CURVE: value, HEALTH_STRESS_CURVE: value }), value).toEqual([]);
    expect(await text(SCORES, contracts('health=10'), { HEALTH_DAY_LOAD: '0', HEALTH_FORM_CURVE: '0', HEALTH_STRESS_CURVE: '0' })).toEqual(nine);
  });
  it('leaves all three keys out for a row that has none, never as nulls', async () => {
    answers = { health_scores_read: { scores: row() } };
    const body = JSON.parse((await text(SCORES, contracts('health=10'), ON))[1]);
    expect(Object.keys(body)).toEqual(['day', 'timezone', 'compiled_at', 'freshness', 'recovery', 'form', 'weight', ...(body.drivers ? ['drivers'] : [])]);
  });
  it('shows a load for a day nothing worn saw as unavailable with its reason, and no curve beside it', async () => {
    answers = { health_scores_read: { scores: row({ day_load: { state: 'unavailable', reason: 'no_readings' } }) } };
    const body = JSON.parse((await text(SCORES, contracts('health=10'), ON))[1]);
    expect(body.day_load).toEqual({ state: 'unavailable', reason: 'no_readings' });
    expect(body.form_curve).toBeUndefined();
  });
  it('makes one database call with the owner\'s own scope, the same as before', async () => {
    answers = { health_scores_read: { scores: withExtras } };
    await text(SCORES, contracts('health=10'), ON);
    expect(rpcs.map(r => r.fn)).toEqual(['health_scores_read']);
    expect(rpcs[0]!.body.p_do_name).toBe('owner-1');
    expect(rpcs[0]!.body.p_payload).toBe('{}');
  });
  it('is additive only: a pin from before revision 10 parses every earlier answer and refuses the new one, strictly', async () => {
    const pinned = healthScoresV1Schema.omit({ day_load: true, form_curve: true, stress_curve: true });
    answers = { health_scores_read: { scores: withExtras } };
    for (const revision of REVISIONS_BELOW) expect(pinned.safeParse(JSON.parse((await text(SCORES, header(revision), ON))[1])).success, revision).toBe(true);
    expect(pinned.safeParse(JSON.parse((await text(SCORES, contracts('health=10'), ON))[1])).success).toBe(false);
    expect(healthScoresV1Schema.safeParse(JSON.parse((await text(SCORES, contracts('health=10'), ON))[1])).success).toBe(true);
  });
  it('leaves out a stored column that does not read, with a tag that holds no value, and costs the owner nothing else', async () => {
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    answers = { health_scores_read: { scores: row({ day_load: { ...served.day_load, score: 101 }, form_curve: { ...served.form_curve, points: [] }, stress_curve: 'rising' }) } };
    const body = JSON.parse((await text(SCORES, contracts('health=10'), ON))[1]);
    expect(NEW_KEYS.filter(key => key in body)).toEqual([]);
    expect(body.recovery.score).toBe(71);
    for (const key of NEW_KEYS) expect(error).toHaveBeenCalledWith(`app health scores ${key} shape`);
    expect(error.mock.calls.map(args => JSON.stringify(args)).join('\n')).not.toMatch(/\d/);
  });
  it('never gives back a Form score the view withholds as the last point of the curve', async () => {
    vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const damaged = { ...pillars.form, baseline: { state: 'provisional', personal_days: 5 } };
    answers = { health_scores_read: { scores: row({ form: damaged, day_load: served.day_load, form_curve: served.form_curve, stress_curve: served.stress_curve }) } };
    const body = JSON.parse((await text(SCORES, contracts('health=10'), ON))[1]);
    expect(body.form).toEqual({ state: 'unavailable', reason: 'baseline_immature' });
    expect(body.form_curve).toBeUndefined();
    expect(JSON.stringify(body)).not.toContain('"kind":"measured"');
    expect(body.day_load).toEqual(served.day_load);
    expect(body.stress_curve).toEqual(served.stress_curve);
    expect(body.recovery.score).toBe(71);
  });
  it('never carries any of the three in the score history, at any revision, with the switches on', async () => {
    const day = { day: served.day, recovery: pillars.recovery, form: { reason: 'intraday_inputs_unavailable' }, weight: { reason: 'calendar_demand_unavailable' } };
    const answer = { history: { from: '2026-10-27', to: served.day, days: [day] } };
    for (const revision of ['health=4', 'health=8', 'health=9', 'health=10']) {
      answers = { health_scores_history: answer };
      const [status, body] = await text(HISTORY, contracts(revision), ON);
      expect(status, revision).toBe(200);
      expect(body, revision).not.toMatch(/day_load|form_curve|stress_curve/);
    }
    expect(rpcs.every(r => r.fn === 'health_scores_history' && !/day_load|form_curve|stress_curve/.test(String(r.body.p_payload)))).toBe(true);
  });
});
