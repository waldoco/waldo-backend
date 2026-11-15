import { describe, expect, it } from 'vitest';
import { HEALTH_WEAR_PACKAGE_V1, healthIngestV1Schema } from '../../contracts/src/app/health-ingest';
import { produceHealthScores } from '../src/health/producer';
import { dailyScoresFor } from '../src/health/scores';

// A Galaxy Watch night through Health Connect, as health-connect-galaxy-watch.test.ts has it, plus the night's RMSSD that the
// phone computed from Waldo's own watch app's beat intervals, in the same Health Connect batch. The series read marks that
// reading waldo_wear (pgTAP waldo_health_wear_hrv_mark) and Samsung Health's samsung_writer. Off, the producer leaves the
// watch's readings out, so a row is as if they were never sent; on, they count as a trusted writer's. Every value is synthetic.
const SAMSUNG = 'com.sec.android.app.shealth';
const TZ = 'Asia/Kolkata', OFFSET = 330, HOUR = 3_600_000;
const TODAY = '2026-11-01';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const local = (day: string, hour: number, minute = 0) => Date.parse(`${day}T00:00:00Z`) + hour * HOUR + minute * 60_000 - OFFSET * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const wobble = (i: number, span: number) => ((i * 7919) % (2 * span + 1)) - span;
const hc = (writer: string) => ({ read_api: 'health_connect', source_bundle_id: null, source_package_name: writer, source_version: null, source_revision: null, device_ref: null, recording_method: 'automatic' });
const wear = { read_api: 'wear_sensor', source_bundle_id: null, source_package_name: HEALTH_WEAR_PACKAGE_V1, source_version: null, source_revision: null, device_ref: null, recording_method: 'automatic' };

type Sample = Record<string, unknown>;
const common = (id: string, day: string, from: number, to: number, origin: object) => ({ sample_id: id, revision: 1, origin, start_at: iso(from), end_at: iso(to), day, utc_offset_minutes: OFFSET });
const nightOf = (day: string) => ({ from: local(addDays(day, -1), 23), to: local(day, 6, 30) });
const samsungDay = (day: string, i: number, lastHour: number): Sample[] => {
  const { from, to } = nightOf(day);
  const hour = (h: number, value: number): Sample => ({ ...common(`hc-hr-${day}-${h}`, day, local(day, h), local(day, h) + HOUR, hc(SAMSUNG)), signal: 'heart_rate_window', unit: 'beats_per_minute', value, min: value - 6, max: value + 9, n_samples: 60 });
  return [
    { ...common(`hc-sleep-${day}`, day, from, to, hc(SAMSUNG)), signal: 'sleep_duration', unit: 'minutes', method: 'asleep_duration', value: 435 + wobble(i, 20) },
    { ...common(`hc-mid-${day}`, day, from, to, hc(SAMSUNG)), signal: 'sleep_midpoint', unit: 'local_minute', method: 'sleep_midpoint', value: 165 + wobble(i, 12) },
    ...Array.from({ length: lastHour + 1 }, (_, h) => hour(h, h < 7 || h === 23 ? 53 + wobble(h + i, 3) : 76 + wobble(h + i, 4))),
  ];
};
const watchNight = (day: string, i: number, origin: object = wear): Sample => {
  const { from, to } = nightOf(day);
  return { ...common(`overnight_hrv:wear:rmssd:${day}`, day, from, to, origin), signal: 'overnight_hrv', unit: 'milliseconds', method: 'rmssd', value: 44 + wobble(i, 6) };
};
const days = (nights: number) => Array.from({ length: nights }, (_, i) => ({ day: addDays(TODAY, -i), i }));
const samsungOnly = (nights: number) => days(nights).flatMap(({ day, i }) => samsungDay(day, i, i === 0 ? 11 : 23));
const withWatch = (nights: number, origin: object = wear) => [...samsungOnly(nights), ...days(nights).map(({ day, i }) => watchNight(day, i, origin))];

// What waldo.health_series_read returns: no origin, and each mark exactly as the migration sets it.
const asRead = (s: Sample): Sample => {
  const { origin: raw, sample_id: _id, revision: _rev, min: _min, max: _max, n_samples: _n, unit: _unit, ...rest } = s;
  const o = raw as { read_api?: string; source_package_name?: string } | undefined;
  const wearMark = s.signal === 'overnight_hrv' && s.method === 'rmssd' && o?.read_api === 'wear_sensor' && o.source_package_name === HEALTH_WEAR_PACKAGE_V1;
  return { ...rest, timezone: TZ, ...(o?.source_package_name === SAMSUNG ? { samsung_writer: true } : {}), ...(wearMark ? { waldo_wear: true } : {}) };
};

type Row = Record<string, any>;
const produceRaw = async (samples: readonly Sample[], wearHrv?: boolean): Promise<string[]> => {
  const written: string[] = [];
  const read = samples.map(asRead);
  await produceHealthScores({
    readSeries: async range => ({ access: 'granted', read_at: iso(local(TODAY, 12)).replace('Z', '000Z'), sources: [{ source: 'health_connect', consent_epoch: 1, truncated: false, samples: read.filter(s => range.signals.includes(String(s.signal))) }] }),
    writeContext: async payload => { written.push(payload); return { written: true }; },
    compute: dailyScoresFor('1'),
    readDemand: async () => ({ state: 'available', days: Array.from({ length: 31 }, (_, i) => ({ day: addDays(TODAY, -i), busy_minutes: 240 + wobble(i, 40), partial: false })) }),
    ...(wearHrv === undefined ? {} : { wearHrv }),
  }, { now: local(TODAY, 12), timezone: TZ });
  return written;
};
const produce = async (samples: readonly Sample[], wearHrv?: boolean): Promise<Row[]> => (await produceRaw(samples, wearHrv)).map(payload => JSON.parse(payload));
const today = (rows: readonly Row[]) => rows.find(r => r.day === TODAY)!;

describe('the night\'s RMSSD from Waldo\'s watch app', () => {
  it('uploads in the Health Connect batch beside Samsung Health\'s night', () => {
    const samples = [...samsungDay(TODAY, 0, 11), watchNight(TODAY, 0)];
    expect(healthIngestV1Schema.safeParse({ request_id: 'hc-upload-wear-1', source: 'health_connect', consent_epoch: 1, timezone: TZ, anchor_before: null, anchor_after: 'hc-anchor-1', samples, deletions: [] }).success).toBe(true);
  });

  it('off, writes every row byte for byte as it would with no watch reading sent', async () => {
    const without = await produceRaw(samsungOnly(25));
    expect(without.length).toBeGreaterThan(1);
    expect(today(without.map(payload => JSON.parse(payload))).recovery).toMatchObject({ activation: 'accepted', hrv_method: null });
    expect(await produceRaw(withWatch(25))).toStrictEqual(without);
    expect(await produceRaw(withWatch(25), false)).toStrictEqual(without);
  });

  it('on, scores Recovery with the watch\'s RMSSD beside Samsung Health\'s night, and accepts it', async () => {
    const recovery = today(await produce(withWatch(25), true)).recovery;
    expect(recovery).toMatchObject({ algorithm_version: 'recovery.v5', activation: 'accepted', hrv_method: 'rmssd' });
    expect(recovery.used.signals).toContain('hrv');
  });

  it('on, takes it from the first night, on the RMSSD prior', async () => {
    expect(today(await produce(withWatch(1), true)).recovery).toMatchObject({ activation: 'accepted', hrv_method: 'rmssd' });
  });

  it('on, keeps a row a candidate when Waldo\'s package names a reading the read did not mark as the watch\'s', async () => {
    const own = today(await produce(withWatch(25), true)).recovery;
    const mislabelled = today(await produce(withWatch(25, { ...wear, read_api: 'health_connect' }), true)).recovery;
    expect(mislabelled).toMatchObject({ activation: 'candidate_unaccepted', hrv_method: 'rmssd', score: own.score });
  });

  it('on, does not make another writer\'s reading count: one foreign heart-rate hour still leaves the row a candidate', async () => {
    const samples = withWatch(25);
    const at = samples.findIndex(s => s.signal === 'heart_rate_window');
    const stray = samples.map((s, i) => (i === at ? { ...s, origin: hc('com.example.ringapp') } : s));
    expect(today(await produce(stray, true)).recovery).toMatchObject({ activation: 'candidate_unaccepted' });
  });
});
