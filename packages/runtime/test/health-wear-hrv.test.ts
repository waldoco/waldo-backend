import { describe, expect, it } from 'vitest';
import { HEALTH_WEAR_PACKAGE_V1, healthIngestV1Schema } from '../../contracts/src/app/health-ingest';
import { produceHealthScores } from '../src/health/producer';
import { dailyScoresFor } from '../src/health/scores';

// A Galaxy Watch night through Health Connect, as health-connect-galaxy-watch.test.ts has it, plus the night's RMSSD that the
// phone computed from Waldo's own watch app's beat intervals, in the same Health Connect batch. The series read marks that
// reading waldo_wear (pgTAP waldo_health_wear_hrv_mark). Off, the producer leaves the watch's readings out, so a row is as if
// they were never sent; on, they count like any Health Connect reading. Every value is synthetic.
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

// What waldo.health_series_read returns: no origin, an hour of heart rate's lowest and highest, and each mark exactly as the
// migration sets it (every reading from Waldo's watch app, whatever its signal).
const asRead = (s: Sample): Sample => {
  const { origin: raw, sample_id: _id, revision: _rev, min, max, n_samples: _n, unit: _unit, ...rest } = s;
  const o = raw as { read_api?: string; source_package_name?: string } | undefined;
  const wearMark = o?.read_api === 'wear_sensor' && o.source_package_name === HEALTH_WEAR_PACKAGE_V1;
  return { ...rest, timezone: TZ, ...(s.signal === 'heart_rate_window' ? { min, max } : {}), ...(o?.source_package_name === SAMSUNG ? { samsung_writer: true } : {}), ...(wearMark ? { waldo_wear: true } : {}) };
};

type Row = Record<string, any>;
const produceRaw = async (samples: readonly Sample[], wearHrv?: boolean, wearAllDay?: boolean): Promise<string[]> => {
  const written: string[] = [];
  const read = samples.map(asRead);
  await produceHealthScores({
    readSeries: async range => ({ access: 'granted', read_at: iso(local(TODAY, 12)).replace('Z', '000Z'), sources: [{ source: 'health_connect', consent_epoch: 1, truncated: false, samples: read.filter(s => range.signals.includes(String(s.signal))) }] }),
    writeContext: async payload => { written.push(payload); return { written: true }; },
    compute: dailyScoresFor('1'),
    readDemand: async () => ({ state: 'available', days: Array.from({ length: 31 }, (_, i) => ({ day: addDays(TODAY, -i), busy_minutes: 240 + wobble(i, 40), partial: false })) }),
    ...(wearHrv === undefined ? {} : { wearHrv }),
    ...(wearAllDay === undefined ? {} : { wearAllDay }),
  }, { now: local(TODAY, 12), timezone: TZ });
  return written;
};
const produce = async (samples: readonly Sample[], wearHrv?: boolean, wearAllDay?: boolean): Promise<Row[]> => (await produceRaw(samples, wearHrv, wearAllDay)).map(payload => JSON.parse(payload));
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

  it('on, counts a reading under Waldo\'s package that the read did not mark as the watch\'s like any Health Connect reading, and the row is accepted', async () => {
    const own = today(await produce(withWatch(25), true)).recovery;
    const mislabelled = today(await produce(withWatch(25, { ...wear, read_api: 'health_connect' }), true)).recovery;
    expect(mislabelled).toMatchObject({ activation: 'accepted', hrv_method: 'rmssd', score: own.score });
  });

  it('off, leaves a reading the read did not mark as the watch\'s in the score: it is another app\'s Health Connect reading', async () => {
    const unmarked = withWatch(25, { ...wear, read_api: 'health_connect' });
    expect(today(await produce(unmarked, false)).recovery).toMatchObject({ activation: 'accepted', hrv_method: 'rmssd' });
  });

  it('on, a foreign writer\'s heart-rate hour beside the watch\'s night leaves the row accepted, as any Health Connect writer does', async () => {
    const samples = withWatch(25);
    const at = samples.findIndex(s => s.signal === 'heart_rate_window');
    const stray = samples.map((s, i) => (i === at ? { ...s, origin: hc('com.example.ringapp') } : s));
    expect(today(await produce(stray, true)).recovery).toMatchObject({ activation: 'accepted', hrv_method: 'rmssd' });
  });
});

// The watch app's all-day readings in the same batch: an hour of heart rate and of steps beside the phone's own hour, under
// their own ids, a blood-oxygen reading in the night and a resting rate. The read marks each waldo_wear. HEALTH_WEAR_ALL_DAY
// decides whether they count; HEALTH_WEAR_HRV still decides the night's RMSSD alone.
describe('the all-day readings from Waldo\'s watch app', () => {
  const stepHour = (day: string, h: number, value: number, origin: object, writer: string): Sample =>
    ({ ...common(`${writer}-steps-${day}-${h}`, day, local(day, h), local(day, h) + HOUR, origin), signal: 'steps_window', unit: 'count', value });
  const phoneSteps = (nights: number) => days(nights).flatMap(({ day, i }) => Array.from({ length: i === 0 ? 4 : 12 }, (_, k) => stepHour(day, 8 + k, 300 + wobble(k + i, 200), hc(SAMSUNG), 'hc')));
  const watchAllDay = (nights: number, copy: readonly Sample[]): Sample[] => [
    ...copy.map(s => ({ ...s, sample_id: `${String(s.signal)}:wear:${String(s.start_at)}`.replace(/[^A-Za-z0-9._:-]/g, ''), origin: wear })),
    ...days(nights).flatMap(({ day, i }) => {
      const { from, to } = nightOf(day);
      return [
        { ...common(`resting_heart_rate:wear:${day}`, day, from, to, wear), signal: 'resting_heart_rate', unit: 'beats_per_minute', method: 'overnight_resting', value: 50 + wobble(i, 3) },
        { ...common(`spo2:wear:${day}`, day, from + 3 * HOUR, from + 3 * HOUR, wear), signal: 'spo2', unit: 'percent', value: 95 + wobble(i, 2) },
      ];
    }),
  ];
  const phone = (nights: number): Sample[] => [...samsungOnly(nights), ...phoneSteps(nights)];
  const watchCopy = (nights: number) => watchAllDay(nights, [...phone(nights)].filter(s => s.signal === 'heart_rate_window' || s.signal === 'steps_window').map(s => ({ ...s, value: Number(s.value) + 7, ...(s.signal === 'heart_rate_window' ? { min: Number(s.min) + 7, max: Number(s.max) + 7 } : {}) })));

  it('uploads in the Health Connect batch beside the phone\'s own hours', () => {
    const samples = [...phone(1), ...watchCopy(1)];
    expect(healthIngestV1Schema.safeParse({ request_id: 'hc-upload-wear-2', source: 'health_connect', consent_epoch: 1, timezone: TZ, anchor_before: null, anchor_after: 'hc-anchor-2', samples, deletions: [] }).success).toBe(true);
  });

  it('off, writes every row byte for byte as it would with none of them sent, the vitals and the night included', async () => {
    const without = await produceRaw(phone(25));
    const all = [...phone(25), ...watchCopy(25), ...days(25).map(({ day, i }) => watchNight(day, i))];
    expect(await produceRaw(all)).toStrictEqual(without);
    expect(await produceRaw(all, false, false)).toStrictEqual(without);
    // The wear-HRV switch on lets the night in and nothing else.
    expect(await produceRaw(all, true)).toStrictEqual(await produceRaw([...phone(25), ...days(25).map(({ day, i }) => watchNight(day, i))], true));
  });

  it('on, counts them, and the night\'s RMSSD stays out until its own switch is on', async () => {
    const without = await produceRaw(phone(25), false, true);
    const watch = [...phone(25), ...watchCopy(25)];
    expect(await produceRaw(watch, false, true)).not.toStrictEqual(without);
    expect(await produceRaw([...watch, ...days(25).map(({ day, i }) => watchNight(day, i))], false, true)).toStrictEqual(await produceRaw(watch, false, true));
    expect(today(await produce(watch, false, true)).recovery).toMatchObject({ activation: 'accepted' });
  });
});
