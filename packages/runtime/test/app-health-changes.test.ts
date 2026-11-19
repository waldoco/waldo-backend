import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { healthScoresV1Schema } from '../../contracts/src/app/health-ingest';
import { handleApp } from '../src/channels/app-api';
import type { ConsoleAuth } from '../src/identity/console-auth';

// Health revision 18: what changed today, served on /scores only to a build that names it and only while HEALTH_CHANGES is on;
// every earlier build gets exactly the bytes it had. Synthetic values only.
const SECRET = 'fictional-router-secret-00000000000000000';
const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;
const env = (over: Record<string, string> = {}) => ({
  OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ error: 'unavailable' }, { status: 503 }) }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET, ...over,
}) as never;
let answer: unknown = {};
const logged: string[] = [];
beforeEach(() => {
  logged.length = 0;
  vi.stubGlobal('fetch', async () => Response.json(answer));
  vi.spyOn(console, 'error').mockImplementation((...args: unknown[]) => { logged.push(args.map(String).join(' ')); });
});
afterEach(() => { vi.unstubAllGlobals(); vi.restoreAllMocks(); });

const ON = { HEALTH_CHANGES: '1' };
const read = async (revision: string, over: Record<string, string> = ON) => {
  const response = await handleApp(new Request('https://w.test/app/v1/health/scores', {
    headers: { authorization: `Bearer ${CREDENTIAL}`, ...(revision ? { 'x-waldo-app-contract': revision } : {}) },
  }), env(over), auth) as Response;
  return [response.status, await response.text()] as const;
};
const day = new Date().toISOString().slice(0, 10);
const compiledAt = new Date(Date.now() - 60_000).toISOString();
const pillar = (score: number, version: string) => ({ score, zone: 'good', algorithm_version: version, activation: 'accepted', confidence: 0.8, hrv_method: null });
const changes = [
  { subject: { tier: 1, key: 'weight' }, pillar: 'weight', from: 60, to: 70, unit: 'score', against: 'yesterday', verdict: 'declined', significant: true },
  { subject: { tier: 3, key: 'resting_heart_rate', method: 'provider_resting_daily' }, pillar: 'recovery', from: 55, to: 50.4, unit: 'beats_per_minute', against: 'usual', verdict: 'improved', significant: true },
  { subject: { tier: 1, key: 'form' }, pillar: 'form', from: 60, to: 64, unit: 'score', against: 'yesterday', verdict: 'improved', significant: false },
];
const row = (over: Record<string, unknown> = {}) => ({
  day, timezone: 'UTC', compiled_at: compiledAt, freshness: 'fresh',
  recovery: pillar(72, 'recovery.v5'), form: pillar(64, 'form.v9'), weight: pillar(70, 'weight.v5'), ...over,
});

describe('/app/v1/health/scores at health revision 18', () => {
  it('serves every earlier build the bytes it had, even with the switch on and a row that holds a list', async () => {
    for (const revision of ['', 'health=4', 'health=13', 'health=17']) {
      answer = { scores: row() };
      const before = await read(revision);
      answer = { scores: row({ changes }) };
      expect(await read(revision), revision).toEqual(before);
    }
  });
  it('serves the list to a build that names revision 18, in the contract\'s shape, only with the switch on', async () => {
    answer = { scores: row({ changes }) };
    const [status, body] = await read('health=18');
    expect(status).toBe(200);
    expect(JSON.parse(body).changes).toEqual(changes);
    expect(healthScoresV1Schema.safeParse(JSON.parse(body)).success).toBe(true);
    expect(JSON.parse((await read('health=18', {}))[1])).not.toHaveProperty('changes');
    expect(JSON.parse((await read('health=18', { HEALTH_CHANGES: '0' }))[1])).not.toHaveProperty('changes');
  });
  it('never gives back a score\'s change while the score itself is withheld, and keeps a reading\'s', async () => {
    answer = { scores: row({ changes, weight: { reason: 'calendar_demand_unavailable' } }) };
    const body = JSON.parse((await read('health=18'))[1]);
    expect(body.changes.map((change: { subject: { key: string } }) => change.subject.key)).toEqual(['resting_heart_rate', 'form']);
  });
  it('leaves out a stored list it cannot read, and still serves the scores', async () => {
    answer = { scores: row({ changes: [{ ...changes[0], verdict: 'great' }] }) };
    const [status, body] = await read('health=18');
    expect(status).toBe(200);
    expect(JSON.parse(body)).not.toHaveProperty('changes');
    expect(JSON.parse(body).recovery.score).toBe(72);
    expect(logged.join('\n')).toContain('app health scores changes shape');
    expect(logged.join('\n')).not.toMatch(/great|50\.4/);
  });
});
