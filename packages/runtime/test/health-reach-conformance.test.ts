import { describe, expect, it, vi } from 'vitest';
import { HEALTH_SIGNALS, HEALTH_SIGNAL_NAMES, type HealthSignal } from '../../contracts/src/health/signals';
import { healthContextBook } from '../src/channels/health-context';
import { createOwnerResponder } from '../src/channels/owner-turn';
import type { RunEffectScope } from '../src/channels/run-effect-scope';
import { createOwnerTurnContext } from '../src/context-composer/owner-turn';
import { renderHealth } from '../src/context-composer/prompt';
import { ownerMessageAdmission } from '../src/identity/owner-message-admission';
import { ownerJobAdmission } from '../src/identity/surface-owner-admission';
import type { LLMGatewayAdapter } from '../src/llm/provider';
import { DAY_CARDS, dayPlanInput } from '../src/prompt/day-cards';
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
const materialOf = async (without: readonly string[] = []) => {
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
  if (material === 'unreadable' || material === null) throw new Error('the block was unreadable');
  return material;
};
const blockOf = async (without: readonly string[] = []): Promise<string> => renderHealth(await materialOf(without));

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

// The body read is one part of the situation every run is given, not a health-only block: the owner's own turn, the Brief, a
// wake and the day plan all compose it from the same read, beside the day's own context.
const readingLine = /Against your usual today: [^\n]*(?:above|below|later than|earlier than|within) usual/;
const expectBody = (text: string) => {
  expect(text).toMatch(readingLine);
  expect(text).toMatch(/Freshness: fresh\./);
  expect(text).toMatch(/Confidence: (?:high|medium|low)\./);
};
const scope = (): RunEffectScope => ({ runId: 'run-every', attempt: 'attempt-every', deadline: Date.now() + 15 * 60_000, signal: new AbortController().signal, admit: vi.fn(), commit: work => work() });
const OWNER = '10000000-0000-0000-0000-000000000001';
const bound = async () => ({ ownerId: OWNER, bindingRef: 'runtime:owner-demo', revision: '5', physicalDoId: 'actual-do' });
const CANARIES = ['0123456789abcdef', '1123456789abcdef', '2123456789abcdef'];
const composedWith = async (admission: Parameters<typeof createOwnerTurnContext>[0]) => {
  const context = createOwnerTurnContext(admission, { health: () => materialOf() });
  const composed = await context.composer.compose(context.invocation, { ...context.snapshot(), canary_tokens: CANARIES, replay_context_ref: null });
  if (!composed.ok) throw new Error(`the run did not compose: ${JSON.stringify(composed)}`);
  return composed.prompt;
};

describe('the body read sits in every run\'s situation', () => {
  it('in the owner\'s own turn', async () => {
    const admission = await ownerMessageAdmission({
      lookup: async () => ({ owner_id: OWNER, do_name: 'owner-demo', state_version: 0, admission_revision: '1', presence_id: '20000000-0000-0000-0000-000000000001', provider: 'telegram', subject: '1001' }),
      scope: scope(), locator: { environment: 'staging', namespace: 'owner-staging', doName: 'owner-demo', doId: 'actual-do' },
      actualDoId: 'actual-do', expectedDoId: (name: string) => name === 'owner-demo' ? 'actual-do' : 'other-do',
      allowedDoNames: ['owner-demo'], provider: 'telegram' as const, subject: '1001', text: 'Can I fit a run in before my 3pm?',
      occurrenceKey: 'every-run-chat', occurredAt: Date.now() - 1, now: Date.now,
    });
    expectBody(await composedWith(admission));
  });
  // The Brief, and the wakes: the heartbeat look, the patrol and the spot before an event.
  it.each(['brief', 'heartbeat', 'patrol', 'pre_activity_spot'] as const)('in a %s run', async (job) => {
    const admission = await ownerJobAdmission({ lookup: bound, expectedPhysicalDoId: 'actual-do', job, occurrenceKey: `${job}:every`, occurredAt: Date.now() - 1 });
    expectBody(await composedWith(admission));
  });
  it('in the day plan, which places the owner\'s cards around their day', async () => {
    const inputs: string[] = [];
    const gateway: LLMGatewayAdapter = { complete: async ({ request }) => {
      inputs.push(request.messages.map(message => String(message.content)).join('\n'));
      return { ok: true, data: { model: request.model, text: '{}', input_tokens: 1, output_tokens: 1, cache_read_input_tokens: 0, latency_ms: 0 } };
    } };
    const admission = await ownerJobAdmission({ lookup: bound, expectedPhysicalDoId: 'actual-do', job: 'heartbeat', occurrenceKey: 'plan:every', occurredAt: Date.now() - 1 });
    const args: Parameters<typeof createOwnerResponder> = ['fixture'];
    args[5] = []; args[7] = false; args[10] = gateway;
    args[17] = () => materialOf();
    args[21] = { jobHost: { admit: async () => admission, chain: (_admission, surfaceChain) => surfaceChain }, leanScheduled: true };
    await createOwnerResponder(...args).planDay('day-plan:every', dayPlanInput({ localNow: '2026-03-20T07:00', calendar: 'Board review 15:00-16:30.', cards: DAY_CARDS, proactivity: 'Quiet hours 23:00-07:00' }));
    expect(inputs).toHaveLength(1);
    expectBody(inputs[0]!);
    expect(inputs[0]!).toContain('Board review 15:00-16:30.');
  });
});
