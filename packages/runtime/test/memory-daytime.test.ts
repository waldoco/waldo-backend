import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { NIGHTLY_SOURCES_THROUGH_KEY, type SourcesDeps } from '../src/channels/nightly-sources';
import { updateBook, type Change } from '../src/channels/update-cards';
import type { ObservedEvent } from '../src/channels/update-sweep';
import { claimStore } from '../src/memory/claims';
import { DAYTIME_CALLS_PER_DAY, DAYTIME_GAP_MS, daytimeMemory, MEMORY_DAYTIME_ID } from '../src/memory/consolidator';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

// The daytime consolidator: a hint from the update sweep arms one pass, and the pass reads the recorded mail and calendar
// changes through the nightly source pass, one model call at a time, at most six in any 24 hours. Synthetic fixtures only.
const NOON = Date.parse('2026-10-31T12:00:00Z');
const HOUR = 3_600_000;
const meeting: Change = { source: 'calendar', kind: 'added', detail: JSON.stringify({ id: 'evt_1', summary: 'Design review', recurrence: 'a weekly design review on Thursdays' }), ref: 'event:evt_1' };
const hint = (kind: ObservedEvent['kind'], at = NOON): ObservedEvent => ({ kind, refs: ['update:1'], taint: 'external', at, localDay: '2026-10-31' });
const addOne = (text: string) => JSON.stringify({ add: [{ kind: 'fact', text, source: 'inferred', evidence: 'a weekly design review', touches_forgotten: false, aliases: [], aliases_touch_forgotten: false }] });

let sequence = 0;
type World = Readonly<{
  state: DurableObjectState; scheduler: Scheduler; clock: { at: number; zone: string }; flags: { on: boolean; capped: boolean };
  asked: string[]; fail: { on: boolean }; daytime: ReturnType<typeof daytimeMemory>;
}>;
const inOwner = (work: (world: World) => Promise<void>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`memory-daytime-${sequence++}`)), async (_instance, state) => {
    ensureSchema(state.storage);
    const clock = { at: NOON, zone: 'UTC' }, flags = { on: true, capped: false }, asked: string[] = [], fail = { on: false };
    const scheduler = new Scheduler(state.storage.sql, state.storage, { ...productionDeps(), now: () => clock.at });
    const sources = (): SourcesDeps => ({
      kv: state.storage.kv, updates: updateBook(state.storage.sql), claims: claimStore(state.storage.sql, (fn) => state.storage.transactionSync(fn)),
      transaction: (fn) => state.storage.transactionSync(fn), timezone: clock.zone, now: () => clock.at, health: true, log: () => undefined,
      ask: async (text) => { asked.push(text); if (fail.on) throw new Error('synthetic provider outage'); return addOne(`Has a weekly design review ${asked.length}`); },
    });
    const daytime = daytimeMemory({ kv: state.storage.kv, scheduler, now: () => clock.at, enabled: () => flags.on, capped: () => flags.capped, sources });
    try { await work({ state, scheduler, clock, flags, asked, fail, daytime }); } finally { await state.storage.deleteAlarm(); }
  });
const armed = (scheduler: Scheduler) => { const found = scheduler.lookup(MEMORY_DAYTIME_ID); return found.state === 'entry' ? found.entry.due_at : null; };
const record = (state: DurableObjectState, at: number) => updateBook(state.storage.sql).record('2026-10-31', at, [meeting], null);
const pass = (world: World) => world.daytime.run({ id: MEMORY_DAYTIME_ID, occurrence_at: world.clock.at });

describe('the hint', () => {
  it('arms one pass for a mail or calendar change, and only schedules: no read of the changes and no model call', async () => {
    await inOwner(async ({ scheduler, asked, daytime, state }) => {
      record(state, NOON - HOUR);
      await daytime.observed(hint('mail'));
      expect(armed(scheduler)).toBe(NOON);
      expect(asked).toEqual([]);
      expect(state.storage.kv.get(NIGHTLY_SOURCES_THROUGH_KEY)).toBeUndefined();
    });
  });

  it('leaves an armed pass where it is, so hints every few minutes cannot keep pushing it later', async () => {
    await inOwner(async (world) => {
      await world.daytime.observed(hint('mail'));
      expect(armed(world.scheduler)).toBe(NOON);
      for (const minutes of [5, 10]) {
        world.clock.at = NOON + minutes * 60_000;
        await world.daytime.observed(hint('calendar', world.clock.at));
        expect(armed(world.scheduler)).toBe(NOON);
      }
    });
  });

  it('arms a pass no sooner than fifteen minutes after the last one', async () => {
    await inOwner(async (world) => {
      record(world.state, NOON - HOUR);
      await pass(world);
      world.clock.at = NOON + 60_000;
      await world.daytime.observed(hint('mail', world.clock.at));
      expect(armed(world.scheduler)).toBe(NOON + DAYTIME_GAP_MS);
    });
  });

  it('arms nothing for chat, health or a connector, while switched off, or once the day\'s calls are spent', async () => {
    await inOwner(async (world) => {
      for (const kind of ['chat', 'health', 'connector'] as const) await world.daytime.observed(hint(kind));
      expect(armed(world.scheduler)).toBeNull();
      world.flags.on = false;
      await world.daytime.observed(hint('mail'));
      expect(armed(world.scheduler)).toBeNull();
      world.flags.on = true;
      for (let call = 0; call < DAYTIME_CALLS_PER_DAY; call += 1) { record(world.state, world.clock.at - 1); await pass(world); world.clock.at += DAYTIME_GAP_MS; }
      await world.daytime.observed(hint('mail', world.clock.at));
      expect(armed(world.scheduler)).toBeNull();
    });
  });
});

describe('the pass', () => {
  it('reads the recorded changes in one call and writes only untrusted claims', async () => {
    await inOwner(async (world) => {
      record(world.state, NOON - HOUR);
      expect(await pass(world)).toBe('consolidated');
      expect(world.asked).toHaveLength(1);
      expect(world.asked[0]).toContain('Design review');
      expect(claimStore(world.state.storage.sql).claims().map((claim) => [claim.text, claim.origin])).toEqual([['Has a weekly design review 1', 'untrusted']]);
    });
  });

  it('checks again when it runs: switched off or at the spend cap, it makes no call', async () => {
    await inOwner(async (world) => {
      record(world.state, NOON - HOUR);
      world.flags.on = false;
      expect(await pass(world)).toBe('off');
      world.flags.on = true; world.flags.capped = true;
      expect(await pass(world)).toBe('spend_capped');
      expect(world.asked).toEqual([]);
    });
  });

  it('makes at most six model calls in 24 hours; an empty pass costs none, and a failed one still counts', async () => {
    await inOwner(async (world) => {
      expect(await pass(world)).toBe('empty');
      world.fail.on = true;
      record(world.state, world.clock.at - 1);
      expect(await pass(world)).toBe('failed');
      world.fail.on = false;
      for (let call = 1; call < DAYTIME_CALLS_PER_DAY; call += 1) { world.clock.at += DAYTIME_GAP_MS; record(world.state, world.clock.at - 1); expect(await pass(world)).toBe('consolidated'); }
      world.clock.at += DAYTIME_GAP_MS; record(world.state, world.clock.at - 1);
      expect(await pass(world)).toBe('day_spent');
      expect(world.asked).toHaveLength(DAYTIME_CALLS_PER_DAY);
    });
  });

  // The window rolls by the clock, not the owner's date: a zone that flips back and forth at every pass gets no fresh count.
  it('makes at most six calls in any 24 hours, however often the owner\'s zone changes', async () => {
    await inOwner(async (world) => {
      world.clock.at = Date.parse('2026-10-31T20:00:00Z');
      const first = world.clock.at;
      for (let turn = 0; turn < 24; turn += 1) {
        world.clock.zone = turn % 2 ? 'Asia/Kolkata' : 'UTC';
        record(world.state, world.clock.at - 1);
        await pass(world);
        world.clock.at += DAYTIME_GAP_MS;
      }
      expect(world.asked).toHaveLength(DAYTIME_CALLS_PER_DAY);
      record(world.state, world.clock.at - 1);
      expect(await pass(world)).toBe('day_spent');
      world.clock.at = first + 24 * HOUR + 1;
      expect(await pass(world)).toBe('consolidated');
      expect(world.asked).toHaveLength(DAYTIME_CALLS_PER_DAY + 1);
    });
  });

  it('makes one call a pass however much is waiting, and never more than the 24 hours have left', async () => {
    await inOwner(async (world) => {
      const long = (n: number): Change => ({ ...meeting, detail: JSON.stringify({ id: `evt_${n}`, summary: `Design review ${n}`, notes: 'x'.repeat(30_000) }), ref: `event:evt_${n}` });
      updateBook(world.state.storage.sql).record('2026-10-31', NOON - 2, [long(1)], null);
      updateBook(world.state.storage.sql).record('2026-10-31', NOON - 1, [long(2)], null);
      expect(await pass(world)).toBe('more');
      expect(world.asked).toHaveLength(1);
      for (let call = 1; call < DAYTIME_CALLS_PER_DAY - 1; call += 1) { world.clock.at += DAYTIME_GAP_MS; record(world.state, world.clock.at - 1); await pass(world); }
      expect(world.asked).toHaveLength(DAYTIME_CALLS_PER_DAY - 1);
      world.clock.at += DAYTIME_GAP_MS;
      updateBook(world.state.storage.sql).record('2026-10-31', world.clock.at - 2, [long(3)], null);
      updateBook(world.state.storage.sql).record('2026-10-31', world.clock.at - 1, [long(4)], null);
      expect(await pass(world)).toBe('more');
      expect(world.asked).toHaveLength(DAYTIME_CALLS_PER_DAY);
    });
  });

  it('records a run only when it asked the model or failed, so passes that found nothing new leave no record', async () => {
    await inOwner(async (world) => {
      const recorded: string[][] = [];
      let started = 0;
      const runs = { start: (kind: string, parent: string | null) => { recorded.push([kind, String(parent)]); return { id: `bg:${started += 1}` } as never; },
        finish: (id: string, status: string, summary: string) => { recorded.push([id, status, summary]); return true; } };
      const sources = () => ({ kv: world.state.storage.kv, updates: updateBook(world.state.storage.sql), claims: claimStore(world.state.storage.sql, (fn) => world.state.storage.transactionSync(fn)),
        transaction: <R>(fn: () => R) => world.state.storage.transactionSync(fn), timezone: 'UTC', now: () => world.clock.at, health: true, log: () => undefined,
        ask: async () => { if (world.fail.on) throw new Error('synthetic provider outage'); return addOne('Has a weekly design review'); } });
      const recording = daytimeMemory({ kv: world.state.storage.kv, scheduler: world.scheduler, now: () => world.clock.at, enabled: () => true, capped: () => false, sources, runs });
      expect(await recording.run({ id: MEMORY_DAYTIME_ID, occurrence_at: NOON })).toBe('empty');
      expect(recorded).toEqual([]);
      record(world.state, NOON - 1);
      expect(await recording.run({ id: MEMORY_DAYTIME_ID, occurrence_at: NOON })).toBe('consolidated');
      world.fail.on = true; world.clock.at += DAYTIME_GAP_MS; record(world.state, world.clock.at - 1);
      expect(await recording.run({ id: MEMORY_DAYTIME_ID, occurrence_at: world.clock.at })).toBe('failed');
      expect(recorded).toEqual([
        ['memory_daytime', MEMORY_DAYTIME_ID], ['bg:1', 'completed', 'read the new mail and calendar changes'],
        ['memory_daytime', MEMORY_DAYTIME_ID], ['bg:2', 'failed', 'daytime memory pass did not finish; the changes wait'],
      ]);
    });
  });

  it('never throws, so the scheduler never retries it and no failure notice goes out', async () => {
    await inOwner(async (world) => {
      record(world.state, NOON - HOUR);
      const broken = daytimeMemory({ kv: world.state.storage.kv, scheduler: world.scheduler, now: () => world.clock.at, enabled: () => true, capped: () => false,
        sources: () => { throw new Error('synthetic setup failure'); } });
      expect(await broken.run({ id: MEMORY_DAYTIME_ID, occurrence_at: NOON })).toBe('failed');
    });
  });
});
