import { env, runInDurableObject } from 'cloudflare:test';
import { expect, it } from 'vitest';
import { OwnerDO } from '../src/channels/owner-do';
import { armBriefSweep, BRIEF_SWEEP_ID } from '../src/channels/event-briefs';
import { calendarPushBook } from '../src/channels/calendar-push';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';
import { ensureSchema } from '../src/tracer/schema';

const push = (number: number, state = 'exists', channel = 'chan-1') => new Request('https://owner/google-push', { method: 'POST', headers: { 'x-waldo-gcal-channel': channel, 'x-waldo-gcal-state': state, 'x-waldo-gcal-number': String(number) } });

it('a verified push pulls the owner\'s update sweep forward once; redeliveries, sync and old channels do not', async () => {
  const stub = env.OWNER_DO!.get(env.OWNER_DO!.idFromName('owner-calendar-push'));
  await runInDurableObject(stub, async (_instance, state) => {
    ensureSchema(state.storage);
    const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
    const start = Date.now();
    await armBriefSweep(scheduler, start);
    const due = () => scheduler.read(BRIEF_SWEEP_ID)!.due_at;
    expect(due()).toBeGreaterThan(start + 5 * 60_000);
    calendarPushBook(state.storage.kv).record({ channelId: 'chan-1', resourceId: 'res-1', expiration: start + 7 * 86_400_000 }, 'conn');
    const owner = new OwnerDO(state, env);
    try {
      expect((await owner.fetch(push(1, 'sync'))).status).toBe(200);
      expect(due()).toBeGreaterThan(start + 5 * 60_000);
      expect((await owner.fetch(push(2, 'exists', 'chan-old'))).status).toBe(200);
      expect(due()).toBeGreaterThan(start + 5 * 60_000);
      expect((await owner.fetch(push(2))).status).toBe(200);
      const pulled = due();
      expect(pulled).toBeLessThanOrEqual(Date.now());
      await scheduler.schedule({ id: BRIEF_SWEEP_ID, kind: 'pre_activity_spot', payloadRefs: { id: BRIEF_SWEEP_ID }, occurrenceAt: start + 600_000, dueAt: start + 600_000, recurrence: { type: 'interval', every_ms: 600_000, phase_ms: 0 } });
      expect((await owner.fetch(push(2))).status).toBe(200);
      expect(due()).toBe(start + 600_000);
    } finally { await state.storage.deleteAlarm(); }
  });
});
