import { describe, expect, it } from 'vitest';
import { derivedHealthDestinationViewSchema } from '@waldo/contracts';
import { healthContextBook, toContextHealthMaterial, type HealthContextRow } from '../src/channels/health-context';
import { renderHealth } from '../src/context-composer/prompt';
import { produceHealthScores } from '../src/health/producer';
import { dailyScoresFor } from '../src/health/scores';
import { scrubTraceHealth } from '../src/observability/trace-health-scrub';

// The partial health block, read from rows the real producer writes for owners whose body data cannot make a Recovery score.
// Every value is synthetic: a Galaxy Watch-like owner on Health Connect in Kolkata, read at noon local time.
const TZ = 'Asia/Kolkata', OFFSET = 330, HOUR = 3_600_000;
const TODAY = '2026-11-01';
const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const local = (day: string, hour: number, minute = 0) => Date.parse(`${day}T00:00:00Z`) + hour * HOUR + minute * 60_000 - OFFSET * 60_000;
const iso = (ms: number) => new Date(ms).toISOString();
const wobble = (i: number, span: number) => ((i * 7919) % (2 * span + 1)) - span;
const NOW = local(TODAY, 12);
const clock = { timezone: TZ, now: () => new Date(NOW) };

type Kinds = Readonly<{ sleep?: boolean; hrv?: boolean; heart?: boolean; steps?: boolean; calendar?: boolean }>;
type Sample = Record<string, unknown>;
// A reading as the series read returns it: no origin, marked as Samsung Health's.
const reading = (signal: string, day: string, from: number, to: number, extra: Sample): Sample =>
  ({ signal, day, start_at: iso(from), end_at: iso(to), utc_offset_minutes: OFFSET, timezone: TZ, samsung_writer: true, ...extra });
const dayOf = (day: string, i: number, lastHour: number, kinds: Kinds): Sample[] => {
  const from = local(addDays(day, -1), 23), to = local(day, 6, 30);
  const hours = Array.from({ length: lastHour + 1 }, (_, h) => h);
  return [
    ...(kinds.sleep ? [
      reading('sleep_duration', day, from, to, { method: 'asleep_duration', value: 435 + wobble(i, 20) }),
      reading('sleep_midpoint', day, from, to, { method: 'sleep_midpoint', value: 165 + wobble(i, 12) }),
    ] : []),
    ...(kinds.hrv ? [reading('overnight_hrv', day, from, to, { method: 'rmssd', value: 42 + wobble(i, 6) })] : []),
    ...(kinds.heart ? hours.map(h => reading('heart_rate_window', day, local(day, h), local(day, h) + HOUR, { value: h < 7 || h === 23 ? 53 + wobble(h + i, 3) : 76 + wobble(h + i, 4) })) : []),
    ...(kinds.steps ? hours.filter(h => h >= 7 && h <= 21).map(h => reading('steps_window', day, local(day, h), local(day, h) + HOUR, { value: 400 + wobble(h + i, 150) })) : []),
  ];
};

// Today's row as the producer writes it, then as waldo.health_context_read returns it: the stored keys, the row id, its
// compile time (updated_at) and the consent basis it was computed under.
const storedRow = async (kinds: Kinds, nights = 20): Promise<Record<string, unknown>> => {
  const samples = Array.from({ length: nights }, (_, i) => dayOf(addDays(TODAY, -i), i, i === 0 ? 11 : 23, kinds)).flat();
  const written: Record<string, unknown>[] = [];
  await produceHealthScores({
    readSeries: async (range: { signals: readonly string[] }) => ({ access: 'granted', read_at: iso(NOW).replace('Z', '000Z'), sources: [{ source: 'health_connect', consent_epoch: 1, truncated: false, samples: samples.filter(s => range.signals.includes(String(s.signal))) }] }),
    writeContext: async (payload: string) => { written.push(JSON.parse(payload)); return { written: true }; },
    compute: dailyScoresFor('1'),
    readDemand: async () => (kinds.calendar
      ? { state: 'available', days: Array.from({ length: 31 }, (_, i) => ({ day: addDays(TODAY, -i), busy_minutes: 240 + wobble(i, 40), partial: false })) }
      : { state: 'unavailable' }),
  } as never, { now: NOW, timezone: TZ });
  const today = written.find(r => r.day === TODAY);
  if (!today) throw new Error('the producer wrote no row for today');
  return today;
};
const asRead = (stored: Record<string, unknown>, compiledAt = iso(NOW - HOUR)): HealthContextRow => {
  const { timezone: _tz, read_at: _readAt, ...kept } = stored;
  return { context: { ...kept, id: 'ctx-partial', compiled_at: compiledAt } as never, previous: null };
};
const read = (row: HealthContextRow, partial = true) => toContextHealthMaterial(row, clock, undefined, { partial });
const viewOf = (row: HealthContextRow) => read(row)!.view as Record<string, unknown>;

describe('a partial health block from the rows the producer writes', () => {
  it('steps only: says no sleep arrived, what would fix it, and points to get_health, with no zone and no number', async () => {
    const row = asRead(await storedRow({ steps: true }));
    const material = read(row);
    expect(material).not.toBeNull();
    expect(material!.view).toMatchObject({
      availability: 'partial', freshness: 'fresh', as_of_day: 'today', sources: ['health_connect'], present: [],
      missing_pillars: { recovery: 'missing_sleep', form: 'missing_sleep', load: 'calendar_demand_unavailable', sleep_debt: 'missing_sleep' },
    });
    expect(derivedHealthDestinationViewSchema.safeParse(material!.view).success).toBe(true);
    const block = renderHealth(material);
    expect(block.startsWith('Partial health context:')).toBe(true);
    expect(block).toContain('Health Connect');
    expect(block).toContain('no sleep was recorded for the night');
    expect(block).toContain('Would fix it: wearing the watch or ring overnight');
    expect(block).toContain('get_health');
    expect(block).not.toMatch(/Recovery zone|Form zone|Recovery: |readiness is|\d/);
    // The row records what is missing, never that steps arrived; the block does not claim it.
    expect(block).not.toMatch(/Present:.*steps/);
  });

  it('sleep plus steps: names last night\'s sleep and the sleep debt, and that no overnight heart signal arrived', async () => {
    const row = asRead(await storedRow({ sleep: true, steps: true }));
    const view = viewOf(row);
    expect(view).toMatchObject({ present: ['last_night_sleep', 'recent_sleep'], missing_pillars: { recovery: 'missing_resting_signal', form: 'missing_resting_signal', load: 'calendar_demand_unavailable' } });
    expect(view['missing_pillars']).not.toHaveProperty('sleep_debt');
    expect(view['sleep_debt']).toMatchObject({ amount: expect.any(String) });
    const block = renderHealth(read(row));
    expect(block).toContain("In the row: last night's sleep; sleep across recent nights.");
    expect(block).toContain('Sleep debt:');
    expect(block).toContain('no overnight heart rate or heart rate variability');
    expect(block).not.toMatch(/Recovery zone|Form zone/);
  });

  it('heart plus steps: the stored row cannot tell it from steps only, so the block says no more than steps only does', async () => {
    const [heart, steps] = [await storedRow({ heart: true, steps: true }), await storedRow({ steps: true })];
    expect(heart).toEqual(steps);
    expect(renderHealth(read(asRead(heart)))).toBe(renderHealth(read(asRead(steps))));
  });

  it('heart plus steps with a calendar: Load is honest on its own and is carried in words', async () => {
    const row = asRead(await storedRow({ heart: true, steps: true, calendar: true }));
    const view = viewOf(row);
    expect(view).toMatchObject({ present: ['calendar'], load_zone: expect.any(String), missing_pillars: { recovery: 'missing_sleep', form: 'missing_sleep' } });
    expect(view['missing_pillars']).not.toHaveProperty('load');
    const block = renderHealth(read(row));
    expect(block).toContain(`Load: ${String(view['load_zone'])}.`);
    expect(block).not.toMatch(/Recovery zone|Form zone/);
  });

  it('nothing at all: no row is no block, read as absent', async () => {
    expect(read({ context: null, previous: null })).toBeNull();
    const seen: unknown[][] = [];
    const book = healthContextBook(async () => ({ context: null, previous: null }), 'do-health', clock, undefined, (...args) => seen.push(args), { partial: true });
    expect(await book.latest('t')).toBeNull();
    expect(seen).toEqual([[false, 't', false]]);
    expect(renderHealth(null)).toBe('No derived health context is available for this invocation.');
  });

  it('consent withdrawn or never given: no block, even with the switch on and readings on the row', async () => {
    const stored = await storedRow({ sleep: true, steps: true });
    for (const reason of ['consent_withdrawn', 'consent_required', 'not_linked']) {
      const unavailable = { reason };
      const row = asRead({ ...stored, recovery: unavailable, form: unavailable, weight: unavailable, sleep_debt: { state: 'unavailable', reason } });
      expect(read(row), reason).toBeNull();
    }
    // A Load or sleep debt beside a withdrawn Recovery is still no block.
    expect(read(asRead({ ...stored, recovery: { reason: 'consent_withdrawn' } }))).toBeNull();
    // The read RPC returns no context when the consent basis is not live.
    expect(await healthContextBook(async () => null, 'do-health', clock, undefined, undefined, { partial: true }).latest()).toBeNull();
  });

  it('a row older than three days: no zone, no pillar and no reason from that day, only that the newest data is old', async () => {
    const full = await storedRow({ sleep: true, heart: true, steps: true });
    expect(full['recovery']).toHaveProperty('zone');
    const old = asRead({ ...full, day: addDays(TODAY, -4) }, iso(NOW - 73 * HOUR));
    expect(read(old, false)).toBeNull();
    const material = read(old);
    expect(material!.view).toEqual({
      authority: 'backend', availability: 'partial', freshness: 'expired', as_of_day: 'earlier', sources: ['health_connect'], present: [], missing_pillars: {},
      provenance_refs: [expect.stringMatching(/^hpr_/)], destination_eligibility: ['trigger_prompt'],
    });
    const block = renderHealth(material);
    expect(block).toContain('more than three days old');
    expect(block).toContain('get_health');
    expect(block).not.toMatch(/Recovery zone|Form zone|Load: |\d/);
  });

  it('a full row: the block is the same with the switch on as off', async () => {
    const stored = await storedRow({ sleep: true, hrv: true, heart: true, steps: true, calendar: true });
    expect(stored).toMatchObject({ recovery: { zone: expect.any(String) }, form: { zone: expect.any(String) }, weight: { zone: expect.any(String) } });
    expect(stored['sleep_debt']).not.toHaveProperty('reason');
    const full = asRead(stored);
    const on = read(full), off = read(full, false);
    expect(off).not.toBeNull();
    expect(on).toEqual(off);
    expect(renderHealth(on)).toBe(renderHealth(off));
    expect(renderHealth(off).startsWith('Form zone:')).toBe(true);
  });

  it('a full row without overnight HRV: the switch changes exactly one line, naming HRV as missing', async () => {
    const stored = await storedRow({ sleep: true, heart: true, steps: true, calendar: true });
    expect(stored).toMatchObject({ recovery: { zone: expect.any(String) }, form: { zone: expect.any(String) }, weight: { zone: expect.any(String) } });
    const [on, off] = [renderHealth(read(asRead(stored))).split('\n'), renderHealth(read(asRead(stored), false)).split('\n')];
    expect(on.length).toBe(off.length);
    const changed = on.flatMap((line, i) => (line === off[i] ? [] : [[off[i], line]]));
    expect(changed).toEqual([[expect.stringMatching(/Missing components: none\.$/), expect.stringMatching(/Missing components: hrv\.$/)]]);
  });

  it('the switch off keeps today\'s behaviour: a row without Recovery is no block', async () => {
    for (const kinds of [{ steps: true }, { sleep: true, steps: true }, { heart: true, steps: true }]) {
      expect(read(asRead(await storedRow(kinds)), false), JSON.stringify(kinds)).toBeNull();
    }
  });

  it('logs a partial block as present and partial, so the absent rate on staging can falsify the design', async () => {
    const stored = await storedRow({ steps: true });
    const seen: unknown[][] = [];
    const book = healthContextBook(async () => asRead(stored), 'do-health', clock, undefined, (...args) => seen.push(args), { partial: true });
    expect(await book.latest('t')).not.toBeNull();
    expect(seen).toEqual([[true, 't', true]]);
  });
});

describe('the missing list is true for each case', () => {
  const cases: readonly [string, Kinds, Record<string, string>][] = [
    ['steps only', { steps: true }, { recovery: 'missing_sleep', form: 'missing_sleep', load: 'calendar_demand_unavailable', sleep_debt: 'missing_sleep' }],
    ['sleep plus steps', { sleep: true, steps: true }, { recovery: 'missing_resting_signal', form: 'missing_resting_signal', load: 'calendar_demand_unavailable' }],
    ['heart plus steps', { heart: true, steps: true }, { recovery: 'missing_sleep', form: 'missing_sleep', load: 'calendar_demand_unavailable', sleep_debt: 'missing_sleep' }],
    ['heart, steps and a calendar', { heart: true, steps: true, calendar: true }, { recovery: 'missing_sleep', form: 'missing_sleep', sleep_debt: 'missing_sleep' }],
  ];
  for (const [name, kinds, expected] of cases) {
    it(`${name}: each missing pillar is one the stored row could not compute, with the reason it stored`, async () => {
      const stored = await storedRow(kinds);
      const view = viewOf(asRead(stored));
      expect(view['missing_pillars']).toEqual(expected);
      const storedReason = (pillar: unknown) => (pillar as { reason?: string }).reason;
      const truth = Object.fromEntries(([['recovery', stored['recovery']], ['form', stored['form']], ['load', stored['weight']], ['sleep_debt', stored['sleep_debt']]] as const)
        .flatMap(([pillar, value]) => storedReason(value) === undefined ? [] : [[pillar, storedReason(value)]]));
      expect(view['missing_pillars']).toEqual(truth);
    });
  }

  it('a Recovery view names a missing HRV only when the row says which signals it used', async () => {
    const stored = await storedRow({ sleep: true, heart: true, steps: true });
    const material = read(asRead({ ...stored, form: { reason: 'stale_inputs' } }))!;
    expect(material.view).toMatchObject({ recovery_zone: expect.any(String), missing_components: ['hrv'], missing_pillars: { form: 'stale_inputs', load: 'calendar_demand_unavailable' } });
    const block = renderHealth(material);
    expect(block).toContain('Missing components: hrv.');
    expect(block).toContain('Not computed: Form (');
    // Without the switch the earlier block stands.
    expect(read(asRead({ ...stored, form: { reason: 'stale_inputs' } }), false)!.view).toMatchObject({ missing_components: [] });
  });
});

describe('a partial block in a trace', () => {
  it('is withheld whole by the health scrub', async () => {
    const block = renderHealth(read(asRead(await storedRow({ sleep: true, steps: true }))));
    const input = JSON.stringify([{ role: 'system', content: `Before.\n\n${block}\n\nAfter.` }]);
    const scrubbed = JSON.stringify(scrubTraceHealth({ trace: 't', hop: 'llm_reply', ms: 1, ok: true, text: { input, output: '' } }).text);
    expect(scrubbed).not.toContain('Partial health context');
    expect(scrubbed).not.toContain('Sleep debt');
    expect(scrubbed).toContain('Before.');
  });
});
