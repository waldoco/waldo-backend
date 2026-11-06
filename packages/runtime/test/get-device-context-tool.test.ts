import { describe, expect, it } from 'vitest';
import { getDeviceContextResultSchema } from '@waldo/contracts';
import { md5Hex } from '../src/channels/md5';
import { deviceContextReadBook, getDeviceContextHandler } from '../src/tools/live/device-context';

// Synthetic values: made-up cells, cities and phones. "now" is 12:00 UTC on 5 Nov 2026.
const clock = { timezone: 'Asia/Kolkata', now: () => new Date('2026-11-05T12:00:00Z') };
const stored = (id: string, timezone_observed_at: string, place: Record<string, unknown> | null, extra: Record<string, unknown> = {}) => ({
  device_id: `0c9d6a7e-1f2b-4c3d-8e9f-0a1b2c3d4e5${id}`, received_at: timezone_observed_at, platform: 'ios', timezone: 'Asia/Dubai', timezone_observed_at, place, ...extra,
});
const named = { cell: 'thrr5', locality: 'Testville', region: 'Test Region', country: 'AE', observed_at: '2026-11-05T10:30:00.000Z' };

const fake = (answer: unknown) => {
  const calls: { fn: string; message: string; args: Record<string, string | number> }[] = [];
  const call = async (fn: string, message: string, args: Record<string, string | number>) => {
    calls.push({ fn, message, args });
    if (answer instanceof Error) throw answer;
    return answer;
  };
  return { calls, handler: getDeviceContextHandler(deviceContextReadBook(call, 'do-x'), clock) };
};
const ctx = {} as never;

describe('get_device_context', () => {
  it('declares a turn-only output and serves the triggers the ADR names, not the sweeps', () => {
    const { handler } = fake({ places: [] });
    expect(handler.turn_only_output).toBe(true);
    expect(handler.autonomy_gated).toBe(false);
    expect([...handler.trigger_allowlist].sort()).toEqual(['brief', 'fetch_alert', 'handoff_plan', 'intervention', 'patrol', 'user_message']);
  });

  it('signs one read for the agent purpose over the exact payload text', async () => {
    const { calls, handler } = fake({ places: [] });
    await handler.handle({}, ctx);
    const payload = JSON.stringify({ purpose: 'model' });
    expect(calls).toEqual([{ fn: 'device_context_place_read', message: `device_context.place_read.do-x.${md5Hex(payload)}`, args: { p_do_name: 'do-x', p_payload: payload } }]);
  });

  it('gives each phone\'s zone and named place with their ages, newest phone first, and never the cell', async () => {
    const { handler } = fake({ places: [stored('1', '2026-11-05T11:30:00.000Z', named), stored('2', '2026-11-04T12:00:00.000Z', null, { platform: 'android', timezone: 'Asia/Kolkata' })] });
    const answer = await handler.handle({}, ctx);
    expect(answer).toEqual({ ok: true, source_taint: null, data: { state: 'available', devices: [
      { device: 1, platform: 'ios', timezone: 'Asia/Dubai', timezone_observed_at: '2026-11-05T11:30:00.000Z', timezone_age_minutes: 30,
        place: { locality: 'Testville', region: 'Test Region', country: 'AE', observed_at: '2026-11-05T10:30:00.000Z', age_minutes: 90 } },
      { device: 2, platform: 'android', timezone: 'Asia/Kolkata', timezone_observed_at: '2026-11-04T12:00:00.000Z', timezone_age_minutes: 1440, place: null },
    ] } });
    expect(getDeviceContextResultSchema.safeParse((answer as { data: unknown }).data).success).toBe(true);
    expect(JSON.stringify(answer)).not.toContain('thrr5');
  });

  it('keeps a place the OS could not name as a place without names', async () => {
    const { handler } = fake({ places: [stored('1', '2026-11-05T11:30:00.000Z', { cell: 'thrr5', observed_at: '2026-11-05T11:30:00.000Z' })] });
    expect(((await handler.handle({}, ctx)) as { data: { devices: { place: unknown }[] } }).data.devices[0]!.place).toEqual({ observed_at: '2026-11-05T11:30:00.000Z', age_minutes: 30 });
  });

  it('says why when there is nothing to give, and never invents a place', async () => {
    for (const [answer, reason] of [
      [{ error: 'consent_required' }, 'consent_required'], [{ error: 'consent_withdrawn' }, 'consent_withdrawn'], [{ error: 'not_linked' }, 'not_linked'],
      [{ error: 'relation does not exist' }, 'read_failed'], [null, 'read_failed'], [new Error('network'), 'read_failed'], [{ places: 'x' }, 'read_failed'],
      [{ places: [] }, 'no_data'], [{ places: [stored('1', '2026-11-05T11:30:00.000Z', { ...named, cell: 'tdr1vx' })] }, 'no_data'],
    ] as const) expect(await fake(answer).handler.handle({}, ctx)).toEqual({ ok: true, source_taint: null, data: { state: 'unavailable', reason } });
    expect(await getDeviceContextHandler(deviceContextReadBook(null, 'do-x'), clock).handle({}, ctx)).toEqual({ ok: true, source_taint: null, data: { state: 'unavailable', reason: 'not_linked' } });
  });
});
