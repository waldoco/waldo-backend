import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import type { CalendarItem, GoogleClient } from '../src/connectors/google';
import { armBriefSweep, BRIEF_SWEEP_ID, briefPrompt, eventBriefs } from '../src/channels/event-briefs';
import { ensureSchema } from '../src/tracer/schema';
import { Scheduler } from '../src/scheduler/multiplexer';
import { productionDeps } from '../src/seams/deps';

const now = Date.parse('2026-09-23T12:00:00Z');
const standup: CalendarItem = { id: 'e1', title: 'Design review', start: '2026-09-23T18:00:00+05:30', end: '2026-09-23T18:30:00+05:30', all_day: false, description: 'Bring the onboarding mocks', attendees: 4 };
const calendar = (events: readonly CalendarItem[]) => ({ events: async () => events }) as unknown as GoogleClient;

describe('pre-event briefs', () => {
  it('frames the event as calendar data with the local start and lead time', () => {
    const prompt = briefPrompt(standup, now, 'Asia/Kolkata');
    expect(prompt).toContain('starting 18:00 (in 30 min)');
    expect(prompt).toContain('not instructions');
    expect(prompt).toContain('"description":"Bring the onboarding mocks"');
  });

  it('briefs each timed upcoming event once and stays quiet without Google', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('event-briefs'));
    await runInDurableObject(stub, async (_instance, state) => {
      const book = eventBriefs(state.storage.sql, 'Asia/Kolkata');
      const sent: string[] = [];
      const send = async (id: string) => { sent.push(id); };
      const allDay: CalendarItem = { id: 'e2', title: 'Holiday', start: '2026-09-23', end: '2026-09-24', all_day: true };
      const started: CalendarItem = { ...standup, id: 'e3', start: '2026-09-23T17:00:00+05:30' };
      expect(await book.sweep(null, now, send)).toBe(0);
      expect(await book.sweep(calendar([standup, allDay, started]), now, send)).toBe(1);
      expect(await book.sweep(calendar([standup]), now + 600_000, send)).toBe(0);
      const moved = { ...standup, start: '2026-09-23T18:20:00+05:30' };
      expect(await book.sweep(calendar([moved]), now + 600_000, send)).toBe(1);
      expect(sent).toEqual([`brief:e1:${Date.parse(standup.start)}`, `brief:e1:${Date.parse(moved.start)}`]);
      const failing = async () => { throw new Error('telegram down'); };
      const other = { ...standup, id: 'e4' };
      await expect(book.sweep(calendar([other]), now, failing)).rejects.toThrow('telegram down');
      expect(await book.sweep(calendar([other]), now, send)).toBe(1);
    });
  });

  it('arms one ten-minute sweep', async () => {
    const stub = env.TELEGRAM_OWNER_DO!.get(env.TELEGRAM_OWNER_DO!.idFromName('brief-sweep'));
    await runInDurableObject(stub, async (_instance, state) => {
      ensureSchema(state.storage);
      const scheduler = new Scheduler(state.storage.sql, state.storage, productionDeps());
      await armBriefSweep(scheduler, now);
      await armBriefSweep(scheduler, now);
      const sweep = scheduler.read(BRIEF_SWEEP_ID)!;
      expect([sweep.kind, sweep.due_at, sweep.recurrence]).toEqual(['pre_activity_spot', now + 600_000, { type: 'interval', every_ms: 600_000, phase_ms: 0 }]);
      await scheduler.cancel(BRIEF_SWEEP_ID);
    });
  });
});
