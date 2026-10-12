import { manualAlarmStorage } from './helpers/manual-alarm-storage';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SCHEDULE_KINDS } from '@waldo/contracts';
import { applySchedulePreferences, gateScheduleExecutors, reconcileSchedulePreferences, schedulePreferenceHandlers, schedulePreferences, schedulePreferencesLine } from '../src/channels/schedule-preferences';
import { dayPlanBook } from '../src/channels/day-cards';
import { loopBook } from '../src/channels/loops';
import { HEARTBEAT_ID } from '../src/channels/heartbeat';
import { NIGHTLY_ID } from '../src/channels/episodes';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { DAY_CARDS } from '../src/prompt/day-cards';
import { Scheduler } from '../src/scheduler/multiplexer';
import { ensureSchema } from '../src/tracer/schema';
import type { Deps } from '../src/seams/deps';
import type { ScheduleExecutors } from '../src/scheduler/multiplexer';

let sequence = 0;
const NOW = Date.parse('2026-10-07T02:00:00Z');
const TZ = 'Asia/Kolkata';
const deps = (): Deps => ({ now: () => NOW, newRunId: () => 'run-fixed', newOutboxId: () => 'out-fixed', sha256Hex: async () => 'sha-fixed' });
const withOwner = <T>(work: (ctx: ReturnType<typeof build>) => Promise<T>) =>
  runInDurableObject(env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName(`sched-prefs-${sequence++}`)), async (_i, state) => {
    ensureSchema(state.storage);
    return work(build(state));
  });
const build = (state: DurableObjectState) => {
  const sql = state.storage.sql;
  const scheduler = new Scheduler(sql, manualAlarmStorage(state.storage), deps());
  const loops = loopBook(sql, { newId: () => 'l1', now: () => NOW });
  const prefs = schedulePreferences(sql, loops);
  const plans = dayPlanBook(sql);
  const ctx = { scheduler, plans, timezone: TZ, now: NOW };
  const [tool] = schedulePreferenceHandlers(prefs, () => ctx);
  const call = (args: unknown) => (tool!.handle as (input: unknown) => Promise<unknown>)(tool!.schema.parse(args));
  const ids = () => [NIGHTLY_ID, HEARTBEAT_ID, BRIEF_SWEEP_ID, ...DAY_CARDS.map((card) => card.id)].filter((id) => scheduler.read(id) !== null);
  return { scheduler, loops, prefs, ctx, call, ids };
};

describe('schedule preferences', () => {
  it('defaults everything on and arms every out-of-the-box entry', async () => {
    await withOwner(async ({ prefs, ctx, ids }) => {
      expect(Object.values(prefs.all()).every(Boolean)).toBe(true);
      expect(Object.keys(prefs.all())).toEqual([...SCHEDULE_KINDS]);
      await applySchedulePreferences(prefs.all(), ctx);
      expect(ids().sort()).toEqual([NIGHTLY_ID, HEARTBEAT_ID, BRIEF_SWEEP_ID, ...DAY_CARDS.map((card) => card.id)].sort());
    });
  });

  it('turning each kind off cancels only its entries and shows in the ledger line', async () => {
    await withOwner(async ({ prefs, ctx, call, ids }) => {
      await applySchedulePreferences(prefs.all(), ctx);
      await call({ action: 'off', kind: 'heartbeat' });
      expect(ids()).not.toContain(HEARTBEAT_ID);
      expect(ids()).toContain(NIGHTLY_ID);
      await call({ action: 'off', kind: 'daily_brief' });
      expect(ids().some((id) => id.startsWith('card:'))).toBe(false);
      await call({ action: 'off', kind: 'event_briefs' });
      await call({ action: 'off', kind: 'nightly' });
      expect(ids()).toEqual([]);
      const line = schedulePreferencesLine(prefs.all());
      expect(line).toContain('heartbeat (periodic open-loop check) off');
      expect(line).toContain('followups (mail and calendar follow-ups) on');
    });
  });

  it('followups share the proactivity setting, so both views agree', async () => {
    await withOwner(async ({ prefs, loops, call }) => {
      await call({ action: 'off', kind: 'followups' });
      expect(loops.proactivity().followups).toBe(false);
      expect(prefs.all().followups).toBe(false);
      loops.setProactivity({ ...loops.proactivity(), followups: true });
      expect(prefs.all().followups).toBe(true);
    });
  });

  it('on re-arms, and reset restores every default including followups', async () => {
    await withOwner(async ({ prefs, ctx, call, ids }) => {
      for (const kind of SCHEDULE_KINDS) await call({ action: 'off', kind });
      expect(ids()).toEqual([]);
      await call({ action: 'on', kind: 'nightly' });
      expect(ids()).toEqual([NIGHTLY_ID]);
      await call({ action: 'reset' });
      expect(Object.values(prefs.all()).every(Boolean)).toBe(true);
      expect(ids().length).toBe(3 + DAY_CARDS.length);
      await applySchedulePreferences(prefs.all(), ctx);
      expect(ids().length).toBe(3 + DAY_CARDS.length);
    });
  });

  it('on and off need a kind', async () => {
    await withOwner(async ({ call }) => {
      expect(await call({ action: 'off' })).toMatchObject({ ok: false, code: 'invalid_args' });
    });
  });
});

describe('schedule preferences survive an interrupt between the save and the cancel', () => {
  const KIND_CASES = [
    { kind: 'daily_brief', id: DAY_CARDS[1]!.id, sched: 'brief', recurrence: null },
    { kind: 'nightly', id: NIGHTLY_ID, sched: 'dreaming', recurrence: { type: 'interval', every_ms: 86_400_000, phase_ms: 0 } },
    { kind: 'heartbeat', id: HEARTBEAT_ID, sched: 'heartbeat', recurrence: { type: 'interval', every_ms: 1_800_000, phase_ms: 0 } },
    { kind: 'event_briefs', id: BRIEF_SWEEP_ID, sched: 'pre_activity_spot', recurrence: { type: 'interval', every_ms: 600_000, phase_ms: 0 } },
  ] as const;
  for (const c of KIND_CASES) {
    it(`does not run a due ${c.kind} entry that the owner already turned off, and clears it`, async () => {
      await withOwner(async ({ scheduler, prefs }) => {
        // The preference was saved, the process stopped before the cancel: the entry is still armed and due.
        prefs.set(c.kind, false);
        await scheduler.schedule({ id: c.id, kind: c.sched, payloadRefs: { id: c.id }, occurrenceAt: NOW, dueAt: NOW, recurrence: c.recurrence } as never);
        const ran: string[] = [];
        const spy = async (entry: { id: string }) => { ran.push(entry.id); };
        const executors = gateScheduleExecutors({ [c.sched]: spy } as ScheduleExecutors, prefs, scheduler);
        await scheduler.dispatchDue(executors);
        expect(ran).toEqual([]);
        expect(scheduler.read(c.id)).toBeNull();
      });
    });
    it(`still runs a due ${c.kind} entry while it is on`, async () => {
      await withOwner(async ({ scheduler, prefs }) => {
        await scheduler.schedule({ id: c.id, kind: c.sched, payloadRefs: { id: c.id }, occurrenceAt: NOW, dueAt: NOW, recurrence: c.recurrence } as never);
        const ran: string[] = [];
        await scheduler.dispatchDue(gateScheduleExecutors({ [c.sched]: async (entry: { id: string }) => { ran.push(entry.id); } } as ScheduleExecutors, prefs, scheduler));
        expect(ran).toEqual([c.id]);
      });
    });
  }

  it('startup reconcile cancels every entry of a kind that is off and arms nothing it should not', async () => {
    await withOwner(async ({ scheduler, prefs, ctx, ids }) => {
      await applySchedulePreferences(prefs.all(), ctx);
      prefs.set('daily_brief', false);
      prefs.set('heartbeat', false);
      await reconcileSchedulePreferences(prefs.all(), ctx);
      expect(ids().some((id) => id.startsWith('card:'))).toBe(false);
      expect(ids()).not.toContain(HEARTBEAT_ID);
      expect(ids()).toContain(NIGHTLY_ID);
      expect(scheduler.read(BRIEF_SWEEP_ID)).not.toBeNull();
    });
  });

  it('a save that fails to apply is retried by the same tool call, preferences stay as saved', async () => {
    await withOwner(async ({ prefs, ctx }) => {
      prefs.set('nightly', false);
      expect(prefs.all().nightly).toBe(false);
      await reconcileSchedulePreferences(prefs.all(), ctx);
      expect(ctx.scheduler.read(NIGHTLY_ID)).toBeNull();
    });
  });
});
