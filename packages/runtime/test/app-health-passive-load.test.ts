import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthScoresResponseV1Schema } from '../../contracts/src/app/health-ingest';
import fixture from '../../contracts/src/app/fixtures/health-body-day.v14.json';
import passive from '../../contracts/src/app/fixtures/health-passive-load.v15.json';
import { handleApp } from '../src/channels/app-api';
import type { ConsoleAuth } from '../src/identity/console-auth';

// Health revision 15: a stored v2 day load is served as v2 with its parts only to a build that names revision 15; any other
// build is served that day's v1 load and no parts.
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
const loadAt = async (revision: string, dayLoad: unknown) => {
  answers = { health_scores_read: { scores: row(dayLoad) } };
  const response = await call(SCORES, contracts(revision));
  expect(response.status).toBe(200);
  const body = await response.json() as Record<string, any>;
  expect(healthScoresResponseV1Schema.safeParse(body).success).toBe(true);
  return body.day_load;
};
const STORED_V2 = { ...v2, v1 };

describe('the day load at health revision 15', () => {
  it('serves a stored v2 load with its parts and without the v1 beside it to a build that names 12', async () => {
    expect(await loadAt('health=15', STORED_V2)).toEqual(v2);
    expect(await loadAt('health=15', v1WithParts)).toEqual(v1WithParts);
    expect(await loadAt('health=15', v1)).toEqual(v1);
  });
  it('serves that day\'s v1 load and no parts to builds at 10 and 11, so none loses the day', async () => {
    for (const revision of ['health=14']) {
      expect(await loadAt(revision, STORED_V2), revision).toEqual(v1);
      expect(await loadAt(revision, v1WithParts), revision).toEqual(v1);
    }
  });
  it('serves no day load below 10', async () => {
    expect(await loadAt('health=13', STORED_V2)).toBeUndefined();
  });
  it('never serves the stored v1 key, at any revision', async () => {
    for (const revision of ['health=14', 'health=15']) expect(JSON.stringify(await loadAt(revision, STORED_V2))).not.toContain('"v1"');
  });
});
