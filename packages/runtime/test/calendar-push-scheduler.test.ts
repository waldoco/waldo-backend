import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { wakeBriefSweep } from '../src/channels/calendar-push';
import { armBriefSweep, BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { Scheduler } from '../src/scheduler/multiplexer';
import { ensureSchema } from '../src/tracer/schema';

// The push pull-forward against the real scheduler: it moves only the next run, never the sweep's last run,
// retry count or quarantine, so the gap after a run holds however many pushes arrive.
const T = Date.parse('2026-10-13T10:00:00Z');
let sequence = 0;
const withSweep = <R>(work: (scheduler: Scheduler, clock: { now: number }) => Promise<R>) =>
  runInDurableObject(env.OWNER_DO!.get(env.OWNER_DO!.idFromName(`calendar-push-scheduler-${sequence++}`)), async (_instance, state) => {
    ensureSchema(state.storage);
    const clock = { now: T - 10 * 60_000 };
    const scheduler = new Scheduler(state.storage.sql, state.storage, { now: () => clock.now } as never);
    await armBriefSweep(scheduler, clock.now);
    try { return await work(scheduler, clock); } finally { await state.storage.deleteAlarm(); }
  });
const sweep = (scheduler: Scheduler) => scheduler.read(BRIEF_SWEEP_ID)!;

it('keeps the 60 s gap after the last run however many pushes arrive', async () => {
  await withSweep(async (scheduler, clock) => {
    clock.now = T;
    expect((await scheduler.dispatchDue({ pre_activity_spot: async () => undefined })).map((entry) => entry.id)).toEqual([BRIEF_SWEEP_ID]);
    expect(sweep(scheduler).last_fired_at).toBe(T);
    clock.now = T + 1_000;
    expect(await wakeBriefSweep(scheduler, clock.now)).toBe(true);
    clock.now = T + 2_000;
    expect(await wakeBriefSweep(scheduler, clock.now)).toBe(false);
    expect(sweep(scheduler)).toMatchObject({ due_at: T + 60_000, last_fired_at: T, attempts: 0, status: 'armed' });
  });
});

it('leaves a failing sweep to its own retry: attempts, backoff and quarantine stay as the scheduler set them', async () => {
  await withSweep(async (scheduler, clock) => {
    clock.now = T;
    await scheduler.dispatchDue({ pre_activity_spot: async () => { throw new Error('synthetic sweep failure'); } });
    const retrying = sweep(scheduler);
    expect(retrying.attempts).toBe(1);
    clock.now = T + 5_000;
    expect(await wakeBriefSweep(scheduler, clock.now)).toBe(false);
    expect(sweep(scheduler)).toEqual(retrying);
    for (let attempt = 2; attempt <= 5 && sweep(scheduler).status === 'armed'; attempt += 1) {
      clock.now = sweep(scheduler).due_at;
      await scheduler.dispatchDue({ pre_activity_spot: async () => { throw new Error('synthetic sweep failure'); } });
    }
    const quarantined = sweep(scheduler);
    expect(quarantined.status).toBe('quarantined');
    clock.now += 1_000;
    expect(await wakeBriefSweep(scheduler, clock.now)).toBe(false);
    expect(sweep(scheduler)).toEqual(quarantined);
  });
});
