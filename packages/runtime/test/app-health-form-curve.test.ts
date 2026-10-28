import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleApp } from '../src/channels/app-api';
import type { ConsoleAuth } from '../src/identity/console-auth';

// The Worker's own recompute, when the owner's object cannot take the notice, carries the Form curve switch from its
// environment to the producer: written with "1", never otherwise. Every reading is synthetic.
const SECRET = 'fictional-router-secret-00000000000000000';
const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;
const env = (over: Record<string, string> = {}) => ({
  OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ error: 'unavailable' }, { status: 503 }) }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET, ...over,
}) as never;

const TODAY = '2026-03-20';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const at = (day: string, hour: number) => `${day}T${String(hour).padStart(2, '0')}:00:00.000Z`;
const wobble = (i: number, amp: number) => ((i * 7919) % 13 - 6) / 6 * amp;
type Sample = Record<string, unknown>;
const sample = (signal: string, day: string, over: Sample): Sample => ({ signal, day, utc_offset_minutes: 0, timezone: 'UTC', value: 1, ...over });
const dayOfReadings = (day: string, i: number, through: number): Sample[] => [
  sample('sleep_duration', day, { start_at: at(addDays(day, -1), 22), end_at: at(day, 8), value: 450 + wobble(i, 20), method: 'asleep_duration' }),
  sample('sleep_midpoint', day, { start_at: at(addDays(day, -1), 22), end_at: at(day, 8), value: 180 + wobble(i, 15), method: 'sleep_midpoint' }),
  sample('overnight_hrv', day, { start_at: at(addDays(day, -1), 22), end_at: at(day, 8), value: 55 + wobble(i, 6), method: 'rmssd' }),
  sample('resting_heart_rate', day, { start_at: at(day, 3), end_at: at(day, 4), value: 56 + wobble(i, 2) }),
  ...Array.from({ length: through }, (_, h) => [
    sample('heart_rate_window', day, { start_at: at(day, h), end_at: at(day, h + 1), value: 70 + wobble(h + i, 2) }),
    sample('movement_duration', day, { start_at: at(day, h), end_at: at(day, h + 1), value: 12 + wobble(h + i, 2) }),
  ]).flat(),
];
const series = { access: 'granted', read_at: '2026-03-20T14:30:00.000123Z', sources: [{ source: 'apple', consent_epoch: 3, truncated: false, samples: Array.from({ length: 20 }, (_, i) => dayOfReadings(addDays(TODAY, -i), i, i === 0 ? 15 : 24)).flat() }] };
const receipt = { request_id: 'health-upload-001', source: 'apple', consent_epoch: 3, accepted: 1, deleted: 0, ignored: 0, anchor_after: 'opaque-anchor-1', replayed: false };
const batch = { request_id: 'health-upload-001', source: 'apple', consent_epoch: 3, timezone: 'UTC', anchor_before: null, anchor_after: 'opaque-anchor-1', samples: [{ sample_id: 'm-1', revision: 1_760_000_000, signal: 'steps_window', unit: 'count', value: 1200, start_at: at(TODAY, 8), end_at: at(TODAY, 9), day: TODAY, utc_offset_minutes: 0 }], deletions: [] };

let rows: Record<string, unknown>[] = [];
beforeEach(() => {
  rows = [];
  vi.useFakeTimers({ toFake: ['Date'], now: Date.parse('2026-03-20T14:30:00Z') });
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const fn = url.split('/rpc/')[1]!;
    const body = JSON.parse(String(init.body)) as Record<string, string>;
    if (fn === 'health_ingest') return Response.json(receipt);
    if (fn === 'health_series_read') {
      const signals = (JSON.parse(body.p_payload!) as { signals: string[] }).signals;
      return Response.json({ ...series, sources: series.sources.map(s => ({ ...s, samples: s.samples.filter(e => signals.includes(String(e.signal))) })) });
    }
    if (fn === 'health_context_write') { rows.push(JSON.parse(body.p_payload!) as Record<string, unknown>); return Response.json({ written: true }); }
    return Response.json({});
  });
});
afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

const ingest = async (over: Record<string, string>) => {
  const work: Promise<unknown>[] = [];
  await handleApp(new Request('https://w.test/app/v1/health/ingest', { method: 'POST', headers: { authorization: `Bearer ${CREDENTIAL}`, 'content-type': 'application/json' }, body: JSON.stringify(batch) }), env(over), auth, p => { work.push(p); });
  await Promise.all(work);
};

describe('the Worker recompute and the Form curve switch', () => {
  it('writes today\'s curve and stress word with the switch at "1" and the provisional engine on', async () => {
    await ingest({ HEALTH_PROVISIONAL_SCORES: '1', HEALTH_FORM_CURVE: '1' });
    const today = rows.find(r => r.day === TODAY) as Record<string, any>;
    expect(today.form_curve.points.length).toBeGreaterThan(1);
    expect(today.form_curve.version).toBe(today.form.algorithm_version);
    expect(rows.filter(r => 'form_curve' in r).map(r => r.day)).toEqual([TODAY]);
  });
  it('writes neither with the switch absent, "0" or anything but "1"', async () => {
    for (const flag of [undefined, '0', '', 'true', ' 1']) {
      rows = [];
      await ingest({ HEALTH_PROVISIONAL_SCORES: '1', ...(flag === undefined ? {} : { HEALTH_FORM_CURVE: flag }) });
      expect(rows.length, String(flag)).toBeGreaterThan(0);
      expect(JSON.stringify(rows), String(flag)).not.toMatch(/form_curve|stress_trend/);
    }
  });
});
