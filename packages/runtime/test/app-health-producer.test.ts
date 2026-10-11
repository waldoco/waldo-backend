import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { handleApp } from '../src/channels/app-api';
import { md5Hex } from '../src/channels/md5';
import { routerSignature } from '../src/identity/owner-directory';
import type { ConsoleAuth } from '../src/identity/console-auth';

const SECRET = 'fictional-router-secret-00000000000000000';
const CREDENTIAL = `owner-1.${'a'.repeat(32)}.sig`;
const auth = { readAppCredential: async (credential: string) => (credential === CREDENTIAL ? 'owner-1' : null) } as unknown as ConsoleAuth;
const env = () => ({
  TELEGRAM_OWNER_DO: { idFromName: (n: string) => n, get: () => ({ fetch: async () => Response.json({ forwarded: true }) }) },
  RESPONSIBILITY_RATE_LIMITER: { limit: async () => ({ success: true }) },
  SUPABASE_PROJECT_URL: 'https://directory.fixture.invalid', SUPABASE_PUBLISHABLE_KEY: 'fictional-public-key', WALDO_ROUTER_HMAC_SECRET: SECRET,
}) as never;

const today = new Date().toISOString().slice(0, 10);
const day = (back: number) => new Date(Date.parse(`${today}T00:00:00Z`) - back * 86_400_000).toISOString().slice(0, 10);
const receipt = { request_id: 'health-upload-001', source: 'apple', consent_epoch: 3, accepted: 1, deleted: 0, ignored: 0, anchor_after: 'opaque-anchor-1', replayed: false };
const sample = { sample_id: 'steps-1', revision: 1_760_000_000, signal: 'steps_window', unit: 'count', value: 1200, start_at: `${today}T08:00:00Z`, end_at: `${today}T09:00:00Z`, day: today, utc_offset_minutes: 0 };
const batch = { request_id: 'health-upload-001', source: 'apple', consent_epoch: 3, timezone: 'UTC', anchor_before: null, anchor_after: 'opaque-anchor-1', samples: [sample], deletions: [] };
const series = (access = 'granted') => ({
  access, read_at: '2026-10-11T08:00:00.000123Z',
  sources: access === 'granted' ? [{ source: 'apple', consent_epoch: 3, truncated: false, samples: Array.from({ length: 25 }, (_, i) => [
    { signal: 'sleep_duration', day: day(i), start_at: `${day(i + 1)}T23:00:00.000Z`, end_at: `${day(i)}T07:00:00.000Z`, timezone: 'UTC', value: 450 + (i % 5), method: 'asleep_duration' },
    { signal: 'sleep_midpoint', day: day(i), start_at: `${day(i + 1)}T23:00:00.000Z`, end_at: `${day(i)}T07:00:00.000Z`, timezone: 'UTC', value: 180 + (i % 3) },
    { signal: 'overnight_hrv', day: day(i), start_at: `${day(i + 1)}T23:00:00.000Z`, end_at: `${day(i)}T07:00:00.000Z`, timezone: 'UTC', value: 55 + (i % 4), method: 'rmssd' },
    { signal: 'resting_heart_rate', day: day(i), start_at: `${day(i)}T03:00:00.000Z`, end_at: `${day(i)}T04:00:00.000Z`, timezone: 'UTC', value: 56 + (i % 2) },
  ]).flat() }] : [],
});

type Rpc = { fn: string; body: Record<string, unknown> };
const rpcs: Rpc[] = [];
let answers: Record<string, unknown | Error> = {};
beforeEach(() => {
  rpcs.length = 0;
  answers = { health_ingest: receipt, health_series_read: series(), health_context_write: { written: true } };
  vi.stubGlobal('fetch', async (url: string, init: RequestInit) => {
    const fn = url.split('/rpc/')[1]!;
    rpcs.push({ fn, body: JSON.parse(String(init.body)) });
    const answer = answers[fn];
    if (answer instanceof Error) throw answer;
    return Response.json(answer ?? {});
  });
});
afterEach(() => { vi.unstubAllGlobals(); });

const ingest = async (body: unknown = batch, defer?: (work: Promise<unknown>) => void) => handleApp(new Request('https://w.test/app/v1/health/ingest', {
  method: 'POST', headers: { authorization: `Bearer ${CREDENTIAL}`, 'content-type': 'application/json' }, body: JSON.stringify(body),
}), env(), auth, defer) as Promise<Response>;
const deferrals = () => { const work: Promise<unknown>[] = []; return { work, defer: (p: Promise<unknown>) => { work.push(p); } }; };

describe('health producer after an ingest commit', () => {
  it('reads the series and writes the derived rows once the batch is committed, after the receipt is settled', async () => {
    const d = deferrals();
    const response = await ingest(batch, d.defer);
    expect([response.status, await response.json()]).toEqual([200, receipt]);
    expect(d.work).toHaveLength(1);
    await Promise.all(d.work);
    const fns = rpcs.map(r => r.fn);
    expect(fns[0]).toBe('health_ingest');
    expect(fns[1]).toBe('health_series_read');
    expect(fns.slice(2).every(fn => fn === 'health_context_write')).toBe(true);
    expect(fns.length).toBeGreaterThan(2);
  });

  it('signs the series read and each write over the exact payload it sends', async () => {
    const d = deferrals();
    await ingest(batch, d.defer);
    await Promise.all(d.work);
    for (const rpc of rpcs.slice(1)) {
      const op = rpc.fn.replace('health_', '');
      expect(rpc.body.p_sig).toBe(await routerSignature(SECRET, rpc.body.p_at as number, `health.${op}.owner-1.${md5Hex(rpc.body.p_payload as string)}`));
    }
    expect(JSON.parse(rpcs[1]!.body.p_payload as string)).toEqual({ from: day(30), to: today });
  });

  it('writes the read instant and the consent epoch it read, so the database can fence on both', async () => {
    const d = deferrals();
    await ingest(batch, d.defer);
    await Promise.all(d.work);
    const written = JSON.parse(rpcs[2]!.body.p_payload as string);
    expect(written.read_at).toBe('2026-10-11T08:00:00.000123Z');
    expect(written.basis).toEqual([{ source: 'apple', consent_epoch: 3 }]);
  });

  it('does not run for a replayed batch, an empty one, a refused one or a caller with no way to defer', async () => {
    for (const answer of [{ ...receipt, replayed: true }, { ...receipt, accepted: 0, deleted: 0, ignored: 1 }, { error: 'epoch_conflict' }, { error: 'consent_required' }]) {
      answers.health_ingest = answer;
      const d = deferrals();
      await ingest(batch, d.defer);
      expect(d.work).toHaveLength(0);
    }
    answers.health_ingest = receipt;
    rpcs.length = 0;
    expect((await ingest(batch)).status).toBe(200);
    expect(rpcs.map(r => r.fn)).toEqual(['health_ingest']);
  });

  it('runs for a batch that only deletes readings', async () => {
    answers.health_ingest = { ...receipt, accepted: 0, deleted: 2 };
    const d = deferrals();
    await ingest(batch, d.defer);
    expect(d.work).toHaveLength(1);
    await Promise.all(d.work);
  });

  it('never lets a producer failure change the ingest answer, and never rejects', async () => {
    for (const broken of [new Error('down'), null, { access: 'granted' }]) {
      answers.health_series_read = broken as never;
      const d = deferrals();
      const response = await ingest(batch, d.defer);
      expect([response.status, await response.json()]).toEqual([200, receipt]);
      await expect(Promise.all(d.work)).resolves.toBeDefined();
    }
    answers.health_series_read = series();
    answers.health_context_write = new Error('down');
    const d = deferrals();
    expect((await ingest(batch, d.defer)).status).toBe(200);
    await expect(Promise.all(d.work)).resolves.toBeDefined();
  });

  it('writes nothing when storage consent is not live', async () => {
    answers.health_series_read = series('consent_withdrawn');
    const d = deferrals();
    await ingest(batch, d.defer);
    await Promise.all(d.work);
    expect(rpcs.map(r => r.fn)).toEqual(['health_ingest', 'health_series_read']);
  });
});
