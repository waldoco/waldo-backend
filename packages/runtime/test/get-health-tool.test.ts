import { describe, expect, it } from 'vitest';
import { getHealthResultSchema } from '@waldo/contracts';
import { md5Hex } from '../src/channels/md5';
import { getHealthHandler, healthReadBook } from '../src/tools/live/health';

// Synthetic readings only. The owner's local day is Asia/Kolkata; "now" is 12:00 IST on 13 Oct 2026.
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-10-13T06:30:00Z') };
const row = (source: string, purpose: string, status: string, epoch: number) =>
  ({ consent_class: 'health_processing', source, purpose, version: 2, status, epoch, granted_at: '2026-10-01T00:00:00Z', withdrawn_at: null, deletion_state: 'not_required' });
const consent = (storage: string, model: string, source = 'apple', epoch = 3) => ({ consents: [row(source, 'storage_compute', storage, epoch), row(source, 'model_processing', model, epoch)] });
const both = (...lists: { consents: unknown[] }[]) => ({ consents: lists.flatMap(list => list.consents) });
const reading = (signal: string, day: string, value: number, extra: Record<string, unknown> = {}) => ({ signal, day, value, start_at: null, end_at: null, timezone: 'Asia/Kolkata', method: null, ...extra });
const series = {
  access: 'granted', read_at: '2026-10-13T06:00:00.000Z',
  sources: [
    { source: 'apple', consent_epoch: 3, samples: [
      reading('sleep_duration', '2026-10-12', 412, { method: 'asleep_duration', start_at: '2026-10-11T17:30:00Z', end_at: '2026-10-12T00:45:00Z' }),
      reading('sleep_duration', '2026-10-12', 480, { method: 'time_in_bed', start_at: '2026-10-11T17:00:00Z', end_at: '2026-10-12T01:00:00Z' }),
      reading('sleep_duration', '2026-10-11', 390, { start_at: '2026-10-10T18:00:00Z', end_at: '2026-10-11T00:30:00Z' }),
      reading('overnight_hrv', '2026-10-12', 52.5, { method: 'sdnn', start_at: '2026-10-11T20:00:00Z', end_at: '2026-10-11T23:00:00Z' }),
      reading('overnight_hrv', '2026-10-11', 48, { method: 'sdnn', start_at: '2026-10-10T20:00:00Z', end_at: '2026-10-10T23:00:00Z' }),
      reading('overnight_hrv', '2026-10-12', 30, { method: 'rmssd', start_at: '2026-10-11T20:00:00Z', end_at: '2026-10-11T23:00:00Z' }),
      reading('heart_rate_window', '2026-10-12', 62, { start_at: '2026-10-12T03:00:00Z', end_at: '2026-10-12T04:00:00Z' }),
      reading('heart_rate_window', '2026-10-12', 70, { start_at: '2026-10-12T04:00:00Z', end_at: '2026-10-12T05:00:00Z' }),
      reading('heart_rate_window', '2026-10-12', 78, { start_at: '2026-10-12T05:00:00Z', end_at: '2026-10-12T06:00:00Z' }),
      reading('movement_duration', '2026-10-12', 10, { start_at: '2026-10-12T03:00:00Z', end_at: '2026-10-12T04:00:00Z' }),
      reading('movement_duration', '2026-10-12', 25, { start_at: '2026-10-12T05:00:00Z', end_at: '2026-10-12T06:00:00Z' }),
      reading('resting_heart_rate', '2026-10-11', 54),
    ] },
    { source: 'samsung', consent_epoch: 3, samples: [reading('sleep_duration', '2026-10-12', 300, { method: 'asleep_duration', start_at: '2026-10-11T18:00:00Z', end_at: '2026-10-11T23:00:00Z' })] },
  ],
};

const fake = (answers: { consent?: unknown; series?: unknown | ((payload: string) => unknown) }) => {
  const calls: { fn: string; message: string; args: Record<string, string | number> }[] = [];
  const call = async (fn: string, message: string, args: Record<string, string | number>) => {
    calls.push({ fn, message, args });
    if (fn === 'health_consent_list') { if (answers.consent instanceof Error) throw answers.consent; return answers.consent ?? consent('granted', 'granted'); }
    if (fn === 'health_series_read') { if (answers.series instanceof Error) throw answers.series; return typeof answers.series === 'function' ? answers.series(String(args['p_payload'])) : answers.series ?? series; }
    throw new Error(`unexpected rpc ${fn}`);
  };
  return { calls, handler: getHealthHandler(healthReadBook(call, 'do-x'), clock) };
};
const ctx = {} as never;

describe('get_health', () => {
  it('declares a turn-only output and serves owner turns', () => {
    const { handler } = fake({});
    expect(handler.turn_only_output).toBe(true);
    expect(handler.trigger_allowlist).toContain('user_message');
  });

  it('signs the consent list and the series read like the health plane does, over the exact payload text', async () => {
    const { calls, handler } = fake({});
    await handler.handle({ signals: ['hrv'], from: '2026-10-10', to: '2026-10-12', aggregation: 'daily' }, ctx);
    const payload = JSON.stringify({ from: '2026-10-10', to: '2026-10-12', signals: ['overnight_hrv'] });
    expect(calls).toEqual([
      { fn: 'health_consent_list', message: `health.consent_list.do-x.${md5Hex('{}')}`, args: { p_do_name: 'do-x', p_payload: '{}' } },
      { fn: 'health_series_read', message: `health.series_read.do-x.${md5Hex(payload)}`, args: { p_do_name: 'do-x', p_payload: payload } },
    ]);
  });

  it('gives daily HRV from one source and one method, labelled, with a null for a day without a reading', async () => {
    const { handler } = fake({});
    const result = await handler.handle({ signals: ['hrv'], from: '2026-10-10', to: '2026-10-12', aggregation: 'daily' }, ctx);
    expect(result.ok && getHealthResultSchema.parse(result.data)).toEqual({
      state: 'available', timezone: 'Asia/Kolkata', from: '2026-10-10', to: '2026-10-12', read_at: '2026-10-13T06:00:00.000Z', freshness: 'fresh', coverage: 0.667,
      signals: [{ signal: 'hrv', unit: 'ms', source: 'apple', method: 'sdnn', days: [{ day: '2026-10-10', value: null }, { day: '2026-10-11', value: 48 }, { day: '2026-10-12', value: 52.5 }] }],
    });
  });

  it('counts only time asleep as sleep, and takes the source with the most readings', async () => {
    const { handler } = fake({});
    const result = await handler.handle({ signals: ['sleep'], from: '2026-10-11', to: '2026-10-12', aggregation: 'daily' }, ctx);
    expect(result.ok && result.data.state === 'available' && result.data.signals[0]).toEqual({ signal: 'sleep', unit: 'minutes', source: 'apple', method: 'asleep', days: [{ day: '2026-10-11', value: 390 }, { day: '2026-10-12', value: 412 }] });
  });

  it('summarises a day mean for heart rate and a day sum for movement', async () => {
    const { handler } = fake({});
    const result = await handler.handle({ signals: ['heart_rate', 'movement', 'resting_hr'], from: '2026-10-11', to: '2026-10-12', aggregation: 'summary' }, ctx);
    expect(result.ok && result.data.state === 'available' && result.data).toMatchObject({
      coverage: 0.5,
      signals: [
        { signal: 'heart_rate', unit: 'bpm', source: 'apple', method: null, summary: { mean: 70, min: 70, max: 70, days_with_value: 1 } },
        { signal: 'movement', unit: 'minutes', source: 'apple', method: null, summary: { mean: 35, min: 35, max: 35, days_with_value: 1 } },
        { signal: 'resting_hr', unit: 'bpm', source: 'apple', method: null, summary: { mean: 54, min: 54, max: 54, days_with_value: 1 } },
      ],
    });
  });

  it('reads nothing when a consent is withdrawn, and says so', async () => {
    const { calls, handler } = fake({ consent: consent('granted', 'withdrawn') });
    const result = await handler.handle({ signals: ['sleep'], from: '2026-10-12', to: '2026-10-12', aggregation: 'daily' }, ctx);
    expect(result).toEqual({ ok: true, data: { state: 'unavailable', reason: 'consent_withdrawn' }, source_taint: null });
    expect(calls.map((call) => call.fn)).toEqual(['health_consent_list']);
  });

  it('names the other reasons: consent not granted, not linked, no readings, a failed read', async () => {
    const asked = { signals: ['sleep' as const], from: '2026-10-12', to: '2026-10-12', aggregation: 'daily' as const };
    const reason = async (answers: Parameters<typeof fake>[0]) => { const result = await fake(answers).handler.handle(asked, ctx); return result.ok ? result.data : result; };
    expect(await reason({ consent: consent('not_granted', 'granted') })).toEqual({ state: 'unavailable', reason: 'consent_required' });
    expect(await reason({ consent: { consents: [] } })).toEqual({ state: 'unavailable', reason: 'consent_required' });
    expect(await reason({ consent: { error: 'not_linked' } })).toEqual({ state: 'unavailable', reason: 'not_linked' });
    expect(await reason({ series: { error: 'not_linked' } })).toEqual({ state: 'unavailable', reason: 'not_linked' });
    expect(await reason({ series: { access: 'granted', read_at: '2026-10-13T06:00:00.000Z', sources: [] } })).toEqual({ state: 'unavailable', reason: 'no_readings' });
    expect(await reason({ series: new Error('router down') })).toEqual({ state: 'unavailable', reason: 'read_failed' });
    expect(await reason({ consent: new Error('router down') })).toEqual({ state: 'unavailable', reason: 'read_failed' });
    expect(await reason({ series: { access: 'granted' } })).toEqual({ state: 'unavailable', reason: 'read_failed' });
  });

  it('reads only the sources whose own purposes are both granted, whatever their epochs say', async () => {
    // Apple withdrew model use at its epoch 2; Samsung granted both at its epoch 3. Apple has more readings, and none of them may be used.
    const mixed = both(consent('granted', 'withdrawn', 'apple', 2), consent('granted', 'granted', 'samsung', 3));
    const result = await fake({ consent: mixed }).handler.handle({ signals: ['sleep'], from: '2026-10-11', to: '2026-10-12', aggregation: 'daily' }, ctx);
    expect(result.ok && result.data.state === 'available' && result.data.signals[0]).toEqual({ signal: 'sleep', unit: 'minutes', source: 'samsung', method: 'asleep', days: [{ day: '2026-10-11', value: null }, { day: '2026-10-12', value: 300 }] });
    // The other way round: Apple's withdrawal at a higher epoch does not hide Samsung's live consent.
    const later = both(consent('withdrawn', 'withdrawn', 'apple', 4), consent('granted', 'granted', 'samsung', 1));
    const live = await fake({ consent: later }).handler.handle({ signals: ['sleep'], from: '2026-10-12', to: '2026-10-12', aggregation: 'daily' }, ctx);
    expect(live.ok && live.data.state === 'available' && live.data.signals[0]?.source).toBe('samsung');
    // Storage granted but model use never asked on the only source: not withdrawn, not granted.
    const asked = await fake({ consent: consent('granted', 'not_granted') }).handler.handle({ signals: ['sleep'], from: '2026-10-12', to: '2026-10-12', aggregation: 'daily' }, ctx);
    expect(asked).toEqual({ ok: true, data: { state: 'unavailable', reason: 'consent_required' }, source_taint: null });
  });

  it('summarises a signal with no reading in the range as nulls, never as zeros', async () => {
    const result = await fake({}).handler.handle({ signals: ['heart_rate', 'resting_hr'], from: '2026-10-12', to: '2026-10-12', aggregation: 'summary' }, ctx);
    expect(result.ok && result.data.state === 'available' && result.data.signals.map(signal => signal.summary)).toEqual([
      { mean: 70, min: 70, max: 70, days_with_value: 1 },
      { mean: null, min: null, max: null, days_with_value: 0 },
    ]);
  });

  it('refuses a range that ends after today in the owner\'s zone, before any read', async () => {
    const { calls, handler } = fake({});
    const result = await handler.handle({ signals: ['sleep'], from: '2026-10-13', to: '2026-10-14', aggregation: 'daily' }, ctx);
    expect(result).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(calls).toEqual([]);
  });

  it('ages the result from the newest reading it used', async () => {
    const old = { ...series, sources: [{ source: 'apple', consent_epoch: 3, samples: [reading('resting_heart_rate', '2026-10-05', 55)] }] };
    const result = await fake({ series: old }).handler.handle({ signals: ['resting_hr'], from: '2026-10-05', to: '2026-10-05', aggregation: 'daily' }, ctx);
    expect(result.ok && result.data.state === 'available' && result.data.freshness).toBe('expired');
  });
});
