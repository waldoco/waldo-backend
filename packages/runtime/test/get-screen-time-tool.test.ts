import { describe, expect, it } from 'vitest';
import { getScreenTimeResultSchema } from '@waldo/contracts';
import { md5Hex } from '../src/channels/md5';
import { getScreenTimeHandler, screenTimeReadBook } from '../src/tools/live/screen-time';

// Synthetic values. The owner's local day is Asia/Kolkata; "now" is 12:00 IST on 3 Nov 2026.
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-11-03T06:30:00Z') };
const summary = (day: string, minutes: number, extra: Record<string, unknown> = {}) => ({
  day, timezone: 'Asia/Kolkata', platform: 'android', coverage: 'complete', screen_on_minutes: minutes, pickups: 50, unlocks: 41,
  late_night_minutes: 15, late_night_window: '23:00-05:00', first_use_at: '07:05', last_use_at: '23:50', categories: [{ category: 'video', minutes: 40 }], ...extra,
});
const stored = (device: number, day: string, minutes: number, extra: Record<string, unknown> = {}) =>
  ({ device_id: `0c9d6a7e-1f2b-4c3d-8e9f-0a1b2c3d4e5${device}`, device, received_at: '2026-11-03T01:00:00.000Z', summary: summary(day, minutes, extra) });

const fake = (answer: unknown) => {
  const calls: { fn: string; message: string; args: Record<string, string | number> }[] = [];
  const call = async (fn: string, message: string, args: Record<string, string | number>) => {
    calls.push({ fn, message, args });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, handler: getScreenTimeHandler(screenTimeReadBook(call, 'do-x'), clock) };
};
const ctx = {} as never;
const range = { from: '2026-11-01', to: '2026-11-02' };

describe('get_screen_time', () => {
  it('declares a turn-only output and serves owner turns', () => {
    const { handler } = fake({ days: [] });
    expect(handler.turn_only_output).toBe(true);
    expect(handler.autonomy_gated).toBe(false);
    expect(handler.trigger_allowlist).toContain('user_message');
    expect(handler.trigger_allowlist).toContain('brief');
  });

  it('signs one read for the agent purpose over the exact payload text', async () => {
    const { calls, handler } = fake({ days: [] });
    await handler.handle(range, ctx);
    const payload = JSON.stringify({ from: '2026-11-01', to: '2026-11-02', purpose: 'model' });
    expect(calls).toEqual([{ fn: 'screen_time_days_read', message: `screen_time.days_read.do-x.${md5Hex(payload)}`, args: { p_do_name: 'do-x', p_payload: payload } }]);
  });

  it('returns each phone\'s day apart, without the zone, platform or installation id', async () => {
    const { handler } = fake({ days: [stored(1, '2026-11-01', 200), stored(1, '2026-11-02', 260), stored(2, '2026-11-02', 30)] });
    const answer = await handler.handle(range, ctx);
    expect(answer.ok).toBe(true);
    if (!answer.ok) return;
    expect(getScreenTimeResultSchema.safeParse(answer.data).success).toBe(true);
    expect(answer.data).toMatchObject({ state: 'available', from: '2026-11-01', to: '2026-11-02' });
    const days = answer.data.state === 'available' ? answer.data.days : [];
    expect(days.map(day => [day.day, day.device, day.screen_on_minutes])).toEqual([['2026-11-01', 1, 200], ['2026-11-02', 1, 260], ['2026-11-02', 2, 30]]);
    expect(days[0]).not.toHaveProperty('device_id');
    expect(days[0]).not.toHaveProperty('timezone');
    expect(days[0]).not.toHaveProperty('platform');
  });

  it('keeps a partial day as partial and leaves an unknown number out rather than zero', async () => {
    const partial = stored(1, '2026-11-02', 0, { coverage: 'partial' });
    delete (partial.summary as Record<string, unknown>).unlocks;
    const { handler } = fake({ days: [partial] });
    const answer = await handler.handle(range, ctx);
    const row = answer.ok && answer.data.state === 'available' ? answer.data.days[0] : null;
    expect(row?.coverage).toBe('partial');
    expect(row).not.toHaveProperty('unlocks');
  });

  it('leaves out a stored row that no longer reads as a day, and says so when none is left', async () => {
    const { handler } = fake({ days: [{ ...stored(1, '2026-11-02', 100), summary: { day: '2026-11-02', app: 'com.example' } }] });
    expect(await handler.handle(range, ctx)).toEqual({ ok: true, data: { state: 'unavailable', reason: 'no_data' }, source_taint: null });
  });

  it('passes the database\'s consent refusal on, and never invents data', async () => {
    for (const reason of ['consent_required', 'consent_withdrawn', 'not_linked'] as const) {
      const { handler } = fake({ error: reason });
      expect(await handler.handle(range, ctx)).toEqual({ ok: true, data: { state: 'unavailable', reason }, source_taint: null });
    }
    expect((await fake({ days: [] }).handler.handle(range, ctx))).toEqual({ ok: true, data: { state: 'unavailable', reason: 'no_data' }, source_taint: null });
  });

  it('a failed or unreadable answer is read_failed', async () => {
    for (const answer of [new Error('network'), null, { error: 'invalid_request' }, { days: 'many' }]) {
      expect(await fake(answer).handler.handle(range, ctx)).toEqual({ ok: true, data: { state: 'unavailable', reason: 'read_failed' }, source_taint: null });
    }
  });

  it('refuses a range ending after the owner\'s today, before any read', async () => {
    const { calls, handler } = fake({ days: [] });
    const answer = await handler.handle({ from: '2026-11-03', to: '2026-11-04' }, ctx);
    expect(answer).toMatchObject({ ok: false, code: 'invalid_args' });
    expect(calls).toEqual([]);
  });

  it('without a linked owner it reads nothing', async () => {
    const calls: string[] = [];
    const handler = getScreenTimeHandler(screenTimeReadBook(async (fn) => { calls.push(fn); return null; }, null), clock);
    expect(await handler.handle(range, ctx)).toEqual({ ok: true, data: { state: 'unavailable', reason: 'not_linked' }, source_taint: null });
    expect(calls).toEqual([]);
  });
});

describe('get_screen_time in diagnostics', () => {
  it('its call and output are withheld from trace text, like every health read', async () => {
    const { scrubTraceHealth, HEALTH_WITHHELD } = await import('../src/observability/trace-health-scrub');
    const entry = { trace: 't', hop: 'tool_get_screen_time', ms: 1, ok: true, text: { input: JSON.stringify(range), output: JSON.stringify({ days: [stored(1, '2026-11-02', 377)] }) } };
    expect(scrubTraceHealth(entry as never).text).toEqual({ input: HEALTH_WITHHELD, output: HEALTH_WITHHELD });
  });
});
