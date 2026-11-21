import { describe, expect, it } from 'vitest';
import { HEALTH_SIGNALS, HEALTH_SIGNAL_NAMES, type HealthSignal } from '../../contracts/src/health/signals';
import { healthContextBook } from '../src/channels/health-context';
import { renderHealth } from '../src/context-composer/prompt';
import { EVERY_KIND_NOW, EVERY_KIND_SIGNALS, everyKindRows } from './support/health-every-kind';

// Every kind of body data Waldo stores reaches the model, or says here why not yet. A kind reaches when the model's standing health
// block names it, in the registry's own words, with which way today's reading stood against the owner's own usual. The path is
// the real one: a synthetic owner whose phone sends every kind, the producer writing the rows the database would hold, the signed
// reads answering with those rows, and the block the prompt is given. A new kind fails here until it is placed.
type Reach =
  | Readonly<{ block: 'reading'; owner?: 'without_movement' }>
  | Readonly<{ block: 'need' | 'day_load' }>
  | Readonly<{ notYet: string }>;
const REACH: Readonly<Record<HealthSignal, Reach>> = {
  sleep_duration: { block: 'need' },
  sleep_midpoint: { block: 'reading' },
  overnight_hrv: { block: 'reading' },
  resting_heart_rate: { block: 'reading' },
  daylight_duration: { block: 'reading' },
  movement_duration: { block: 'reading' },
  heart_rate_window: { block: 'reading' },
  respiratory_rate: { block: 'reading' },
  spo2: { block: 'reading' },
  wrist_temperature: { block: 'reading' },
  walking_heart_rate_average: { block: 'reading' },
  active_energy_window: { block: 'reading' },
  // Steps are banded only for an owner whose phone sends no movement minutes: with them, movement stands for motion.
  steps_window: { block: 'reading', owner: 'without_movement' },
  workout: { block: 'day_load' },
  heart_rate_bins_window: { block: 'day_load' },
  hrv_window: { notYet: 'it feeds the daytime stress part, which is named by its heart rate; a daytime HRV band of its own is HEY-494' },
  vo2_max: { notYet: 'no usual band is computed for it yet (HEY-494)' },
  sleep_efficiency: { notYet: 'no usual band or trend yet (HEY-494)' },
  heart_rate_recovery: { notYet: 'no usual band or trend yet (HEY-494)' },
  mindful_duration: { notYet: 'no usual band or trend yet (HEY-494)' },
  body_mass: { notYet: 'no usual band or trend yet (HEY-494)' },
  body_fat_percentage: { notYet: 'no usual band or trend yet (HEY-494)' },
  lean_body_mass: { notYet: 'no usual band or trend yet (HEY-494)' },
  stand_hour: { notYet: 'no usual band or trend yet (HEY-494)' },
  nutrition: { notYet: 'food logged has no usual to stand against; get_health reads it in the turn that asks' },
};

const clock = { timezone: 'UTC', now: () => new Date(EVERY_KIND_NOW) };
// The signed reads, answered from the rows the producer wrote, as the database would.
const blockOf = async (without: readonly string[] = []): Promise<string> => {
  const rows = await everyKindRows(without);
  const today = rows.at(-1)!;
  const compiledAt = new Date(EVERY_KIND_NOW - 600_000).toISOString();
  const call = async (fn: string) => {
    if (fn === 'health_context_read') {
      return { context: { id: 'ctx-every-kind', compiled_at: compiledAt, ...today }, previous: null };
    }
    if (fn === 'health_inventory_read') {
      return { sources: [{ source: 'apple', kinds: EVERY_KIND_SIGNALS.filter(signal => !without.includes(signal)).map(signal => ({ signal, newest_at: compiledAt, days: 25 })) }] };
    }
    if (fn === 'health_body_read') {
      const { day, components, usual, day_load, stress_curve, changes } = today;
      return { body: { day, components, usual, day_load, stress_curve, changes } };
    }
    throw new Error(`unexpected read ${fn}`);
  };
  const book = healthContextBook(call, 'owner-every-kind', clock, undefined, undefined, { partial: true, inventory: true, body: true } as never);
  const material = await book.latest();
  if (material === 'unreadable') throw new Error('the block was unreadable');
  return renderHealth(material);
};

const words = (signal: HealthSignal) => HEALTH_SIGNALS[signal].words;
const DIRECTION = '(?:far )?(?:above|below|later than|earlier than) usual|within usual';
const expectedIn = (signal: HealthSignal, reach: Reach): RegExp => {
  if ('notYet' in reach) throw new Error('a kind that is not yet placed has no expectation');
  if (reach.block === 'reading') return new RegExp(`${words(signal)}(?: so far today, against whole days)?: (?:${DIRECTION})`);
  if (reach.block === 'need') return new RegExp(`${words(signal)}: (?:met your need|about (?:one|two|three|four|five|six|seven|eight|nine) tenths? of your need)`);
  return /[Dd]ay load so far: (?:(?:far )?(?:above|below) your usual day|within your usual day)/;
};

describe('every stored kind reaches the model, or says why not yet', () => {
  it('places every kind of the registry', () => {
    expect(Object.keys(REACH).sort()).toEqual([...HEALTH_SIGNAL_NAMES].sort());
    for (const [signal, reach] of Object.entries(REACH)) {
      if ('notYet' in reach) expect(reach.notYet.length, signal).toBeGreaterThan(20);
    }
  });
  it('the synthetic owner sends every kind, so a kind placed in the block is tested on a real reading', () => {
    expect([...EVERY_KIND_SIGNALS].sort()).toEqual([...HEALTH_SIGNAL_NAMES].sort());
  });
  it('names each kind placed in the block with which way it stood against the owner\'s usual', async () => {
    const block = await blockOf();
    const missing = Object.entries(REACH).flatMap(([signal, reach]) =>
      'notYet' in reach || ('owner' in reach && reach.owner) ? [] : expectedIn(signal as HealthSignal, reach).test(block) ? [] : [signal]);
    expect(missing, block).toEqual([]);
  });
  it('names steps against their usual for an owner whose phone sends no movement minutes', async () => {
    const block = await blockOf(['movement_duration']);
    expect(block).toMatch(expectedIn('steps_window', REACH.steps_window));
  });
  it('gives the model no figure for any of it', async () => {
    const block = await blockOf();
    // Clock times are the one shape a digit may take in the block; nothing else of the body carries one.
    expect(block.replace(/\b(?:[01]\d|2[0-3]):[0-5]\d\b/g, '')).not.toMatch(/\d/);
  });
});
