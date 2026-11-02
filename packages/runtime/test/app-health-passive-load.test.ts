import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthScoresResponseV1Schema } from '../../contracts/src/app/health-ingest';
import fixture from '../../contracts/src/app/fixtures/health-body-day.v10.json';
import passive from '../../contracts/src/app/fixtures/health-passive-load.v12.json';
import { handleApp } from '../src/channels/app-api';
import type { ConsoleAuth } from '../src/identity/console-auth';

// Health revision 12: a stored v2 day load is served as v2 with its parts only to a build that names revision 12 while
// HEALTH_PASSIVE_LOAD lists a source; any other build, or any build with it off, is served that day's v1 load and no parts.
// Synthetic values only.
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
const SCORES = '/app/v1/health/scores';
const { scores: served } = fixture as unknown as { scores: Record<string, any> };
const { scores: passiveScores, v1_with_parts: v1WithParts } = passive as unknown as { scores: Record<string, any>; v1_with_parts: Record<string, any> };
const v1 = served.day_load, v2 = passiveScores.day_load;
const stored = (zone: string, score: number, version: string, over: Record<string, unknown> = {}) => ({ score, zone, algorithm_version: version, activation: 'accepted', confidence: 0.8, hrv_method: null, ...over });
const pillars = {
  recovery: stored('good', 71, 'recovery.v5', { hrv_method: 'rmssd', baseline: served.recovery.baseline }),
  form: stored('good', 64, 'form.v9', { baseline: served.form.baseline }),
  weight: stored('moderate', 51, 'weight.v5', { baseline: served.weight.baseline }),
};
const row = (dayLoad: unknown) => ({ day: served.day, timezone: served.timezone, compiled_at: served.compiled_at, freshness: 'fresh', ...pillars, day_load: dayLoad });
const loadAt = async (revision: string, dayLoad: unknown, over: Record<string, string>) => {
  answers = { health_scores_read: { scores: row(dayLoad) } };
  const response = await call(SCORES, contracts(revision), over);
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, any>;
  expect(healthScoresResponseV1Schema.safeParse(body).success).toBe(true);
  return body.day_load;
};
const STORED_V2 = { ...v2, v1 };
const ON = { HEALTH_DAY_LOAD: '1', HEALTH_PASSIVE_LOAD: 'apple' };

describe('the day load at health revision 12', () => {
  it('serves a stored v2 load with its parts and without the v1 beside it to a build that names 12 while the switch lists a source', async () => {
    expect(await loadAt('health=12', STORED_V2, ON)).toEqual(v2);
    expect(await loadAt('health=12', v1WithParts, ON)).toEqual(v1WithParts);
    expect(await loadAt('health=12', v1, ON)).toEqual(v1);
  });
  it('serves that day\'s v1 load and no parts to builds at 10 and 11, so none loses the day', async () => {
    for (const revision of ['health=10', 'health=11']) {
      expect(await loadAt(revision, STORED_V2, ON), revision).toEqual(v1);
      expect(await loadAt(revision, v1WithParts, ON), revision).toEqual(v1);
    }
  });
  it('serves v1 and no parts to every build while the switch is 0, whatever the row holds: 0 is the rollback', async () => {
    for (const revision of ['health=10', 'health=12']) {
      expect(await loadAt(revision, STORED_V2, { HEALTH_DAY_LOAD: '1', HEALTH_PASSIVE_LOAD: '0' }), revision).toEqual(v1);
      expect(await loadAt(revision, v1WithParts, { HEALTH_DAY_LOAD: '1' }), revision).toEqual(v1);
    }
  });
  it('serves no day load below 10, or with HEALTH_DAY_LOAD off', async () => {
    expect(await loadAt('health=9', STORED_V2, ON)).toBeUndefined();
    expect(await loadAt('health=12', STORED_V2, { HEALTH_PASSIVE_LOAD: 'apple' })).toBeUndefined();
  });
  it('never serves the stored v1 key, at any revision', async () => {
    for (const revision of ['health=10', 'health=11', 'health=12']) expect(JSON.stringify(await loadAt(revision, STORED_V2, ON))).not.toContain('"v1"');
  });
});
