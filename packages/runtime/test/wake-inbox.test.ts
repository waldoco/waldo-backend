import { env } from 'cloudflare:workers';
import { runInDurableObject } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import { inboxSection, wakeInboxBook } from '../src/channels/wake-inbox';

// GENERAL_WAKE: the one inbox of what came in since the last wake. One row per kind and code, counted, so a burst stays one line;
// a wake settles what it read, and a row that came again after it read stays for the next wake.
const T = Date.parse('2026-11-28T10:00:00Z');
const hhmm = (at: number) => new Date(at).toISOString().slice(11, 16);
describe('the wake inbox', () => {
  it('merges repeats into one counted row, settles what a wake read, and keeps what came again after it read', async () => {
    await runInDurableObject(env.TEST_STORAGE_DO.get(env.TEST_STORAGE_DO.idFromName('wake-inbox')), async (_instance, state) => {
      const inbox = wakeInboxBook(state.storage.sql);
      expect(inbox.pending()).toEqual([]);
      inbox.add('place', 'place_moved', T);
      inbox.add('place', 'place_moved', T + 30_000);
      inbox.add('health', 'zone_change', T + 60_000);
      expect(inbox.pending()).toEqual([
        { kind: 'place', ref: 'place_moved', first_at: T, last_at: T + 30_000, count: 2 },
        { kind: 'health', ref: 'zone_change', first_at: T + 60_000, last_at: T + 60_000, count: 1 },
      ]);
      const readAt = T + 90_000;
      inbox.add('health', 'zone_change', T + 120_000);
      inbox.settle(readAt);
      expect(inbox.pending()).toEqual([{ kind: 'health', ref: 'zone_change', first_at: T + 60_000, last_at: T + 120_000, count: 2 }]);
    });
  });

  it('a wake reads each event in words, with how often and when, and never a reading', () => {
    const section = inboxSection([
      { kind: 'health', ref: 'sleep_debt_building', first_at: T, last_at: T, count: 1 },
      { kind: 'place', ref: 'arrived_gym', first_at: T, last_at: T + 60_000, count: 3 },
      { kind: 'changes', ref: 'mail_calendar', first_at: T, last_at: T, count: 1 },
      { kind: 'app_open', ref: 'app', first_at: T, last_at: T, count: 1 },
    ], hhmm);
    expect(section.split('\n')).toHaveLength(5);
    expect(section).toContain('3 times, last 10:01');
    expect(section.replace(/\d{2}:\d{2}|\d+ times/g, '')).not.toMatch(/\d/);
    expect(inboxSection([], hhmm)).toBe('');
  });
});
