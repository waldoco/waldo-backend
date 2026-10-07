import { manualAlarmStorage } from './helpers/manual-alarm-storage';
import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { SCHEDULE_KINDS } from '@waldo/contracts';
import { applySchedulePreferences, schedulePreferenceHandlers, schedulePreferences, schedulePreferencesLine } from '../src/channels/schedule-preferences';
import { dayPlanBook } from '../src/channels/day-cards';
import { loopBook } from '../src/channels/loops';
import { HEARTBEAT_ID } from '../src/channels/heartbeat';
import { NIGHTLY_ID } from '../src/channels/episodes';
import { BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { DAY_CARDS } from '../src/prompt/day-cards';
import { Scheduler } from '../src/scheduler/multiplexer';
import { ensureSchema } from '../src/tracer/schema';
import type { Deps } from '../src/seams/deps';

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
