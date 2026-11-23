import { describe, expect, it } from 'vitest';
import { healthIngestV1Schema } from '../../contracts/src/app/health-ingest';
import { produceHealthScores } from '../src/health/producer';
import { dailyScoresFor } from '../src/health/scores';

// A Galaxy Watch through Samsung Health and Health Connect, as the app's Health Connect normalizer uploads it: Samsung
// Health named as each reading's writer, a night's time asleep and midpoint, and an hourly heart-rate window, with no HRV,
// no resting heart rate and no active energy. The batch must parse, and once the series read has turned each origin into its
// samsung_writer mark (pgTAP waldo_health_series_origin), the producer scores Recovery from the night's asleep hours and
// accepts it. Every value is synthetic.
const SAMSUNG = 'com.sec.android.app.shealth';
const OTHER = 'com.example.ringapp';
const TZ = 'Asia/Kolkata', OFFSET = 330, HOUR = 3_600_000;
const TODAY = '2026-11-01';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
// A local wall-clock hour as an instant.
const local = (day: string, hour: number, minute = 0) => Date.parse(`${day}T00:00:00Z`) + hour * HOUR + minute * 60_000 - OFFSET * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const wobble = (i: number, span: number) => ((i * 7919) % (2 * span + 1)) - span;
const origin = (writer: string) => ({ read_api: 'health_connect', source_bundle_id: null, source_package_name: writer, source_version: null, source_revision: null, device_ref: null, recording_method: 'automatic' });

type Sample = Record<string, unknown>;
const common = (id: string, day: string, from: number, to: number, writer: string) => ({ sample_id: id, revision: 1, origin: origin(writer), start_at: iso(from), end_at: iso(to), day, utc_offset_minutes: OFFSET });
// One local day: the night that ends that morning, and its heart-rate hours up to lastHour, lower while asleep (23:00 to 06:30).
// hrv adds the night's HRV as the phone sends it from Health Connect, one RMSSD reading for the night.
const dayOf = (day: string, i: number, lastHour: number, writer = SAMSUNG, hrv = false): Sample[] => {
  const from = local(addDays(day, -1), 23), to = local(day, 6, 30);
  const hour = (d: string, h: number, value: number): Sample => ({ ...common(`hc-hr-${d}-${h}`, d, local(d, h), local(d, h) + HOUR, writer), signal: 'heart_rate_window', unit: 'beats_per_minute', value, min: value - 6, max: value + 9, n_samples: 60 });
  return [
    { ...common(`hc-sleep-${day}`, day, from, to, writer), signal: 'sleep_duration', unit: 'minutes', method: 'asleep_duration', value: 435 + wobble(i, 20) },
    { ...common(`hc-mid-${day}`, day, from, to, writer), signal: 'sleep_midpoint', unit: 'local_minute', method: 'sleep_midpoint', value: 165 + wobble(i, 12) },
    ...(hrv ? [{ ...common(`hc-hrv-${day}`, day, from, to, writer), signal: 'overnight_hrv', unit: 'milliseconds', method: 'rmssd', value: 52 + wobble(i, 6) }] : []),
    ...Array.from({ length: lastHour + 1 }, (_, h) => hour(day, h, h < 7 || h === 23 ? 53 + wobble(h + i, 3) : 76 + wobble(h + i, 4))),
  ];
};
const history = (nights: number, writer = SAMSUNG, hrv = false) => Array.from({ length: nights }, (_, i) => ({ day: addDays(TODAY, -i), samples: dayOf(addDays(TODAY, -i), i, i === 0 ? 11 : 23, writer, hrv) }));

// The series read returns a reading without its origin, marked samsung_writer when Samsung Health wrote it.
const asRead = (s: Sample): Sample => {
  const { origin: o, sample_id: _id, revision: _rev, min: _min, max: _max, n_samples: _n, unit: _unit, ...rest } = s;
  return { ...rest, timezone: TZ, ...((o as { source_package_name?: string } | undefined)?.source_package_name === SAMSUNG ? { samsung_writer: true } : {}) };
};

type Row = Record<string, any>;
const produce = async (samples: readonly Sample[], compute = dailyScoresFor('1')): Promise<Row[]> => {
  const written: Row[] = [];
  const read = samples.map(asRead);
  await produceHealthScores({
    readSeries: async range => ({ access: 'granted', read_at: iso(local(TODAY, 12)).replace('Z', '000Z'), sources: [{ source: 'health_connect', consent_epoch: 1, truncated: false, samples: read.filter(s => range.signals.includes(String(s.signal))) }] }),
    writeContext: async payload => { written.push(JSON.parse(payload)); return { written: true }; },
    compute,
    readDemand: async () => ({ state: 'available', days: Array.from({ length: 31 }, (_, i) => ({ day: addDays(TODAY, -i), busy_minutes: 240 + wobble(i, 40), partial: false })) }),
  }, { now: local(TODAY, 12), timezone: TZ });
  return written;
};

// The evening hours before the first night, as a first read after the owner allows Health Connect holds them.
const evening = () => dayOf(addDays(TODAY, -1), 1, 23).filter(x => x.signal === 'heart_rate_window' && Date.parse(String(x.start_at)) >= local(addDays(TODAY, -1), 20));
const today = (rows: readonly Row[]) => rows.find(r => r.day === TODAY)!;

describe('a Galaxy Watch through Health Connect', () => {
  it('uploads as the contract takes it, a day to a batch, every reading naming Samsung Health', () => {
    for (const { day, samples } of history(25)) {
      const batch = { request_id: `hc-upload-${day}`, source: 'health_connect', consent_epoch: 1, timezone: TZ, anchor_before: null, anchor_after: `hc-anchor-${day}`, samples, deletions: [] };
      expect(healthIngestV1Schema.safeParse(batch).success, day).toBe(true);
    }
  });

  it('scores Recovery on the first morning from the night\'s asleep heart-rate hours, with no HRV or resting reading, and accepts it', async () => {
    const recovery = today(await produce([...history(1).flatMap(d => d.samples), ...evening()])).recovery;
    expect(recovery).toMatchObject({ algorithm_version: 'recovery.v5', activation: 'accepted', hrv_method: null, confidence: 0.42, baseline: { state: 'provisional', personal_days: 0 } });
    expect(recovery.used.signals).toEqual(['sleep', 'resting_heart_rate']);
  });

  it('scores it on the owner\'s own baseline once the nights build up', async () => {
    expect(today(await produce(history(25).flatMap(d => d.samples))).recovery).toMatchObject({ activation: 'accepted', confidence: 0.42, baseline: { state: 'personal', personal_days: 23 } });
  });

  it('accepts a reading from another app the same as Samsung Health\'s, one app\'s hour among the other\'s', async () => {
    const samples = history(25).flatMap(d => d.samples);
    const stray = samples.map((x, i) => (i === samples.findIndex(y => y.signal === 'heart_rate_window') ? { ...x, origin: origin(OTHER) } : x));
    const [mixed, own] = [today(await produce(stray)).recovery, today(await produce(samples)).recovery];
    expect(mixed).toMatchObject({ activation: 'accepted', score: own.score, zone: own.zone, confidence: own.confidence });
  });

  it('takes no resting rate from a night it did not read whole', async () => {
    expect(today(await produce(history(1).flatMap(d => d.samples))).recovery).toEqual({ reason: 'missing_resting_signal' });
  });

  it('writes Weight without active energy, from what it has', async () => {
    const weight = today(await produce(history(25).flatMap(d => d.samples))).weight;
    expect(weight).toMatchObject({ activation: 'accepted', used: { signals: ['calendar'] } });
  });
});

// A phone whose sleep and HRV come from an app that is not Samsung Health (Fitbit, Nothing X, a ring): the series read carries
// no mark for it, and its night scores like any other, accepted at the Health Connect confidence.
describe('another app\'s night through Health Connect', () => {
  it('scores a night of sleep and HRV written by another app and accepts it, exactly as it would Samsung Health\'s', async () => {
    const theirs = today(await produce(history(25, OTHER, true).flatMap(d => d.samples))).recovery;
    const samsung = today(await produce(history(25, SAMSUNG, true).flatMap(d => d.samples))).recovery;
    expect(theirs).toMatchObject({ algorithm_version: 'recovery.v5', activation: 'accepted', hrv_method: 'rmssd' });
    expect(theirs.used.signals).toEqual(expect.arrayContaining(['sleep', 'hrv']));
    expect(theirs).toEqual(samsung);
  });

  it('writes sleep debt and the other pillars accepted too', async () => {
    const row = today(await produce(history(25, OTHER, true).flatMap(d => d.samples)));
    expect(row.sleep_debt.activation).toBe('accepted');
    expect(row.weight.activation).toBe('accepted');
  });

  // The phone sends one writer per kind and slot, and a window's id names its hour, not its writer, so a second writer's hour
  // replaces the first at ingest. The producer then keeps one reading per hour and one asleep reading per night: never a mean.
  it('keeps one reading when two apps wrote the same hour, never their mean', async () => {
    const base = history(25).flatMap(d => d.samples);
    const asleepHour = base.findIndex(y => y.signal === 'heart_rate_window' && y.day === TODAY && Date.parse(String(y.start_at)) === local(TODAY, 3));
    const hour = base[asleepHour]!;
    const LATER = 61;
    expect(LATER).not.toBe(hour.value);
    const rival: Sample = { ...hour, origin: origin(OTHER), value: LATER };
    const seen: (number | null)[] = [];
    const scores = dailyScoresFor('1');
    await produce([...base.slice(0, asleepHour + 1), rival, ...base.slice(asleepHour + 1)], input => {
      const bucket = input.days.find(d => d.day === TODAY)?.hourly.find(b => b.startAt === iso(local(TODAY, 3)));
      if (input.targetDay === TODAY && bucket) seen.push(bucket.heartRate);
      return scores(input);
    });
    expect(seen).toEqual([LATER]);
  });

  it('takes the night\'s sleep from the latest asleep reading when two apps wrote it, never their sum or mean', async () => {
    const base = history(25, SAMSUNG, true).flatMap(d => d.samples);
    const index = base.findIndex(y => y.signal === 'sleep_duration' && y.day === TODAY);
    const night = base[index]!;
    const run = async (samples: Sample[]) => today(await produce(samples)).recovery;
    const rival = { ...night, origin: origin(OTHER), value: 300, start_at: iso(Date.parse(String(night.start_at)) + 60_000) };
    const both = [...base, rival];
    const rivalOnly = base.map((x, i) => (i === index ? rival : x));
    expect(await run(both)).toEqual(await run(rivalOnly));
  });
});
