import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthScoresHistoryResponseV1Schema } from '../../contracts/src/app/health-ingest';
import { handleApp } from '../src/channels/app-api';
import type { ConsoleAuth } from '../src/identity/console-auth';

// The Body screen's six months and year: 180 and 365 daily rows for a build that names health revision 18, never a day's parts.
// Synthetic values only.
const SECRET = 'fictional-router-secret-00000000000000000';
const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;
const env = { OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({}) }) }, RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET, HEALTH_SCORE_PARTS: '1' } as never;
const asked: Record<string, unknown>[] = [];
let answer: unknown = {};
beforeEach(() => {
  asked.length = 0;
  vi.stubGlobal('fetch', async (_url: string, init: RequestInit) => { asked.push(JSON.parse(JSON.parse(String(init.body)).p_payload)); return Response.json(answer); });
});
afterEach(() => { vi.unstubAllGlobals(); });

const read = async (days: string, revision: string) => {
  const response = await handleApp(new Request(`https://w.test/app/v1/health/scores/history?days=${days}`, {
    headers: { authorization: `Bearer ${CREDENTIAL}`, 'x-waldo-app-contract': revision },
  }), env, auth) as Response;
  return [response.status, await response.json()] as const;
};
const pillar = { score: 62, zone: 'good', algorithm_version: 'recovery.v5', activation: 'accepted', confidence: 0.8, hrv_method: null };
const day = (at: string) => ({ day: at, recovery: pillar, form: { reason: 'stale_inputs' }, weight: { reason: 'calendar_demand_unavailable' } });

describe('/app/v1/health/scores/history for six months and a year', () => {
  it('serves 180 and 365 days to a build that names revision 18, as daily rows, and asks for no parts', async () => {
    answer = { history: { from: '2025-11-20', to: '2026-11-19', days: [day('2025-11-20'), day('2026-06-01'), day('2026-11-19')] } };
    const [status, body] = await read('365', 'health=18');
    expect(status).toBe(200);
    expect(healthScoresHistoryResponseV1Schema.safeParse(body).success).toBe(true);
    expect(body.window_days).toBe(365);
    expect(body.days.map((entry: { day: string }) => entry.day)).toEqual(['2025-11-20', '2026-06-01', '2026-11-19']);
    expect(asked).toEqual([{ days: 365 }]);
    answer = { history: { from: '2026-05-24', to: '2026-11-19', days: [day('2026-11-19')] } };
    expect((await read('180', 'health=18'))[1].window_days).toBe(180);
    expect(asked.at(-1)).toEqual({ days: 180 });
  });
  it('still asks for the parts in a window of ninety days or fewer', async () => {
    answer = { history: { from: '2026-08-22', to: '2026-11-19', days: [day('2026-11-19')] } };
    await read('90', 'health=18');
    expect(asked).toEqual([{ days: 90, parts: true }]);
  });
  it('refuses a long window to a build below revision 18, and asks the database nothing', async () => {
    for (const revision of ['health=4', 'health=13', 'health=17']) {
      for (const days of ['180', '365']) expect((await read(days, revision))[0], `${revision} ${days}`).toBe(400);
    }
    expect(asked).toEqual([]);
  });
});
